import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeInputModifiers } from './input-modifiers.mjs';

const execFileAsync = promisify(execFile);
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const supportedActions = new Set(['click', 'doubleClick', 'scroll', 'drag', 'typeText', 'pressKey']);
const safeKeys = new Set([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Home', 'End', 'PageUp', 'PageDown',
  'Ctrl+Z', 'Ctrl+A'
]);
const displayFrameTolerancePx = 16;

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

function normalizeTrajectory(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError('trajectory must be an array.');
  if (value.length > 500) throw new TypeError('trajectory is too long.');
  return value.map((point, index) => normalizePoint(point, `trajectory[${index}]`));
}

function normalizeExecutionSurface(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('executionSurface must be an object.');
  if (typeof value.id !== 'string' || !value.id) throw new TypeError('executionSurface.id is required.');
  if (!['shared', 'isolated'].includes(value.mode)) throw new TypeError('executionSurface.mode must be shared or isolated.');
  return { id: value.id, mode: value.mode };
}

function normalizeInputLease(value, surface) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('inputLease is required for shared input.');
  if (typeof value.leaseId !== 'string' || !value.leaseId) throw new TypeError('inputLease.leaseId is required.');
  if (value.surfaceId !== surface.id) throw new TypeError('inputLease must match executionSurface.id.');
  if (!['string', 'number'].includes(typeof value.userActivitySequence)) throw new TypeError('inputLease.userActivitySequence is required.');
  const issuedAtMs = finiteNumber(value.issuedAtMs, 'inputLease.issuedAtMs');
  const expiresAtMs = finiteNumber(value.expiresAtMs, 'inputLease.expiresAtMs');
  if (expiresAtMs <= issuedAtMs) throw new TypeError('inputLease expiration must be after issuance.');
  const lastInputTick = finiteNumber(value.lastInputTick, 'inputLease.lastInputTick');
  const focusedWindowHandle = finiteNumber(value.focusedWindowHandle, 'inputLease.focusedWindowHandle');
  return {
    leaseId: value.leaseId,
    surfaceId: value.surfaceId,
    userActivitySequence: value.userActivitySequence,
    issuedAtMs,
    expiresAtMs,
    lastInputTick,
    cursor: normalizePoint(value.cursor, 'inputLease.cursor'),
    focusedWindowHandle
  };
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
    const modifiers = normalizeInputModifiers(input.modifiers);
    const trajectory = normalizeTrajectory(input.trajectory);
    return {
      ...common,
      from: normalizePoint(input.from, 'from'),
      to: normalizePoint(input.to, 'to'),
      durationMs: Math.min(Math.max(finiteNumber(input.durationMs ?? 350, 'durationMs'), 50), 5_000),
      button: input.button === 'right' ? 'right' : 'left',
      ...(modifiers.length > 0 ? { modifiers } : {}),
      ...(trajectory.length > 0 ? { trajectory } : {})
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
    normalized.textMode = input.textMode === 'insert' ? 'insert' : 'replace';
  } else {
    normalized.button = input.button === 'right' ? 'right' : 'left';
  }
  return normalized;
}

function fitPointToAllowedBounds(point, allowedBounds, label = 'point') {
  const minX = Math.ceil(Number(allowedBounds.x));
  const minY = Math.ceil(Number(allowedBounds.y));
  const maxX = Math.floor(Number(allowedBounds.x) + Number(allowedBounds.width) - 1);
  const maxY = Math.floor(Number(allowedBounds.y) + Number(allowedBounds.height) - 1);
  const x = Number(point.x);
  const y = Number(point.y);
  const outsideBy = Math.max(minX - x, x - maxX, minY - y, y - maxY, 0);
  if (outsideBy > displayFrameTolerancePx) {
    // allowedBounds is the AI display intersected with the selected application's window, so
    // naming the display alone sent the error packet and the self-improvement search after the
    // wrong cause when the point was on the AI display but outside the application.
    const area = `${minX},${minY} to ${maxX},${maxY}`;
    const error = new RangeError(
      `JavaScript pointer validation: ${label} (${x},${y}) is outside the allowed action area ${area} on the AI display.`
    );
    error.code = 'pointer_outside_ai_display';
    error.details = {
      stage: 'javascript-boundary-fit', label, point: { x, y }, allowedBounds, outsideBy,
      allowedArea: { minX, minY, maxX, maxY }
    };
    throw error;
  }
  return {
    point: {
      x: Math.min(maxX, Math.max(minX, x)),
      y: Math.min(maxY, Math.max(minY, y))
    },
    adjusted: outsideBy > 0
  };
}

export function fitPointerActionToAllowedBounds(action, allowedBounds) {
  const fitted = { ...action };
  let boundaryAdjusted = false;
  const fit = (point, label) => {
    const result = fitPointToAllowedBounds(point, allowedBounds, label);
    boundaryAdjusted ||= result.adjusted;
    return result.point;
  };
  if (action.action === 'drag') {
    fitted.from = fit(action.from, 'from');
    fitted.to = fit(action.to, 'to');
    if (Array.isArray(action.trajectory)) fitted.trajectory = action.trajectory.map((point, index) => fit(point, `trajectory[${index}]`));
  } else if (action.point) {
    fitted.point = fit(action.point, 'point');
  }
  return { action: fitted, boundaryAdjusted };
}

export function createBoundedPointerRequest({ action, allowedBounds, forbiddenProcessNames, executionSurface, inputLease }) {
  if (!allowedBounds || !Number.isFinite(allowedBounds.x) || !Number.isFinite(allowedBounds.y) ||
      !Number.isFinite(allowedBounds.width) || !Number.isFinite(allowedBounds.height) ||
      allowedBounds.width <= 0 || allowedBounds.height <= 0) {
    throw new TypeError('allowedBounds are required.');
  }
  const normalizedAction = normalizePointerAction(action);
  const fitted = fitPointerActionToAllowedBounds(normalizedAction, allowedBounds);
  const surface = executionSurface == null ? null : normalizeExecutionSurface(executionSurface);
  const lease = surface?.mode === 'shared' ? normalizeInputLease(inputLease, surface) : null;
  const normalized = {
    ...fitted.action,
    allowedBounds,
    forbiddenProcessNames: [...forbiddenProcessNames],
    boundaryAdjusted: fitted.boundaryAdjusted,
    ...(surface ? { executionSurface: surface } : {}),
    ...(lease ? { inputLease: lease } : {})
  };
  return normalized;
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
    error.details = result.details || { stage: 'powershell-pointer-bridge' };
    throw error;
  }
  return result;
}
