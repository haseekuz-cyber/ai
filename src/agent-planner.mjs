const supportedActions = new Set(['click', 'doubleClick', 'scroll', 'drag', 'typeText', 'wait', 'done']);
const riskLevels = new Set(['read_only', 'local_change', 'external_effect', 'dangerous']);

export const PLANNER_SYSTEM_PROMPT = `You are the local visual planner for a Windows AI employee.
Look only at the supplied screenshot and propose exactly one next UI action toward the user's instruction.
Do not claim that the action has already happened. Return JSON only, without markdown fences:
{
  "observation":"short Russian description of the current visible state",
  "action":{
    "type":"click|doubleClick|scroll|drag|typeText|wait|done",
    "point":{"x":0.0,"y":0.0},
    "from":{"x":0.0,"y":0.0},
    "to":{"x":0.0,"y":0.0},
    "delta":-120,
    "durationMs":350,
    "text":"text to enter",
    "targetHint":{"automationId":"optional","name":"optional","controlType":"optional","visibleText":"optional"}
  },
  "reason":"why this is the next action",
  "expectedResult":"visible result expected after the action",
  "risk":{"level":"read_only|local_change|external_effect|dangerous","reason":"short explanation"},
  "confidence":0.0
}
Coordinates are normalized to the screenshot from 0 to 1. Include only fields needed by the chosen action.
For click/doubleClick actions, ALWAYS include targetHint with automationId, name, or visibleText to identify the target. controlType may be added as a constraint, but controlType alone is not an identity.
Use done when the instruction is visibly complete. Use wait only for a visible loading state.
Opening a chat, sending a message, publishing, purchasing, deleting, overwriting files, changing account/security settings, or confirming a dialog is external_effect or dangerous.
If a target is not clearly visible, return wait or done with low confidence instead of guessing.`;

export const VALIDATOR_SYSTEM_PROMPT = `You are the local visual validator for a Windows AI employee.
Inspect the screenshot after one UI action and decide whether the expected visible result happened.
Return JSON only:
{
  "success":true,
  "evidence":"short Russian description of visible evidence",
  "confidence":0.0,
  "nextStep":"short Russian next step or empty string",
  "limitations":["anything not verifiable from this frame"]
}
Do not invent hidden state and do not claim any further action was performed.`;

export const POINTER_REFINER_SYSTEM_PROMPT = `You refine a click target for a Windows AI employee.
The supplied image is an enlarged crop around a coarse point from a full-window screenshot.
Locate the exact center of the requested visible control. Return JSON only:
{
  "targetVisible":true,
  "point":{"x":0.0,"y":0.0},
  "confidence":0.0,
  "evidence":"short Russian description"
}
Coordinates are normalized to this cropped image from 0 to 1. If the requested control is not clearly visible, set targetVisible to false and omit point. Never choose a different control.`;

export const FOCUSED_VALIDATOR_SYSTEM_PROMPT = `You are a focused visual validator for a Windows AI employee.
The supplied image is an enlarged crop around the exact click point after the action.
Return JSON only, without markdown fences, using every field in this exact shape:
{
  "success":true,
  "evidence":"short Russian description of the direct visible evidence",
  "confidence":0.0,
  "nextStep":"",
  "limitations":[]
}
Mark success true only when this crop directly shows the requested local state, such as a selected, highlighted, toggled, expanded, or focused control. Always provide evidence and a confidence number from 0 to 1.
Do not infer remote effects elsewhere in the window and do not treat the mere presence of a control as proof that it changed.`;

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be a finite number.`);
  return number;
}

function normalizedPoint(value, label, screenshotBounds) {
  requireObject(value, label);
  const x = finite(value.x, `${label}.x`);
  const y = finite(value.y, `${label}.y`);
  if (x >= 0 && x <= 1 && y >= 0 && y <= 1) return { x, y };
  const width = Number(screenshotBounds?.width);
  const height = Number(screenshotBounds?.height);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 1 && height > 1 &&
      x >= 0 && x < width && y >= 0 && y < height) {
    return { x: x / (width - 1), y: y / (height - 1) };
  }
  throw new TypeError(`${label} must use normalized coordinates or pixels inside the screenshot.`);
}

export function normalizeAgentInstruction(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('instruction is required.');
  const instruction = value.trim();
  if (instruction.length > 4_000) throw new TypeError('instruction is too long.');
  return instruction;
}

export function normalizePlannerOutput(value, screenshotBounds = null) {
  requireObject(value, 'Planner output');
  const rawAction = requireObject(value.action, 'action');
  const type = String(rawAction.type || '');
  if (!supportedActions.has(type)) throw new TypeError(`Unsupported planned action: ${type}`);

  const action = { type };
  if (['click', 'doubleClick', 'scroll', 'typeText'].includes(type)) action.point = normalizedPoint(rawAction.point, 'action.point', screenshotBounds);
  if (type === 'drag') {
    action.from = normalizedPoint(rawAction.from, 'action.from', screenshotBounds);
    action.to = normalizedPoint(rawAction.to, 'action.to', screenshotBounds);
    action.durationMs = Math.min(Math.max(Math.round(finite(rawAction.durationMs ?? 350, 'action.durationMs')), 50), 5_000);
  }
  if (type === 'scroll') action.delta = Math.min(Math.max(Math.round(finite(rawAction.delta ?? -120, 'action.delta')), -1_200), 1_200);
  if (type === 'typeText') {
    if (typeof rawAction.text !== 'string' || rawAction.text.length === 0) throw new TypeError('action.text is required.');
    if (rawAction.text.length > 2_000) throw new TypeError('action.text is too long.');
    action.text = rawAction.text;
  }
  if (type === 'wait') action.durationMs = Math.min(Math.max(Math.round(finite(rawAction.durationMs ?? 750, 'action.durationMs')), 50), 5_000);

  if (['click', 'doubleClick'].includes(type)) {
    const rawHint = rawAction.targetHint;
    if (!rawHint || typeof rawHint !== 'object' || Array.isArray(rawHint)) {
      throw new TypeError('action.targetHint is required for click actions.');
    }
    const hintKeys = ['automationId', 'name', 'controlType', 'visibleText'];
    const validHint = {};
    for (const key of hintKeys) {
      if (typeof rawHint[key] === 'string' && rawHint[key].trim().length > 0) {
        validHint[key] = rawHint[key].trim();
      }
    }
    if (!['automationId', 'name', 'visibleText'].some((key) => validHint[key])) {
      throw new TypeError('action.targetHint requires automationId, name, or visibleText.');
    }
    action.targetHint = validHint;
  }

  const risk = value.risk && typeof value.risk === 'object' ? value.risk : {};
  const riskLevel = riskLevels.has(risk.level) ? risk.level : 'dangerous';
  return {
    observation: typeof value.observation === 'string' ? value.observation : '',
    action,
    reason: typeof value.reason === 'string' ? value.reason : '',
    expectedResult: typeof value.expectedResult === 'string' ? value.expectedResult : '',
    risk: { level: riskLevel, reason: typeof risk.reason === 'string' ? risk.reason : 'Risk was not classified.' },
    confidence: Math.min(Math.max(finite(value.confidence ?? 0, 'confidence'), 0), 1),
    requiresConfirmation: type !== 'done'
  };
}

export function toScreenPointerAction(action, bounds, windowHandle) {
  requireObject(bounds, 'bounds');
  const width = Math.round(finite(bounds.width, 'bounds.width'));
  const height = Math.round(finite(bounds.height, 'bounds.height'));
  if (width <= 0 || height <= 0) throw new TypeError('Window bounds are empty.');
  const convert = (point) => ({
    x: Math.round(finite(bounds.x, 'bounds.x') + point.x * Math.max(0, width - 1)),
    y: Math.round(finite(bounds.y, 'bounds.y') + point.y * Math.max(0, height - 1))
  });
  const common = { windowHandle, action: action.type, confirmed: true };
  if (action.type === 'drag') return { ...common, from: convert(action.from), to: convert(action.to), durationMs: action.durationMs };
  if (action.type === 'scroll') return { ...common, point: convert(action.point), delta: action.delta };
  if (action.type === 'typeText') return { ...common, point: convert(action.point), text: action.text };
  if (action.type === 'click' || action.type === 'doubleClick') return { ...common, point: convert(action.point), button: 'left' };
  return null;
}

export function normalizeValidatorOutput(value) {
  requireObject(value, 'Validator output');
  return {
    success: value.success === true,
    evidence: typeof value.evidence === 'string' ? value.evidence : '',
    confidence: Math.min(Math.max(finite(value.confidence ?? 0, 'confidence'), 0), 1),
    nextStep: typeof value.nextStep === 'string' ? value.nextStep : '',
    limitations: Array.isArray(value.limitations) ? value.limitations.filter((item) => typeof item === 'string').slice(0, 20) : []
  };
}

export function mergeFocusedValidation(primary, focused, minimumConfidence = 0.7) {
  if (primary?.success === true) return { validation: primary, source: 'full-window' };
  if (focused?.success === true && Number(focused.confidence) >= minimumConfidence) {
    return {
      validation: {
        ...focused,
        limitations: [
          ...(Array.isArray(focused.limitations) ? focused.limitations : []),
          'Подтверждено по увеличенной области выполненного клика.'
        ]
      },
      source: 'focused-click-region'
    };
  }
  return { validation: primary, source: 'full-window' };
}

export function normalizePointerRefinement(value, crop, fullImageBounds) {
  requireObject(value, 'Pointer refinement');
  const confidence = Math.min(Math.max(finite(value.confidence ?? 0, 'confidence'), 0), 1);
  const result = {
    targetVisible: value.targetVisible === true,
    point: null,
    confidence,
    evidence: typeof value.evidence === 'string' ? value.evidence : ''
  };
  if (!result.targetVisible) return result;

  const cropSource = requireObject(crop?.sourceBounds, 'crop.sourceBounds');
  const cropOutput = requireObject(crop?.outputBounds, 'crop.outputBounds');
  const fullWidth = finite(fullImageBounds?.width, 'fullImageBounds.width');
  const fullHeight = finite(fullImageBounds?.height, 'fullImageBounds.height');
  const local = normalizedPoint(value.point, 'point', cropOutput);
  const sourceX = finite(cropSource.x, 'crop.sourceBounds.x') + local.x * Math.max(0, finite(cropSource.width, 'crop.sourceBounds.width') - 1);
  const sourceY = finite(cropSource.y, 'crop.sourceBounds.y') + local.y * Math.max(0, finite(cropSource.height, 'crop.sourceBounds.height') - 1);
  result.point = {
    x: sourceX / Math.max(1, fullWidth - 1),
    y: sourceY / Math.max(1, fullHeight - 1)
  };
  return result;
}

function pointsNear(left, right, tolerance) {
  return Boolean(left && right) &&
    Math.abs(Number(left.x) - Number(right.x)) <= tolerance &&
    Math.abs(Number(left.y) - Number(right.y)) <= tolerance;
}

export function plannedActionsEquivalent(left, right, tolerance = 0.005) {
  if (!left || !right || left.type !== right.type) return false;
  if (left.type === 'click' || left.type === 'doubleClick') return pointsNear(left.point, right.point, tolerance);
  if (left.type === 'scroll') {
    return pointsNear(left.point, right.point, tolerance) && Number(left.delta) === Number(right.delta);
  }
  if (left.type === 'drag') {
    return pointsNear(left.from, right.from, tolerance) && pointsNear(left.to, right.to, tolerance);
  }
  if (left.type === 'typeText') {
    return pointsNear(left.point, right.point, tolerance) && String(left.text) === String(right.text);
  }
  return false;
}

export function findRepeatedFailedAction(action, history, tolerance = 0.005) {
  if (!Array.isArray(history)) return null;
  return history.findLast((item) =>
    item?.validation?.success === false && plannedActionsEquivalent(action, item.action, tolerance)
  ) ?? null;
}
