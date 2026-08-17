import assert from 'node:assert/strict';
import test from 'node:test';
import { cropImageRegion } from '../src/image-region.mjs';

test('image crop process failures are compact typed infrastructure errors', async () => {
  await assert.rejects(
    cropImageRegion({
      scriptPath: 'Z:\\missing\\crop-image-region.ps1',
      inputPath: 'Z:\\missing\\input.png',
      outputPath: 'Z:\\missing\\output.png',
      centerX: 10,
      centerY: 10
    }),
    (error) => {
      assert.equal(error.code, 'image_crop_failed');
      assert.equal(error.statusCode, 503);
      assert.match(error.message, /^Image crop failed:/);
      assert.ok(error.message.length < 800);
      return true;
    }
  );
});
