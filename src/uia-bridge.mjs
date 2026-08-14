import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const defaultTimeoutMs = 10_000;
const readOnlyTimeouts = Object.freeze({
  listWindows: 30_000,
  inspect: 30_000
});

export const forbiddenUiaProcesses = Object.freeze([
  'ChatGPT',
  'Codex',
  'cmd',
  'conhost',
  'OpenConsole',
  'powershell',
  'pwsh',
  'WindowsTerminal'
]);

export function resolveUiAutomationDisplay(diagnostics, configuredDeviceName) {
  const screens = diagnostics?.hardware?.screens ?? [];
  if (screens.length === 0) throw new Error('The current Windows session has no active display.');

  if (configuredDeviceName) {
    const matches = screens.filter((screen) => screen.deviceName === configuredDeviceName);
    if (matches.length !== 1) {
      throw new Error(`Configured AI display ${configuredDeviceName} is not uniquely visible.`);
    }
    return matches[0];
  }

  const secondaryScreens = screens.filter((screen) => !screen.primary);
  if (secondaryScreens.length === 1) return secondaryScreens[0];
  if (screens.length === 1) return screens[0];
  throw new Error('Select AI_WORKSTATION_DISPLAY because the session has multiple secondary displays.');
}

function normalizeRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('UI Automation request must be an object.');
  }
  return request;
}

export function resolveUiAutomationTimeoutMs(request, configuredTimeoutMs) {
  if (Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0) {
    return Math.round(configuredTimeoutMs);
  }
  return readOnlyTimeouts[String(request?.operation || '')] ?? defaultTimeoutMs;
}

function createBridgeProcessError(error, operation, timeoutMs) {
  const timedOut = error?.killed === true || error?.code === 'ETIMEDOUT' || error?.signal === 'SIGTERM';
  const stderr = String(error?.stderr || '').trim();
  const message = timedOut
    ? `UI Automation timed out after ${timeoutMs} ms while running ${operation}. Refresh the window list and try again.`
    : `UI Automation ${operation} failed: ${stderr || error?.message || 'unknown bridge error'}`;
  const bridgeError = new Error(message, { cause: error });
  bridgeError.code = timedOut ? 'uia_timeout' : 'uia_process_failed';
  return bridgeError;
}

export async function runUiAutomation(scriptPath, request, options = {}) {
  const normalized = normalizeRequest(request);
  const payload = Buffer.from(JSON.stringify(normalized), 'utf8').toString('base64');
  const timeoutMs = resolveUiAutomationTimeoutMs(normalized, options.timeoutMs);
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-RequestBase64', payload],
      {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: options.maxBuffer ?? 12 * 1024 * 1024
      }
    ));
  } catch (error) {
    throw createBridgeProcessError(error, normalized.operation || 'unknown operation', timeoutMs);
  }

  let result;
  try {
    result = JSON.parse(stdout.trim());
  } catch (error) {
    const bridgeError = new Error(`UI Automation ${normalized.operation || 'operation'} returned an invalid response.`, { cause: error });
    bridgeError.code = 'uia_invalid_response';
    throw bridgeError;
  }
  if (!result.ok) {
    const error = new Error(result.message || 'UI Automation bridge failed.');
    error.code = result.error || 'uia_bridge_error';
    throw error;
  }
  return result;
}

export function createBoundedUiRequest({ diagnostics, configuredDeviceName, request }) {
  const display = resolveUiAutomationDisplay(diagnostics, configuredDeviceName);
  return {
    ...normalizeRequest(request),
    allowedBounds: display.bounds,
    forbiddenProcessNames: forbiddenUiaProcesses
  };
}
