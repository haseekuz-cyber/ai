import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be a finite number.`);
  return number;
}

export function normalizeTeachingText(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required.`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new TypeError(`${label} is too long.`);
  return normalized;
}

export function normalizePointToWindow(point, bounds) {
  const width = finite(bounds?.width, 'bounds.width');
  const height = finite(bounds?.height, 'bounds.height');
  if (width <= 0 || height <= 0) throw new TypeError('Window bounds are empty.');
  return {
    x: Math.min(1, Math.max(0, (finite(point?.x, 'point.x') - finite(bounds.x, 'bounds.x')) / width)),
    y: Math.min(1, Math.max(0, (finite(point?.y, 'point.y') - finite(bounds.y, 'bounds.y')) / height))
  };
}

function contains(bounds, x, y) {
  return bounds && !bounds.empty && bounds.width > 0 && bounds.height > 0 &&
    x >= bounds.x && y >= bounds.y && x < bounds.x + bounds.width && y < bounds.y + bounds.height;
}

function stableSelector(element) {
  if (!element) return null;
  if (element.automationId) return { automationId: element.automationId, controlType: element.controlType };
  if (element.name) return { name: element.name, controlType: element.controlType };
  if (element.className) return { className: element.className, controlType: element.controlType };
  return null;
}

function smallestElementAt(elements, x, y, { includePassword = false } = {}) {
  return [...elements]
    .filter((element) => !element.offscreen && element.enabled !== false && (includePassword || !element.isPassword) && contains(element.bounds, x, y))
    .sort((left, right) => left.bounds.width * left.bounds.height - right.bounds.width * right.bounds.height)[0] ?? null;
}

export function pointerActionToTeachingEvent({ action, elements = [], atMs = 0 }) {
  if (!action || !['click', 'doubleClick', 'scroll', 'drag', 'typeText', 'pressKey'].includes(action.action)) return null;
  const point = action.action === 'drag' ? action.from : action.point;
  const hasPoint = Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y));
  const target = hasPoint
    ? smallestElementAt(elements, Number(point.x), Number(point.y), { includePassword: true })
    : null;
  const event = {
    type: action.action,
    atMs: Math.max(0, Math.round(Number(atMs) || 0)),
    source: 'direct-window-demonstration'
  };
  if (hasPoint) {
    event.x = Number(point.x);
    event.y = Number(point.y);
  }
  if (target) {
    event.automationId = target.automationId;
    event.name = target.name;
    event.controlType = target.controlType;
    event.className = target.className;
  }
  if (action.action === 'click' || action.action === 'doubleClick') event.button = action.button === 'right' ? 'right' : 'left';
  if (action.action === 'scroll') event.delta = action.delta;
  if (action.action === 'drag') {
    event.toX = Number(action.to?.x);
    event.toY = Number(action.to?.y);
    event.durationMs = action.durationMs;
    event.button = action.button === 'right' ? 'right' : 'left';
  }
  if (action.action === 'pressKey') event.key = action.key;
  if (action.action === 'typeText') {
    event.sensitive = !target || target.isPassword === true;
    event.text = event.sensitive ? null : String(action.text ?? '');
  }
  return event;
}

function collapseRecordedEvents(events) {
  const collapsed = [];
  for (const event of [...events].sort((left, right) => Number(left.atMs) - Number(right.atMs))) {
    const previous = collapsed.at(-1);
    if (event.type === 'typeText' && previous?.type === 'typeText' &&
        previous.automationId === event.automationId && previous.name === event.name) {
      collapsed[collapsed.length - 1] = event;
      continue;
    }
    if (event.type === 'click' && previous?.type === 'click' && event.button === previous.button &&
        Number(event.atMs) - Number(previous.atMs) <= 500 &&
        Math.hypot(Number(event.x) - Number(previous.x), Number(event.y) - Number(previous.y)) <= 6) {
      if (event.source && previous.source && event.source !== previous.source &&
          Number(event.atMs) - Number(previous.atMs) <= 150) {
        collapsed[collapsed.length - 1] = event.source === 'uia-event' ? event : previous;
        continue;
      }
      collapsed[collapsed.length - 1] = { ...event, type: 'doubleClick', atMs: previous.atMs };
      continue;
    }
    collapsed.push(event);
  }
  return collapsed;
}

export function buildSkillFromRecording({ skillId, name, instruction, window, recording, elements = [] }) {
  const warnings = [...(recording?.warnings ?? [])];
  const steps = [];
  for (const event of collapseRecordedEvents(recording?.events ?? [])) {
    if (event.sensitive) {
      warnings.push('A password-field change was redacted and not added to the skill.');
      continue;
    }
    if (!['click', 'doubleClick', 'scroll', 'drag', 'typeText', 'pressKey'].includes(event.type)) continue;
    const target = Number.isFinite(Number(event.x)) && Number.isFinite(Number(event.y))
      ? smallestElementAt(elements, Number(event.x), Number(event.y))
      : null;
    const step = {
      index: steps.length,
      type: event.type,
      atMs: Math.max(0, Math.round(Number(event.atMs) || 0)),
      target: stableSelector(event) || stableSelector(target),
      requiresConfirmation: true
    };
    if (['click', 'doubleClick', 'scroll', 'typeText', 'pressKey'].includes(event.type) &&
        Number.isFinite(Number(event.x)) && Number.isFinite(Number(event.y))) {
      step.point = normalizePointToWindow({ x: event.x, y: event.y }, window.bounds);
    }
    if (event.type === 'click' || event.type === 'doubleClick') step.button = event.button === 'right' ? 'right' : 'left';
    if (event.type === 'scroll') step.delta = Math.min(Math.max(Math.round(Number(event.delta) || 0), -1_200), 1_200);
    if (event.type === 'drag') {
      step.from = normalizePointToWindow({ x: event.x, y: event.y }, window.bounds);
      step.to = normalizePointToWindow({ x: event.toX, y: event.toY }, window.bounds);
      step.durationMs = Math.min(Math.max(Math.round(Number(event.durationMs) || 350), 50), 5_000);
      step.button = event.button === 'right' ? 'right' : 'left';
    }
    if (event.type === 'typeText') {
      if (typeof event.text !== 'string') {
        warnings.push('A text change could not be read through UI Automation and was skipped.');
        continue;
      }
      step.text = event.text;
    }
    if (event.type === 'pressKey') step.key = String(event.key || '');
    steps.push(step);
  }
  if (steps.length === 0) throw new Error('No reusable actions were recorded inside the selected window.');

  return {
    schemaVersion: 1,
    skillId,
    name: normalizeTeachingText(name, 'name', 128),
    instruction: normalizeTeachingText(instruction, 'instruction', 4_000),
    createdAt: new Date().toISOString(),
    source: 'live-demonstration',
    application: {
      processName: window.processName,
      className: window.className,
      titleAtRecording: window.name,
      recordedBounds: window.bounds
    },
    safety: {
      defaultRequiresConfirmation: true,
      passwordValuesStored: false
    },
    steps,
    warnings: [...new Set(warnings)]
  };
}

export async function startTeachingRecorder({ scriptPath, recorderConfig }) {
  const payload = Buffer.from(JSON.stringify(recorderConfig), 'utf8').toString('base64');
  const child = spawn(
    powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-ConfigBase64', payload],
    { windowsHide: true, stdio: 'ignore' }
  );
  child.unref();
  return { processId: child.pid, child };
}

export async function waitForFile(filePath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return false;
}
