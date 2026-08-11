import { spawn } from 'node:child_process';
import path from 'node:path';

const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

export function normalizeSafetyHotkeyConfig(input) {
  const url = new URL(input?.pauseUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
    throw new TypeError('Safety hotkey may call only a local worker endpoint.');
  }
  if (typeof input.authToken !== 'string' || !input.authToken) throw new TypeError('authToken is required.');
  if (!Number.isInteger(input.parentProcessId) || input.parentProcessId <= 0) throw new TypeError('parentProcessId is invalid.');
  if (typeof input.readyPath !== 'string' || !path.isAbsolute(input.readyPath)) throw new TypeError('readyPath must be absolute.');
  return {
    pauseUrl: url.toString(),
    authToken: input.authToken,
    parentProcessId: input.parentProcessId,
    readyPath: path.resolve(input.readyPath)
  };
}

export function startSafetyHotkey({ scriptPath, ...input }) {
  const config = normalizeSafetyHotkeyConfig(input);
  const payload = Buffer.from(JSON.stringify(config), 'utf8').toString('base64');
  const child = spawn(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath, '-ConfigBase64', payload
  ], { windowsHide: true, stdio: 'ignore' });
  child.unref();
  return { processId: child.pid, child };
}
