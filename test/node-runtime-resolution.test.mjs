import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const resolverPath = fileURLToPath(new URL('../scripts/resolve-node.ps1', import.meta.url));

async function runResolver(script) {
  const { stdout } = await execFileAsync(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `$ErrorActionPreference = 'Stop'; . '${resolverPath}'; ${script}`
  ]);
  return stdout.trim();
}

for (const scriptName of ['start-controller.ps1', 'start-worker.ps1']) {
  test(`${scriptName} resolves Node through the shared version-checked resolver`, async () => {
    const source = await fs.readFile(new URL(`../scripts/${scriptName}`, import.meta.url), 'utf8');
    assert.match(source, /\.\s+\(Join-Path \$PSScriptRoot 'resolve-node\.ps1'\)/);
    assert.match(source, /Resolve-NodeExecutable -ProjectRoot \$projectRoot/);
    // The old resolution took the first candidate that merely existed.
    assert.doesNotMatch(source, /Test-Path -LiteralPath \$packagedNode/);
  });
}

test('the required major version comes from package.json engines', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const expected = Number(manifest.engines.node.match(/(\d+)/)[1]);
  const reported = await runResolver(`Get-RequiredNodeMajor -ProjectRoot '${projectRoot}'`);
  assert.equal(Number(reported), expected);
});

test('a resolved runtime satisfies the declared engine requirement', async () => {
  const required = Number(await runResolver(`Get-RequiredNodeMajor -ProjectRoot '${projectRoot}'`));
  const resolved = await runResolver(`Resolve-NodeExecutable -ProjectRoot '${projectRoot}'`);
  const major = Number(await runResolver(`Get-NodeMajorVersion -Path '${resolved}'`));
  assert.ok(major >= required, `${resolved} reported v${major}, below the required v${required}`);
});

test('a candidate that is not a usable Node runtime is skipped rather than fatal', async () => {
  const major = await runResolver("Get-NodeMajorVersion -Path 'D:\\does-not-exist\\node.exe'");
  assert.equal(Number(major), 0);
});

test('resolution fails loudly when no candidate meets the requirement', async () => {
  // engines.node is raised above every installed runtime, so every candidate is rejected.
  const emptyRoot = fileURLToPath(new URL('../artifacts/test-node-resolution/', import.meta.url));
  await fs.mkdir(emptyRoot, { recursive: true });
  await fs.writeFile(`${emptyRoot}package.json`, JSON.stringify({ engines: { node: '>=999' } }), 'utf8');

  await assert.rejects(
    () => runResolver(`Resolve-NodeExecutable -ProjectRoot '${emptyRoot}'`),
    (error) => {
      const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
      assert.match(output, /Node\.js 999 or newer is required/);
      return true;
    }
  );

  await fs.rm(emptyRoot, { recursive: true, force: true });
});
