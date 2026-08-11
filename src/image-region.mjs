import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

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
  const { stdout } = await execFileAsync(
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
  );
  return JSON.parse(stdout.trim());
}

