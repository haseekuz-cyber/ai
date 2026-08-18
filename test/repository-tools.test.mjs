import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createRepositoryTools, repositoryToolDefinitions } from '../src/repository-tools.mjs';

const execFileAsync = promisify(execFile);

test('repo search reads the real call path and never escapes project root', async (context) => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-repo-'));
  context.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(fixtureRoot, 'public'), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(fixtureRoot, 'public', 'app.js'), [
    'const before = true;',
    'function sendTeacherMessage() {}',
    'const after = true;'
  ].join('\n'), 'utf8');
  const tools = createRepositoryTools({ projectRoot: fixtureRoot });
  const result = await tools.search({ query: 'sendTeacherMessage', paths: ['public', 'src'], contextLines: 1 });
  assert.equal(result.matches[0].path, 'public/app.js');
  assert.equal(result.matches[0].line, 2);
  assert.deepEqual(result.matches[0].lines.map((line) => line.text), [
    'const before = true;',
    'function sendTeacherMessage() {}',
    'const after = true;'
  ]);
  assert.match(result.matches[0].fileHash, /^[0-9a-f]{64}$/);
  await assert.rejects(() => tools.read({ path: '../secret.txt', startLine: 1, endLine: 2 }), /outside project root/);
});

test('repo index excludes artifacts, model files and runtime binaries', async (context) => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-index-'));
  context.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(fixtureRoot, 'src'), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, 'artifacts'), { recursive: true });
  await fs.writeFile(path.join(fixtureRoot, 'src', 'worker.mjs'), 'export const ok = true;\n');
  await fs.writeFile(path.join(fixtureRoot, 'artifacts', 'secret.json'), '{}\n');
  await fs.writeFile(path.join(fixtureRoot, 'model.gguf'), 'model');
  await fs.writeFile(path.join(fixtureRoot, 'tool.exe'), 'binary');
  const result = await createRepositoryTools({ projectRoot: fixtureRoot }).index({ paths: ['.'] });
  assert.deepEqual(result.files.map((file) => file.path), ['src/worker.mjs']);
  assert.match(result.files[0].fileHash, /^[0-9a-f]{64}$/);
});

test('repo index keeps hidden project files but never ignored user data', async (context) => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-ignore-'));
  context.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
  await execFileAsync('git', ['init', '--quiet'], { cwd: fixtureRoot });
  await fs.mkdir(path.join(fixtureRoot, 'src'), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, 'screenshots'), { recursive: true });
  await fs.writeFile(path.join(fixtureRoot, '.gitignore'), '.env\n*.jsonl\nscreenshots/\n', 'utf8');
  await fs.writeFile(path.join(fixtureRoot, 'src', 'worker.mjs'), 'export const ok = true;\n');
  await fs.writeFile(path.join(fixtureRoot, '.env'), 'LMSTUDIO_TOKEN=secret\n');
  await fs.writeFile(path.join(fixtureRoot, 'experience.jsonl'), '{"episode":1}\n');
  await fs.writeFile(path.join(fixtureRoot, 'screenshots', 'frame.png'), 'png');

  const tools = createRepositoryTools({ projectRoot: fixtureRoot });
  const index = await tools.index({ paths: ['.'] });
  assert.deepEqual(index.files.map((file) => file.path), ['.gitignore', 'src/worker.mjs']);

  const search = await tools.search({ query: 'LMSTUDIO_TOKEN' });
  assert.deepEqual(search.matches, []);
});

test('repo search reports every literal hit with a one-based byte column', async (context) => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-search-'));
  context.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(fixtureRoot, 'a.mjs'), 'const marker = 1;\nconst other = 2;\nlet marker2 = marker;\n', 'utf8');
  await fs.writeFile(path.join(fixtureRoot, 'b.bin'), Buffer.from([0x6d, 0x61, 0x72, 0x6b, 0x65, 0x72, 0x00, 0x01]));

  const result = await createRepositoryTools({ projectRoot: fixtureRoot }).search({ query: 'marker' });
  assert.deepEqual(result.matches.map((match) => [match.path, match.line, match.column]), [
    ['a.mjs', 1, 7],
    ['a.mjs', 3, 5]
  ]);
  assert.equal(result.truncated, false);
});

test('repo search truncates at the requested match limit', async (context) => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-limit-'));
  context.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(fixtureRoot, 'many.mjs'), 'hit\n'.repeat(10), 'utf8');
  const result = await createRepositoryTools({ projectRoot: fixtureRoot }).search({ query: 'hit', limit: 4 });
  assert.equal(result.matches.length, 4);
  assert.equal(result.truncated, true);
});

test('repository tool manifests expose only bounded read-only operations', () => {
  const definitions = repositoryToolDefinitions({ projectRoot: process.cwd() });
  assert.deepEqual(definitions.map((entry) => entry.manifest.name), [
    'repo.index', 'repo.search', 'repo.read', 'repo.diff'
  ]);
  assert.equal(definitions.every((entry) => entry.manifest.readOnly && entry.manifest.risk === 'read_only'), true);
});
