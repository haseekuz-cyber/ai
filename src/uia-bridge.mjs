import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

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

export async function runUiAutomation(scriptPath, request, options = {}) {
  const normalized = normalizeRequest(request);
  const payload = Buffer.from(JSON.stringify(normalized), 'utf8').toString('base64');
  const { stdout } = await execFileAsync(
    powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-RequestBase64', payload],
    {
      windowsHide: true,
      timeout: options.timeoutMs ?? 10_000,
      maxBuffer: options.maxBuffer ?? 12 * 1024 * 1024
    }
  );

  const result = JSON.parse(stdout.trim());
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
