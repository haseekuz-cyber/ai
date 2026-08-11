import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

export async function collectWindowsDiagnostics(scriptPath) {
  const { stdout } = await execFileAsync(
    powershell,
    ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
  );
  return JSON.parse(stdout);
}

