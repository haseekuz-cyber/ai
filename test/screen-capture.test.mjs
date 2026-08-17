import test from 'node:test';
import assert from 'node:assert/strict';
import { captureDisplay } from '../src/screen-capture.mjs';

test('display capture surfaces a typed compact infrastructure error', async () => {
  await assert.rejects(captureDisplay({
    scriptPath: 'Z:\\missing\\capture-display.ps1',
    deviceName: '\\\\.\\DISPLAY1',
    outputPath: 'Z:\\missing\\output.png'
  }), (error) => {
    assert.equal(error.code, 'display_capture_failed');
    assert.equal(error.statusCode, 503);
    assert.match(error.message, /^Display capture failed:/);
    assert.ok(error.message.length < 800);
    return true;
  });
});
