import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { normalizeInputModifiers } from './input-modifiers.mjs';
import { normalizeTrajectoryMode } from './trajectory.mjs';

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

export function classifyTrajectoryMode(event, target = null) {
  const explicit = String(event?.trajectoryMode || '');
  if (explicit) return normalizeTrajectoryMode(explicit);
  const controlType = String(event?.controlType || target?.controlType || '').toLocaleLowerCase();
  if (!target || ['pane', 'canvas', 'document'].includes(controlType)) return 'adaptive';
  return 'replaceable';
}

function recordedDragTrajectory(event, recordingEvents, bounds, maxPoints = 500) {
  const startedAt = Math.max(0, Number(event.atMs) || 0);
  const endedAt = startedAt + Math.max(0, Number(event.durationMs) || 0);
  const candidates = [
    { x: event.x, y: event.y },
    ...recordingEvents
      .filter((candidate) => candidate.type === 'pointerMove' && Number(candidate.atMs) >= startedAt && Number(candidate.atMs) <= endedAt)
      .map((candidate) => ({ x: candidate.x, y: candidate.y })),
    { x: event.toX, y: event.toY }
  ].filter((point) => Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)));
  const stride = Math.max(1, Math.ceil(candidates.length / maxPoints));
  const normalized = candidates
    .filter((_, index) => index % stride === 0 || index === candidates.length - 1)
    .map((point) => normalizePointToWindow(point, bounds));
  return normalized.filter((point, index) => index === 0 || point.x !== normalized[index - 1].x || point.y !== normalized[index - 1].y);
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

function expectedResultForEvent(event) {
  const descriptions = {
    click: 'The demonstrated target should visibly react or change state.',
    doubleClick: 'The demonstrated target should visibly open or change state.',
    scroll: 'The demonstrated content should visibly move in the requested direction.',
    drag: 'The dragged, resized, or drawn content should visibly change along the demonstrated gesture.',
    typeText: 'The demonstrated field should visibly contain the entered text.',
    pressKey: 'The demonstrated keyboard command should produce its visible local result.'
  };
  return descriptions[event.type] || 'The demonstrated action should produce a visible local result.';
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
    const modifiers = normalizeInputModifiers(action.modifiers);
    if (modifiers.length > 0) event.modifiers = modifiers;
    event.trajectoryMode = classifyTrajectoryMode(action, target);
  }
  if (action.action === 'pressKey') event.key = action.key;
  if (action.action === 'typeText') {
    event.sensitive = !target || target.isPassword === true;
    event.text = event.sensitive ? null : String(action.text ?? '');
  }
  return event;
}

export function collapseRecordedEvents(events) {
  const collapsed = [];
  const ordered = [...events].sort((left, right) => Number(left.atMs) - Number(right.atMs));
  const keyboardEvents = ordered.filter((event) => ['pressKey', 'keyPreview'].includes(event.type));
  const logicalEvents = ordered.filter((event) => {
    if (['pointerMove', 'keyPreview'].includes(event.type)) return false;
    if (event.type !== 'typeText' || event.source !== 'uia-event') return true;
    return keyboardEvents.some((keyEvent) => {
      const elapsed = Number(event.atMs) - Number(keyEvent.atMs);
      if (elapsed < 0 || elapsed > 1500) return false;
      if (event.automationId && keyEvent.automationId) return event.automationId === keyEvent.automationId;
      return true;
    });
  });
  for (const event of logicalEvents) {
    const previous = collapsed.at(-1);
    if (event.type === 'typeText' && previous?.type === 'typeText' &&
        ((event.automationId && previous.automationId && previous.automationId === event.automationId) ||
         (!event.automationId && !previous.automationId && previous.name === event.name))) {
      collapsed[collapsed.length - 1] = event.source === 'keyboard-hook' && previous.source === 'keyboard-hook'
        ? { ...event, atMs: previous.atMs, text: `${previous.text ?? ''}${event.text ?? ''}` }
        : event;
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

function normalizedVisualFrame(frame) {
  if (!frame || typeof frame.imagePath !== 'string' || !frame.imagePath.trim()) return null;
  return {
    imagePath: frame.imagePath,
    sha256: typeof frame.sha256 === 'string' ? frame.sha256 : null,
    capturedAt: typeof frame.capturedAt === 'string' ? frame.capturedAt : null,
    atMs: Number.isFinite(Number(frame.atMs)) ? Math.max(0, Math.round(Number(frame.atMs))) : null,
    throughSequence: Number.isFinite(Number(frame.throughSequence)) ? Number(frame.throughSequence) : null
  };
}

function visualFrameAfterEvent(event, frames) {
  const sequence = Number(event?.sequence);
  if (Number.isFinite(sequence) && sequence > 0) {
    const bySequence = frames.find((frame) => Number(frame?.throughSequence) >= sequence);
    if (bySequence) return normalizedVisualFrame(bySequence);
  }
  const eventEndedAt = Number(event?.atMs || 0) + (event?.type === 'drag' ? Number(event?.durationMs || 0) : 0);
  return normalizedVisualFrame(frames.find((frame) => Number(frame?.atMs) >= eventEndedAt));
}

export function summarizeDemonstration(recording, bounds, maxTrajectoryPoints = 500) {
  const pointerEvents = (recording?.events ?? []).filter((event) =>
    ['pointerMove', 'click', 'doubleClick', 'drag', 'scroll'].includes(event.type) &&
    Number.isFinite(Number(event.x)) && Number.isFinite(Number(event.y))
  );
  const stride = Math.max(1, Math.ceil(pointerEvents.length / maxTrajectoryPoints));
  const trajectory = pointerEvents
    .filter((_, index) => index % stride === 0 || index === pointerEvents.length - 1)
    .map((event) => ({
      type: event.type,
      atMs: Math.max(0, Math.round(Number(event.atMs) || 0)),
      point: normalizePointToWindow({ x: event.x, y: event.y }, bounds),
      ...(event.type === 'drag' ? {
        to: normalizePointToWindow({ x: event.toX, y: event.toY }, bounds),
        modifiers: normalizeInputModifiers(event.modifiers),
        trajectoryMode: classifyTrajectoryMode(event)
      } : {})
    }));
  const keyboard = (recording?.events ?? [])
    .filter((event) => ['pressKey', 'keyPreview'].includes(event.type) && !event.sensitive && event.key)
    .slice(-300)
    .map((event) => ({
      type: event.type,
      atMs: Math.max(0, Math.round(Number(event.atMs) || 0)),
      key: String(event.key).slice(0, 40)
    }));
  return {
    eventCount: recording?.events?.length ?? 0,
    trajectory,
    keyboard,
    interpretationRule: 'The trajectory is evidence of intent. Adapt it to the current layout and use a shorter safe method when the exact path is not essential.'
  };
}

export function buildSkillFromRecording({ skillId, name, instruction, window, recording, elements = [] }) {
  const warnings = [...(recording?.warnings ?? [])];
  const steps = [];
  const logicalEvents = collapseRecordedEvents(recording?.events ?? []);
  const visualFrames = Array.isArray(recording?.visualFrames)
    ? [...recording.visualFrames].sort((left, right) => Number(left.atMs) - Number(right.atMs))
    : [];
  let previousVisualFrame = normalizedVisualFrame(recording?.initialVisualFrame);
  for (const event of logicalEvents) {
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
      expectedResult: expectedResultForEvent(event),
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
      const modifiers = normalizeInputModifiers(event.modifiers, { label: 'recording event modifiers' });
      if (modifiers.length > 0) step.modifiers = modifiers;
      step.trajectoryMode = classifyTrajectoryMode(event, target);
      step.trajectory = recordedDragTrajectory(event, recording?.events ?? [], window.bounds);
    }
    if (event.type === 'typeText') {
      if (typeof event.text !== 'string') {
        warnings.push('A text change could not be read through UI Automation and was skipped.');
        continue;
      }
      step.text = event.text;
    }
    if (event.type === 'pressKey') step.key = String(event.key || '');
    let afterVisualFrame = visualFrameAfterEvent(event, visualFrames);
    if (!afterVisualFrame && event === logicalEvents.at(-1)) {
      afterVisualFrame = normalizedVisualFrame(recording?.finalVisualFrame);
    }
    if (previousVisualFrame && afterVisualFrame) {
      step.visualEvidence = {
        schemaVersion: 1,
        beforeImagePath: previousVisualFrame.imagePath,
        afterImagePath: afterVisualFrame.imagePath,
        beforeSha256: previousVisualFrame.sha256,
        afterSha256: afterVisualFrame.sha256,
        capturedAtMs: afterVisualFrame.atMs,
        source: 'live-demonstration'
      };
    }
    if (afterVisualFrame) previousVisualFrame = afterVisualFrame;
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
    demonstration: summarizeDemonstration(recording, window.bounds),
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
