import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('PowerShell drag transport handles Alt and always releases mouse and modifiers', async () => {
  const source = await fs.readFile(new URL('../scripts/pointer-bridge.ps1', import.meta.url), 'utf8');
  assert.match(source, /0x0104/); // WM_SYSKEYDOWN
  assert.match(source, /0x0105/); // WM_SYSKEYUP
  assert.match(source, /\$modifierState = \$modifierState -bor 0x0008/); // MK_CONTROL
  assert.match(source, /\$modifierState = \$modifierState -bor 0x0004/); // MK_SHIFT
  assert.match(source, /finally\s*\{[\s\S]*if \(\$mouseDownSent\)[\s\S]*\$pressedModifiers\.Count - 1/);
});
