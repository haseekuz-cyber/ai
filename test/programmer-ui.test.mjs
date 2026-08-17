import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('programmer is a first-class workflow with latest-error handoff', async () => {
  const [html, app] = await Promise.all([
    fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8')
  ]);

  assert.match(html, /id="programmer-button"/);
  assert.match(html, /id="teacher-fix-last"/);
  assert.match(app, /\/api\/self-improvement\/errors\?limit=1/);
  assert.match(app, /latestErrorPrompt/);
  assert.match(app, /scrollIntoView/);
});
