import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

function uniqueMatches(source, pattern, groupName) {
  return [...new Set([...source.matchAll(pattern)].map((match) => match.groups[groupName]))].sort();
}

test('every API route used by the browser is implemented by the controller', async () => {
  const [browserSource, controllerSource] = await Promise.all([
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/controller.mjs', import.meta.url), 'utf8')
  ]);

  const browserRoutes = uniqueMatches(
    browserSource,
    /['"](?<route>\/api\/[A-Za-z0-9_?=&./-]+)['"]/g,
    'route'
  ).map((route) => route.split('?')[0]);
  const controllerRoutes = new Set(uniqueMatches(
    controllerSource,
    /url\.pathname === ['"](?<route>\/api\/[A-Za-z0-9_./-]+)['"]/g,
    'route'
  ));

  const missingRoutes = [...new Set(browserRoutes)].filter((route) => !controllerRoutes.has(route));
  assert.deepEqual(missingRoutes, [], `Browser API routes missing from controller: ${missingRoutes.join(', ')}`);
});

test('skill correction routes are forwarded to matching worker endpoints', async () => {
  const controllerSource = await fs.readFile(new URL('../src/controller.mjs', import.meta.url), 'utf8');
  const workerSource = await fs.readFile(new URL('../src/worker.mjs', import.meta.url), 'utf8');

  for (const route of ['/skills/apply-demonstrated-correction', '/skills/apply-plan-correction']) {
    assert.match(controllerSource, new RegExp(`callWorker\\(['"]${route.replaceAll('/', '\\/')}['"]`));
    assert.match(workerSource, new RegExp(`url\\.pathname === ['"]${route.replaceAll('/', '\\/')}['"]`));
  }
});
