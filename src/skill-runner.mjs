import { normalizeInputModifiers } from './input-modifiers.mjs';
import { trajectoryPolicy } from './trajectory.mjs';

const supportedStepTypes = new Set(['click', 'doubleClick', 'scroll', 'drag', 'typeText', 'pressKey']);

export function normalizeSkillId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError('skillId must be a UUID.');
  }
  return value.toLowerCase();
}

export function validateSkillForWindow(skill, window) {
  if (!skill || skill.schemaVersion !== 1 || !Array.isArray(skill.steps) || skill.steps.length === 0) {
    throw new TypeError('Skill format is invalid.');
  }
  if (skill.executionPolicy?.replayable === false) {
    throw new Error('This recording is semantic observation evidence, not a sequence that may be replayed blindly.');
  }
  if (String(skill.application?.processName).toLowerCase() !== String(window?.processName).toLowerCase()) {
    throw new Error(`This skill was recorded for ${skill.application?.processName || 'another application'}.`);
  }
  for (const step of skill.steps) {
    if (!supportedStepTypes.has(step.type)) throw new TypeError(`Unsupported learned step: ${step.type}`);
  }
  return true;
}

function screenPoint(point, bounds) {
  if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) {
    throw new TypeError('Learned point is invalid.');
  }
  const x = Math.min(1, Math.max(0, Number(point.x)));
  const y = Math.min(1, Math.max(0, Number(point.y)));
  return {
    x: Math.round(Number(bounds.x) + x * Math.max(0, Number(bounds.width) - 1)),
    y: Math.round(Number(bounds.y) + y * Math.max(0, Number(bounds.height) - 1))
  };
}

function usableElement(element, bounds) {
  const candidate = element?.bounds;
  if (!candidate || candidate.empty || element.offscreen || element.enabled === false || element.isPassword) return false;
  if (![candidate.x, candidate.y, candidate.width, candidate.height].every((value) => Number.isFinite(Number(value)))) return false;
  if (Number(candidate.width) <= 0 || Number(candidate.height) <= 0) return false;
  const centerX = Number(candidate.x) + Number(candidate.width) / 2;
  const centerY = Number(candidate.y) + Number(candidate.height) / 2;
  return centerX >= Number(bounds.x) && centerX < Number(bounds.x) + Number(bounds.width) &&
    centerY >= Number(bounds.y) && centerY < Number(bounds.y) + Number(bounds.height);
}

function selectorMatches(element, selector) {
  for (const key of ['runtimeId', 'automationId', 'name', 'className', 'controlType']) {
    if (selector?.[key] && String(element?.[key] ?? '') !== String(selector[key])) return false;
  }
  return true;
}

function normalizedCenter(element, bounds) {
  const divisorX = Math.max(1, Number(bounds.width) - 1);
  const divisorY = Math.max(1, Number(bounds.height) - 1);
  return {
    x: Math.min(1, Math.max(0, (Number(element.bounds.x) + Number(element.bounds.width) / 2 - Number(bounds.x)) / divisorX)),
    y: Math.min(1, Math.max(0, (Number(element.bounds.y) + Number(element.bounds.height) / 2 - Number(bounds.y)) / divisorY))
  };
}

export function groundLearnedStepToElements(step, elements = [], bounds) {
  if (!step?.target || !bounds) return { step, matched: false, reason: 'no_selector' };
  const matches = elements.filter((element) => usableElement(element, bounds) && selectorMatches(element, step.target));
  const ordinal = Number.isInteger(step.target.ordinal) ? step.target.ordinal : null;
  const element = ordinal === null ? (matches.length === 1 ? matches[0] : null) : matches[ordinal];
  if (!element) return { step, matched: false, reason: matches.length > 1 ? 'ambiguous_selector' : 'selector_not_found' };

  const point = normalizedCenter(element, bounds);
  const grounded = { ...step };
  if (['click', 'doubleClick', 'scroll', 'typeText', 'pressKey'].includes(step.type)) grounded.point = point;
  if (step.type === 'drag' && step.from && step.to) {
    const delta = { x: Number(step.to.x) - Number(step.from.x), y: Number(step.to.y) - Number(step.from.y) };
    grounded.from = point;
    grounded.to = {
      x: Math.min(1, Math.max(0, point.x + delta.x)),
      y: Math.min(1, Math.max(0, point.y + delta.y))
    };
  }
  return {
    step: grounded,
    matched: true,
    reason: 'unique_selector',
    element: {
      runtimeId: element.runtimeId,
      name: element.name,
      automationId: element.automationId,
      className: element.className,
      controlType: element.controlType,
      bounds: element.bounds
    }
  };
}

export function learnedStepToPointerAction(step, bounds, windowHandle) {
  if (!supportedStepTypes.has(step?.type)) throw new TypeError('Learned step is unsupported.');
  const common = { windowHandle, action: step.type, confirmed: true };
  if (step.type === 'click' || step.type === 'doubleClick') {
    return { ...common, point: screenPoint(step.point, bounds), button: step.button === 'right' ? 'right' : 'left' };
  }
  if (step.type === 'scroll') {
    return { ...common, point: screenPoint(step.point, bounds), delta: Math.min(Math.max(Math.round(Number(step.delta) || 0), -1_200), 1_200) };
  }
  if (step.type === 'drag') {
    const modifiers = normalizeInputModifiers(step.modifiers, { label: 'learned step modifiers' });
    const pathPolicy = trajectoryPolicy(step);
    const trajectory = pathPolicy.trajectory.map((point) => screenPoint(point, bounds));
    return {
      ...common,
      from: screenPoint(step.from, bounds),
      to: screenPoint(step.to, bounds),
      durationMs: Math.min(Math.max(Math.round(Number(step.durationMs) || 350), 50), 5_000),
      button: step.button === 'right' ? 'right' : 'left',
      ...(modifiers.length > 0 ? { modifiers } : {}),
      ...(trajectory.length > 0 ? { trajectory } : {})
    };
  }
  if (step.type === 'typeText') {
    return { ...common, point: screenPoint(step.point, bounds), text: String(step.text ?? '') };
  }
  if (step.type === 'pressKey') {
    return {
      ...common,
      key: String(step.key ?? ''),
      ...(step.point ? { point: screenPoint(step.point, bounds) } : {})
    };
  }
  return null;
}

export function publicLearnedStep(step) {
  return {
    index: step.index,
    type: step.type,
    target: step.target ?? null,
    point: step.point ?? null,
    from: step.from ?? null,
    to: step.to ?? null,
    delta: step.delta ?? null,
    durationMs: step.durationMs ?? null,
    button: step.button ?? null,
    modifiers: step.type === 'drag' ? normalizeInputModifiers(step.modifiers, { label: 'learned step modifiers' }) : [],
    trajectoryMode: step.type === 'drag' ? step.trajectoryMode ?? 'adaptive' : null,
    expectedResult: step.expectedResult ?? null,
    text: step.type === 'typeText' ? step.text : null,
    key: step.type === 'pressKey' ? step.key : null,
    requiresConfirmation: true
  };
}
