import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  extractPublicHttpsUrls,
  extractSearchResults,
  htmlToText,
  isPrivateAddress,
  saveLearningMaterial,
  validatePublicHttpsUrl,
  youtubeVideoId
} from '../src/teacher-research.mjs';

test('teacher internet blocks local/private addresses', async () => {
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('192.168.1.5'), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  await assert.rejects(validatePublicHttpsUrl('http://example.com'), /HTTPS/);
  await assert.rejects(validatePublicHttpsUrl('https://127.0.0.1/private'), /Private/);
});

test('teacher recognizes public lesson links and YouTube video ids', () => {
  assert.deepEqual(extractPublicHttpsUrls('Урок https://youtu.be/abc123?t=4 и https://example.com/docs.'), [
    'https://youtu.be/abc123?t=4',
    'https://example.com/docs'
  ]);
  assert.equal(youtubeVideoId('https://youtu.be/abc123?t=4'), 'abc123');
  assert.equal(youtubeVideoId('https://www.youtube.com/watch?v=xyz789'), 'xyz789');
  assert.equal(youtubeVideoId('https://example.com/watch?v=no'), null);
});

test('learning materials are stored separately and deduplicated by URL', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-materials-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'materials.jsonl');
  const material = { sourceType: 'web', title: 'Lesson', url: 'https://example.com/lesson', excerpt: 'Useful' };
  const first = await saveLearningMaterial(filePath, material);
  const second = await saveLearningMaterial(filePath, material);
  assert.equal(first.saved, true);
  assert.equal(second.saved, false);
  assert.equal((await fs.readFile(filePath, 'utf8')).trim().split(/\r?\n/).length, 1);
});

test('teacher internet extracts only HTTPS search results and strips active markup', () => {
  const html = '<a class="result__a" href="https://example.com/docs">Docs</a>' +
    '<a class="result__a" href="http://unsafe.test">Unsafe</a>';
  assert.deepEqual(extractSearchResults(html), [{ title: 'Docs', url: 'https://example.com/docs' }]);
  assert.equal(htmlToText('<script>bad()</script><p>Useful &amp; safe</p>'), 'Useful & safe');
});
