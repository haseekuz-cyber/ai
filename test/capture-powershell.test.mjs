import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

for (const scriptName of ['capture-display.ps1', 'capture-window.ps1', 'crop-image.ps1', 'crop-image-region.ps1']) {
  test(`${scriptName} hashes files without an auto-loaded PowerShell module`, async () => {
    const source = await fs.readFile(new URL(`../scripts/${scriptName}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /Get-FileHash/);
    assert.match(source, /System\.Security\.Cryptography\.SHA256/);
    assert.match(source, /System\.Text\.UTF8Encoding/);
  });
}
