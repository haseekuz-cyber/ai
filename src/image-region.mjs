import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function compactCropError(error) {
  const detail = String(error?.stderr || error?.message || 'unknown image crop error')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700);
  const wrapped = new Error(`Image crop failed: ${detail}`, { cause: error });
  wrapped.code = 'image_crop_failed';
  wrapped.statusCode = 503;
  return wrapped;
}

export async function cropImageRegion({
  scriptPath,
  inputPath,
  outputPath,
  centerX,
  centerY,
  width = 220,
  height = 220,
  scale = 3,
  timeoutMs = 30_000
}) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      powershell,
      [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        '-InputPath', inputPath,
        '-OutputPath', outputPath,
        '-CenterX', String(Math.round(centerX)),
        '-CenterY', String(Math.round(centerY)),
        '-Width', String(width),
        '-Height', String(height),
        '-Scale', String(scale)
      ],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 }
    ));
  } catch (error) {
    throw compactCropError(error);
  }
  try {
    return JSON.parse(stdout.trim());
  } catch (error) {
    throw compactCropError(new Error('crop-image-region.ps1 returned invalid JSON.', { cause: error }));
  }
}
