import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRepositoryTools, repositoryToolDefinitions } from '../src/repository-tools.mjs';

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

test('repository tool manifests expose only bounded read-only operations', () => {
  const definitions = repositoryToolDefinitions({ projectRoot: process.cwd() });
  assert.deepEqual(definitions.map((entry) => entry.manifest.name), [
    'repo.index', 'repo.search', 'repo.read', 'repo.diff'
  ]);
  assert.equal(definitions.every((entry) => entry.manifest.readOnly && entry.manifest.risk === 'read_only'), true);
});
