import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

export async function detectTelegramBadges({ scriptPath, imagePath, timeoutMs = 30_000 }) {
  const { stdout } = await execFileAsync(
    powershell,
    ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-InputPath', imagePath],
    { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 }
  );
  const result = JSON.parse(stdout);
  if (!Number.isInteger(result.count) || !Array.isArray(result.badges)) {
    throw new Error('Telegram badge detector returned an invalid result.');
  }
  return result;
}

