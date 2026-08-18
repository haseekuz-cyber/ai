import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function finiteInteger(value, field, { minimum = 0 } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new TypeError(`${field} must be a safe integer.`);
  return number;
}

export function normalizeWindowsUserActivity(value = {}) {
  const lastInputTick = finiteInteger(value.lastInputTick, 'lastInputTick');
  const cursor = {
    x: finiteInteger(value.cursor?.x, 'cursor.x', { minimum: Number.MIN_SAFE_INTEGER }),
    y: finiteInteger(value.cursor?.y, 'cursor.y', { minimum: Number.MIN_SAFE_INTEGER })
  };
  const focusedWindowHandle = finiteInteger(value.focusedWindowHandle, 'focusedWindowHandle');
  const material = `${lastInputTick}:${cursor.x}:${cursor.y}:${focusedWindowHandle}`;
  return {
    sequence: createHash('sha256').update(material, 'utf8').digest('hex'),
    lastInputTick,
    cursor,
    focusedWindowHandle
  };
}

export async function readWindowsUserActivity(scriptPath) {
  const resolvedScriptPath = scriptPath instanceof URL ? fileURLToPath(scriptPath) : String(scriptPath ?? '');
  if (!resolvedScriptPath) throw new TypeError('Windows user activity script path is required.');
  const { stdout } = await execFileAsync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', resolvedScriptPath
  ], { windowsHide: true, timeout: 2_000, maxBuffer: 256 * 1024 });
  return normalizeWindowsUserActivity(JSON.parse(stdout.trim()));
}
