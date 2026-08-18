import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const powershell = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const defaultsPath = fileURLToPath(new URL('../scripts/model-defaults.ps1', import.meta.url));

async function runDefaults(script) {
  const { stdout } = await execFileAsync(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `$ErrorActionPreference = 'Stop'; . '${defaultsPath}'; ${script}`
  ]);
  return stdout.trim();
}

for (const scriptName of ['start-all.ps1', 'start-controller.ps1', 'start-worker.ps1']) {
  test(`${scriptName} pins the local model through the shared defaults`, async () => {
    const source = await fs.readFile(new URL(`../scripts/${scriptName}`, import.meta.url), 'utf8');
    assert.match(source, /\.\s+\(Join-Path \$PSScriptRoot 'model-defaults\.ps1'\)/);
    assert.match(source, /Set-DefaultLocalModel/);
  });
}

test('start-all pins the model before the weights are loaded', async () => {
  // Setting it later would load one model into VRAM while the components ask
  // for another, which is the drift this shared default exists to prevent.
  const source = await fs.readFile(new URL('../scripts/start-all.ps1', import.meta.url), 'utf8');
  assert.ok(source.indexOf('Set-DefaultLocalModel') < source.indexOf('$modelLoad = Ensure-LmStudioModel'));
});

test('the pinned model is the GUI-grounding model', async () => {
  const model = await runDefaults('$env:AI_WORKSTATION_LM_STUDIO_MODEL = $null; Set-DefaultLocalModel');
  assert.equal(model, 'gui-owl-1.5-8b-instruct');
});

test('an externally supplied model still wins over the pinned default', async () => {
  const model = await runDefaults("$env:AI_WORKSTATION_LM_STUDIO_MODEL = 'someone/other-model'; Set-DefaultLocalModel");
  assert.equal(model, 'someone/other-model');
});

test('every model role the config derives resolves to the pinned model', async () => {
  // config.mjs reads AI_WORKSTATION_ACTIVE_MODEL || AI_WORKSTATION_LM_STUDIO_MODEL,
  // so pinning the launcher variable must reach vision, planner, critic and teacher.
  const source = await fs.readFile(new URL('../src/config.mjs', import.meta.url), 'utf8');
  assert.match(source, /process\.env\.AI_WORKSTATION_LM_STUDIO_MODEL/);
  for (const role of ['visionModel', 'plannerModel', 'criticModel', 'teacherModel', 'lmStudioModel']) {
    assert.match(source, new RegExp(`${role}: activeModel`));
  }
});
