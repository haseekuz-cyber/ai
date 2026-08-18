import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

test('PowerShell drag transport handles Alt and always releases mouse and modifiers', async () => {
  const source = await fs.readFile(new URL('../scripts/pointer-bridge.ps1', import.meta.url), 'utf8');
  assert.match(source, /0x0104/); // WM_SYSKEYDOWN
  assert.match(source, /0x0105/); // WM_SYSKEYUP
  assert.match(source, /\$modifierState = \$modifierState -bor 0x0008/); // MK_CONTROL
  assert.match(source, /\$modifierState = \$modifierState -bor 0x0004/); // MK_SHIFT
  assert.match(source, /\$request\.trajectory/);
  assert.match(source, /foreach \(\$point in \$pathPoints\)/);
  assert.match(source, /finally\s*\{[\s\S]*if \(\$mouseDownSent\)[\s\S]*\$pressedModifiers\.Count - 1/);
});

test('PowerShell drag validation does not turn a missing trajectory into a null point', async () => {
  const source = await fs.readFile(new URL('../scripts/pointer-bridge.ps1', import.meta.url), 'utf8');
  assert.match(source, /if \(\$null -ne \$request\.trajectory\)/);
  assert.match(source, /if \(\$null -ne \$trajectoryPoint\)/);
  assert.doesNotMatch(source, /@\(\$request\.from, \$request\.to\) \+ @\(\$request\.trajectory\)/);
  assert.match(source, /PowerShell pointer validation: \$\(\$entry\.label\)/);
});

test('PowerShell canvas text insert mode does not send Ctrl+A before typing', async () => {
  const script = await fs.readFile(new URL('../scripts/pointer-bridge.ps1', import.meta.url), 'utf8');
  assert.match(script, /request\.textMode -ne 'insert'/);
  assert.match(script, /Send-SafeKey \$inputHandle 'Ctrl\+A'/);
});

test('PowerShell pointer bridge accepts a modal window owned by the selected application', async () => {
  const source = await fs.readFile(new URL('../scripts/pointer-bridge.ps1', import.meta.url), 'utf8');
  assert.match(source, /Get-InputHandle \$handle \$processId \$inputPoint/);
  assert.match(source, /GetWindowThreadProcessId\(\$rootHandle, \[ref\]\$hitProcessId\)/);
  assert.match(source, /if \(\$hitProcessId -ne \$ExpectedProcessId\)/);
});

test('PowerShell bridge rejects an expired lease before touching a target window', async () => {
  const scriptPath = new URL('../scripts/pointer-bridge.ps1', import.meta.url);
  const request = {
    windowHandle: 1,
    action: 'pressKey',
    key: 'Escape',
    confirmed: true,
    allowedBounds: { x: 0, y: 0, width: 100, height: 100 },
    forbiddenProcessNames: [],
    executionSurface: { id: 'display-1', mode: 'shared' },
    inputLease: {
      leaseId: 'expired', surfaceId: 'display-1', userActivitySequence: 'old',
      issuedAtMs: 0, expiresAtMs: 1, lastInputTick: 0,
      cursor: { x: 0, y: 0 }, focusedWindowHandle: 0
    }
  };
  const payload = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
  const { stdout } = await execFileAsync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath.pathname.slice(1), '-RequestBase64', payload
  ], { windowsHide: true, timeout: 10_000 });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.ok, false);
  assert.equal(result.error, 'input_lease_expired');
});
