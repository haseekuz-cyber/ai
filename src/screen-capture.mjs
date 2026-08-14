import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function compactCaptureError(error) {
  const detail = String(error?.stderr || error?.message || 'unknown capture error')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700);
  const wrapped = new Error(`Display capture failed: ${detail}`, { cause: error });
  wrapped.code = 'display_capture_failed';
  wrapped.statusCode = 503;
  return wrapped;
}

export async function captureDisplay({ scriptPath, deviceName, outputPath }) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-DeviceName',
        deviceName,
        '-OutputPath',
        outputPath
      ],
      { windowsHide: true, maxBuffer: 1024 * 1024 }
    ));
  } catch (error) {
    throw compactCaptureError(error);
  }

  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw compactCaptureError(new Error('capture-display.ps1 returned invalid JSON.', { cause: error }));
  }
}
