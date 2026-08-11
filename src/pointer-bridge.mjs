import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const supportedActions = new Set(['click', 'doubleClick', 'scroll', 'drag', 'typeText', 'pressKey']);
const safeKeys = new Set([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Home', 'End', 'PageUp', 'PageDown',
  'Ctrl+Z', 'Ctrl+A'
]);

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be a finite number.`);
  return Math.round(number);
}

function normalizePoint(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return { x: finiteNumber(value.x, `${label}.x`), y: finiteNumber(value.y, `${label}.y`) };
}

export function normalizePointerAction(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Pointer action must be an object.');
  }
  if (!Number.isInteger(input.windowHandle) || input.windowHandle <= 0) {
    throw new TypeError('windowHandle must be a positive integer.');
  }
  if (!supportedActions.has(input.action)) throw new TypeError('Unsupported pointer action.');
  if (input.confirmed !== true) throw new TypeError('confirmed=true is required for a pointer action.');

  const common = {
    windowHandle: input.windowHandle,
    action: input.action,
    confirmed: true
  };
  if (input.action === 'drag') {
    return {
      ...common,
      from: normalizePoint(input.from, 'from'),
      to: normalizePoint(input.to, 'to'),
      durationMs: Math.min(Math.max(finiteNumber(input.durationMs ?? 350, 'durationMs'), 50), 5_000),
      button: input.button === 'right' ? 'right' : 'left'
    };
  }

  if (input.action === 'pressKey') {
    if (!safeKeys.has(input.key)) throw new TypeError('Only a safe non-modifier key is allowed.');
    return {
      ...common,
      key: input.key,
      ...(input.point == null ? {} : { point: normalizePoint(input.point, 'point') })
    };
  }

  const normalized = { ...common, point: normalizePoint(input.point, 'point') };
  if (input.action === 'scroll') {
    normalized.delta = Math.min(Math.max(finiteNumber(input.delta, 'delta'), -1_200), 1_200);
  } else if (input.action === 'typeText') {
    if (typeof input.text !== 'string' || input.text.length === 0) throw new TypeError('text is required.');
    if (input.text.length > 2_000) throw new TypeError('text is too long.');
    normalized.text = input.text;
  } else {
    normalized.button = input.button === 'right' ? 'right' : 'left';
  }
  return normalized;
}

export function createBoundedPointerRequest({ action, allowedBounds, forbiddenProcessNames }) {
  if (!allowedBounds || !Number.isFinite(allowedBounds.x) || !Number.isFinite(allowedBounds.y) ||
      !Number.isFinite(allowedBounds.width) || !Number.isFinite(allowedBounds.height)) {
    throw new TypeError('allowedBounds are required.');
  }
  return {
    ...normalizePointerAction(action),
    allowedBounds,
    forbiddenProcessNames: [...forbiddenProcessNames]
  };
}

export async function runPointerAction(scriptPath, request, options = {}) {
  const payload = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
  const { stdout } = await execFileAsync(
    powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-RequestBase64', payload],
    { windowsHide: true, timeout: options.timeoutMs ?? 10_000, maxBuffer: 2 * 1024 * 1024 }
  );
  const result = JSON.parse(stdout.trim());
  if (!result.ok) {
    const error = new Error(result.message || 'Pointer bridge failed.');
    error.code = result.error || 'pointer_bridge_error';
    throw error;
  }
  return result;
}
