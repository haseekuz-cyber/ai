import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_EXCLUDES = Object.freeze([
  '.git/**',
  'node_modules/**',
  'runtime/**',
  'artifacts/**',
  '**/__pycache__/**',
  '*.gguf',
  '*.safetensors',
  '*.onnx',
  '*.bin',
  '*.exe',
  '*.dll',
  '*.pyc'
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function posixPath(value) {
  return value.split(path.sep).join('/');
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolveExistingInside(root, requested, label = 'path') {
  if (typeof requested !== 'string' || !requested.trim()) throw new TypeError(`${label} is required.`);
  const absolute = path.resolve(root, requested);
  if (!inside(root, absolute)) throw new TypeError(`${label} is outside project root.`);
  const real = await fs.realpath(absolute);
  if (!inside(root, real)) throw new TypeError(`${label} is outside project root.`);
  return { absolute: real, relative: posixPath(path.relative(root, real)) || '.' };
}

function boundedInteger(value, fallback, { minimum, maximum, name }) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return number;
}

function globSource(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      const afterSeparator = index === 0 || pattern[index - 1] === '/';
      if (afterSeparator && pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
        continue;
      }
      source += '.*';
      index += 1;
      continue;
    }
    if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else source += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return source;
}

function createExcludeMatcher(patterns) {
  const wholePath = [];
  const baseName = [];
  const directories = [];
  for (const pattern of patterns) {
    const expression = new RegExp(`^${globSource(pattern)}$`);
    if (pattern.includes('/')) wholePath.push(expression);
    else baseName.push(expression);
    if (pattern.endsWith('/**')) directories.push(new RegExp(`^${globSource(pattern.slice(0, -3))}$`));
  }
  return {
    file(relativePath) {
      const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);
      return wholePath.some((expression) => expression.test(relativePath))
        || baseName.some((expression) => expression.test(name));
    },
    directory(relativePath) {
      return directories.some((expression) => expression.test(relativePath));
    }
  };
}

export function createRepositoryTools({
  projectRoot,
  excludes = DEFAULT_EXCLUDES,
  maxFiles = 2_000,
  maxMatches = 200,
  maxFileBytes = 5 * 1024 * 1024
} = {}) {
  if (typeof projectRoot !== 'string' || !projectRoot) throw new TypeError('projectRoot is required.');
  const root = path.resolve(projectRoot);
  const exclude = createExcludeMatcher(excludes);

  async function requestedPaths(paths = ['.']) {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 32) {
      throw new TypeError('paths must contain one to 32 project paths.');
    }
    const resolved = [];
    for (const requested of paths) resolved.push((await resolveExistingInside(root, requested)).relative);
    return [...new Set(resolved)];
  }

  async function readFile(relativePath) {
    const resolved = await resolveExistingInside(root, relativePath, 'path');
    const stat = await fs.stat(resolved.absolute);
    if (!stat.isFile()) throw new TypeError('path must identify a file.');
    if (stat.size > maxFileBytes) throw new TypeError('file exceeds the repository read limit.');
    const buffer = await fs.readFile(resolved.absolute);
    return { ...resolved, stat, buffer, text: buffer.toString('utf8'), fileHash: sha256(buffer) };
  }

  async function trackedFiles(safePaths) {
    const result = await execFileAsync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...safePaths],
      { cwd: root, windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }
    );
    return String(result.stdout || '').split('\0').filter(Boolean).map(posixPath);
  }

  async function walkDirectory(relativeDirectory, collected) {
    const entries = await fs.readdir(path.join(root, relativeDirectory || '.'), { withFileTypes: true });
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!exclude.directory(relative)) await walkDirectory(relative, collected);
        continue;
      }
      if (entry.isFile()) collected.push(relative);
    }
  }

  async function walkedFiles(safePaths) {
    const collected = [];
    for (const requested of safePaths) {
      const relative = requested === '.' ? '' : requested;
      const stat = await fs.stat(path.join(root, relative || '.'));
      if (stat.isDirectory()) await walkDirectory(relative, collected);
      else if (stat.isFile() && relative) collected.push(relative);
    }
    return collected;
  }

  async function projectFiles(safePaths) {
    let listed = null;
    try {
      listed = await trackedFiles(safePaths);
    } catch {
      listed = null;
    }
    if (!listed) listed = await walkedFiles(safePaths);
    const candidates = [...new Set(listed)].filter((name) => !exclude.file(name)).sort();
    const files = [];
    for (const name of candidates) {
      const stat = await fs.stat(path.join(root, name)).catch(() => null);
      if (stat && stat.isFile() && stat.size <= maxFileBytes) files.push(name);
    }
    return files;
  }

  return Object.freeze({
    async index({ paths = ['.'], limit = maxFiles } = {}) {
      const safePaths = await requestedPaths(paths);
      const safeLimit = boundedInteger(limit, maxFiles, { minimum: 1, maximum: maxFiles, name: 'limit' });
      const allNames = await projectFiles(safePaths);
      const names = allNames.slice(0, safeLimit);
      const files = [];
      for (const name of names) {
        const file = await readFile(name);
        files.push({ path: file.relative, size: file.stat.size, fileHash: file.fileHash });
      }
      return { files, truncated: allNames.length > safeLimit, limit: safeLimit };
    },

    async search({ query, paths = ['.'], contextLines = 0, limit = maxMatches } = {}) {
      if (typeof query !== 'string' || !query.trim()) throw new TypeError('query is required.');
      if (query.length > 500) throw new TypeError('query exceeds the repository search limit.');
      const safePaths = await requestedPaths(paths);
      const context = boundedInteger(contextLines, 0, { minimum: 0, maximum: 20, name: 'contextLines' });
      const safeLimit = boundedInteger(limit, maxMatches, { minimum: 1, maximum: maxMatches, name: 'limit' });
      const names = await projectFiles(safePaths);
      const matches = [];
      let truncated = false;
      for (const name of names) {
        if (truncated) break;
        const file = await readFile(name);
        if (file.buffer.includes(0)) continue;
        const allLines = file.text.split(/\r?\n/);
        for (let index = 0; index < allLines.length; index += 1) {
          const column = allLines[index].indexOf(query);
          if (column < 0) continue;
          if (matches.length >= safeLimit) {
            truncated = true;
            break;
          }
          const line = index + 1;
          const startLine = Math.max(1, line - context);
          const endLine = Math.min(allLines.length, line + context);
          matches.push({
            path: file.relative,
            line,
            column: Buffer.byteLength(allLines[index].slice(0, column)) + 1,
            text: allLines[index],
            startLine,
            endLine,
            lines: allLines.slice(startLine - 1, endLine).map((text, offset) => ({ line: startLine + offset, text })),
            fileHash: file.fileHash
          });
        }
      }
      return { matches, truncated, limit: safeLimit };
    },

    async read({ path: relativePath, startLine = 1, endLine = startLine + 199 } = {}) {
      const start = boundedInteger(startLine, 1, { minimum: 1, maximum: 10_000_000, name: 'startLine' });
      const end = boundedInteger(endLine, start + 199, { minimum: start, maximum: start + 399, name: 'endLine' });
      const file = await readFile(relativePath);
      const allLines = file.text.split(/\r?\n/);
      const actualEnd = Math.min(end, allLines.length);
      return {
        path: file.relative,
        startLine: start,
        endLine: actualEnd,
        totalLines: allLines.length,
        fileHash: file.fileHash,
        lines: start > allLines.length
          ? []
          : allLines.slice(start - 1, actualEnd).map((text, index) => ({ line: start + index, text }))
      };
    },

    async diff({ paths = ['.'], contextLines = 3, maxBytes = 256 * 1024 } = {}) {
      const safePaths = await requestedPaths(paths);
      const context = boundedInteger(contextLines, 3, { minimum: 0, maximum: 20, name: 'contextLines' });
      const byteLimit = boundedInteger(maxBytes, 256 * 1024, { minimum: 1_024, maximum: 1024 * 1024, name: 'maxBytes' });
      const result = await execFileAsync('git', ['diff', '--no-ext-diff', `--unified=${context}`, '--', ...safePaths], {
        cwd: root,
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: byteLimit + 1
      });
      const output = String(result.stdout || '');
      return { diff: output.slice(0, byteLimit), truncated: Buffer.byteLength(output) > byteLimit };
    }
  });
}

export function repositoryToolDefinitions(options = {}) {
  const tools = createRepositoryTools(options);
  const manifests = [
    {
      name: 'repo.index', risk: 'read_only', readOnly: true, idempotency: 'retryable',
      inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } }, limit: { type: 'integer' } }, additionalProperties: false }
    },
    {
      name: 'repo.search', risk: 'read_only', readOnly: true, idempotency: 'retryable',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } }, contextLines: { type: 'integer' }, limit: { type: 'integer' } }, required: ['query'], additionalProperties: false }
    },
    {
      name: 'repo.read', risk: 'read_only', readOnly: true, idempotency: 'retryable',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' } }, required: ['path', 'startLine', 'endLine'], additionalProperties: false }
    },
    {
      name: 'repo.diff', risk: 'read_only', readOnly: true, idempotency: 'retryable',
      inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } }, contextLines: { type: 'integer' }, maxBytes: { type: 'integer' } }, additionalProperties: false }
    }
  ];
  return manifests.map((manifest) => ({ manifest, handler: tools[manifest.name.split('.')[1]].bind(tools) }));
}

export function registerRepositoryTools(registry, options = {}) {
  if (!registry || typeof registry.register !== 'function') throw new TypeError('ToolRegistry is required.');
  for (const definition of repositoryToolDefinitions(options)) {
    registry.register(definition.manifest, definition.handler);
  }
  return registry;
}
