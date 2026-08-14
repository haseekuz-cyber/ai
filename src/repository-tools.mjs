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

async function rg({ executable, root, args, allowNoMatches = false }) {
  try {
    const result = await execFileAsync(executable, args, {
      cwd: root,
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024
    });
    return String(result.stdout || '');
  } catch (error) {
    if (allowNoMatches && error.code === 1) return '';
    throw error;
  }
}

function exclusionArgs(excludes) {
  return excludes.flatMap((pattern) => ['--glob', `!${pattern}`]);
}

export function createRepositoryTools({
  projectRoot,
  rgExecutable = 'rg',
  excludes = DEFAULT_EXCLUDES,
  maxFiles = 2_000,
  maxMatches = 200,
  maxFileBytes = 5 * 1024 * 1024
} = {}) {
  if (typeof projectRoot !== 'string' || !projectRoot) throw new TypeError('projectRoot is required.');
  const root = path.resolve(projectRoot);

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

  return Object.freeze({
    async index({ paths = ['.'], limit = maxFiles } = {}) {
      const safePaths = await requestedPaths(paths);
      const safeLimit = boundedInteger(limit, maxFiles, { minimum: 1, maximum: maxFiles, name: 'limit' });
      const output = await rg({
        executable: rgExecutable,
        root,
        args: ['--files', '--hidden', ...exclusionArgs(excludes), '--', ...safePaths],
        allowNoMatches: true
      });
      const allNames = [...new Set(output.split(/\r?\n/).filter(Boolean).map(posixPath))].sort();
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
      const output = await rg({
        executable: rgExecutable,
        root,
        args: [
          '--line-number', '--column', '--no-heading', '--color', 'never', '--fixed-strings',
          '--hidden', ...exclusionArgs(excludes), '--', query, ...safePaths
        ],
        allowNoMatches: true
      });
      const rawMatches = [];
      for (const line of output.split(/\r?\n/)) {
        const match = line.match(/^(.*?):(\d+):(\d+):(.*)$/);
        if (!match) continue;
        rawMatches.push({ path: posixPath(match[1]), line: Number(match[2]), column: Number(match[3]), text: match[4] });
        if (rawMatches.length >= safeLimit) break;
      }
      const cache = new Map();
      const matches = [];
      for (const match of rawMatches) {
        let file = cache.get(match.path);
        if (!file) {
          file = await readFile(match.path);
          cache.set(match.path, file);
        }
        const allLines = file.text.split(/\r?\n/);
        const startLine = Math.max(1, match.line - context);
        const endLine = Math.min(allLines.length, match.line + context);
        matches.push({
          path: file.relative,
          line: match.line,
          column: match.column,
          text: match.text,
          startLine,
          endLine,
          lines: allLines.slice(startLine - 1, endLine).map((text, index) => ({ line: startLine + index, text })),
          fileHash: file.fileHash
        });
      }
      return { matches, truncated: rawMatches.length >= safeLimit, limit: safeLimit };
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
