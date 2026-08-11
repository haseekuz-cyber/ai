import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

export async function captureWindow({ scriptPath, windowHandle, outputPath, timeoutMs = 30_000 }) {
  if (!Number.isInteger(windowHandle) || windowHandle <= 0) {
    throw new TypeError('windowHandle must be a positive integer.');
  }

  const { stdout } = await execFileAsync(
    powershell,
    [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-WindowHandle',
      String(windowHandle),
      '-OutputPath',
      outputPath
    ],
    { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 }
  );

  return JSON.parse(stdout);
}

