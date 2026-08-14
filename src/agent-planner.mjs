import { normalizeInputModifiers } from './input-modifiers.mjs';

const supportedActions = new Set(['click', 'doubleClick', 'scroll', 'drag', 'typeText', 'wait', 'done']);
const riskLevels = new Set(['read_only', 'local_change', 'external_effect', 'dangerous']);

export const PLANNER_SYSTEM_PROMPT = `You are the local interface planner for a universal Windows AI employee.
Use the supplied fresh screenshot together with any structured accessibility map and propose the next UI action toward the user's instruction. You may also propose up to two immediately following deterministic actions as a guarded mini-plan.
Do not claim that the action has already happened. Return JSON only, without markdown fences:
{
  "observation":"short Russian description of the current visible state",
  "action":{
    "type":"click|doubleClick|scroll|drag|typeText|wait|done",
    "point":{"x":0.0,"y":0.0},
    "from":{"x":0.0,"y":0.0},
    "to":{"x":0.0,"y":0.0},
    "modifiers":["Control"],
    "delta":-120,
    "durationMs":350,
    "text":"text to enter",
    "textMode":"replace|insert",
    "targetHint":{"automationId":"optional","name":"optional","controlType":"optional","visibleText":"optional"}
  },
  "reason":"why this is the next action",
  "expectedResult":"visible result expected after the action",
  "risk":{"level":"read_only|local_change|external_effect|dangerous","reason":"short explanation"},
  "confidence":0.0,
  "precondition":"visible state required before this action",
  "checkpoint":"deterministic|visual",
  "nextActions":[
    {
      "action":{"type":"click|doubleClick|typeText","point":{"x":0.0,"y":0.0},"text":"optional","textMode":"replace|insert","targetHint":{"automationId":"optional","name":"optional","controlType":"optional","visibleText":"optional"}},
      "reason":"why this follows",
      "expectedResult":"visible result expected after this action",
      "risk":{"level":"read_only|local_change","reason":"short explanation"},
      "confidence":0.0,
      "precondition":"visible prerequisite created by the previous step",
      "checkpoint":"deterministic"
    }
  ]
}
Coordinates are normalized to the screenshot from 0 to 1. Include only fields needed by the chosen action.
When several images are supplied, they are chronological keyframes of the same selected window and the final image is the fresh authoritative state. Use earlier frames to understand appearance, disappearance, motion, and progress. All coordinates and the next action must refer only to the final image.
nextActions is optional. Use it only for controls that are already visible in the same fresh screenshot, uniquely identifiable by targetHint, local, reversible, and safe to re-find after each preceding action. Never put drag, scroll, wait, done, external effects, dialogs, menus that replace the current view, or actions requiring visual interpretation into nextActions. End the mini-plan before any canvas gesture or visual checkpoint. Do not repeat the first action in nextActions.
For click/doubleClick actions, ALWAYS include targetHint with automationId, name, or visibleText to identify the target. controlType may be added as a constraint, but controlType alone is not an identity.
For typeText actions, include targetHint with the visible field name, role, or current visible value. The point must be inside that visible input field.
Exception for a custom drawing canvas: when a text tool is already active and a new text object must be created, use typeText with targetHint identifying the visible canvas/artboard/document page and textMode "insert". The executor will click the verified canvas point once and type without Ctrl+A. Never use this exception for an ordinary form field.
Use done when the instruction is visibly complete. Use wait only for a visible loading state.
Treat the fresh screenshot as the source of truth. A previous successful step may be repeated only when its visible result is no longer present and the state must be restored.
Before applying a property, command, color, transform, or edit to an object, verify that the required target object is visibly selected and the correct editing mode is active. If not, selecting or activating the prerequisite is the next step.
If a failed action opened a warning, dialog, tooltip, menu, or overlay that blocks the target, close or dismiss that visible obstruction first using its visible Close, Cancel, Back, or safe dismiss control. Never confirm a destructive dialog just to remove it.
Prefer a semantic target from the structured interface map when one exists. Use visual coordinates only for custom canvases or targets absent from that map. Never assume that two applications expose the same controls.
When a drawing or shape tool is active and the task requires creating or resizing something on a canvas, use drag with visible start and end points. Do not use click on an empty canvas as a substitute for a drawing gesture.
For drag, from and to must be visibly different points. When creating a shape, first create a visible non-zero shape; exact dimensions can be set in a later step through visible size fields.
For drag, include modifiers only when the user explicitly requires Control, Shift, or Alt for that gesture. Never invent a modifier.
When a selected object exposes numeric size fields in a visible property bar, type directly into the width or height field. Do not invent a generic properties button or dialog. If the field already shows a unit, enter only the numeric value.
Use click only for a discrete visible control, object, or position that can be verified locally.
Opening a chat, sending a message, publishing, purchasing, deleting, overwriting files, changing account/security settings, or confirming a dialog is external_effect or dangerous.
If a target is not clearly visible, describe the missing prerequisite in observation and choose a visible recovery action. Use done only when the goal itself is visibly achieved, never merely because the next action is uncertain.`;

export const VALIDATOR_SYSTEM_PROMPT = `You are the local visual validator for a Windows AI employee.
Inspect the screenshot after one UI action and decide whether the expected visible result happened.
Return JSON only:
{
  "success":true,
  "evidence":"short Russian description of visible evidence",
  "confidence":0.0,
  "nextStep":"short Russian next step or empty string",
  "limitations":["anything not verifiable from this frame"],
  "learningUpdate":null
}
Validation is the primary task. Do not invent hidden state and do not claim any further action was performed.
When and only when success is visibly proven and the step contains a portable technique, learningUpdate may be:
{"type":"technique|preference|lesson","name":"general title","description":"portable knowledge","trigger":"general condition","expectedResult":"general visible check","scope":"universal|selected_application"}
Otherwise learningUpdate must be null. Never copy literal sizes, entered phrases, document names, object names, or coordinates into learningUpdate.`;

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

export const FIELD_REFINER_SYSTEM_PROMPT = `You locate a requested visible input field in an enlarged crop of a desktop user interface.
Identify the field by its role, current value, nearby icons, and paired fields even when no text label is shown. The desired new value is not expected to be visible yet.
Return JSON only:
{
  "targetVisible":true,
  "point":{"x":0.0,"y":0.0},
  "confidence":0.0,
  "evidence":"short Russian description"
}
Coordinates are normalized to this cropped image from 0 to 1. Never choose a different numeric field. If the requested field is not clearly visible, set targetVisible to false and omit point.`;

export const SURFACE_GESTURE_REFINER_SYSTEM_PROMPT = `You recover a drawing gesture on a universal Windows application surface.
The supplied image is the fresh full target window. Identify a clearly visible editable canvas, artboard, document page, or drawing surface and propose one safe non-zero drag entirely inside it.
Return JSON only:
{
  "targetVisible":true,
  "from":{"x":0.0,"y":0.0},
  "to":{"x":0.0,"y":0.0},
  "confidence":0.0,
  "evidence":"short Russian description of the visible surface"
}
Coordinates are normalized to the full image from 0 to 1. Do not click or drag on toolbars, sidebars, palettes, menus, dialogs, or outside the visible editable surface. If a safe editable surface is not clearly visible, set targetVisible to false and omit from/to.`;

export const SURFACE_POINT_REFINER_SYSTEM_PROMPT = `You verify a point on a universal Windows application editing surface.
The supplied image is the fresh full target window. Identify a clearly visible editable canvas, artboard, document page, or drawing surface and return one safe point entirely inside it for placing a caret, text object, selection anchor, or other single-point operation.
Return JSON only:
{
  "targetVisible":true,
  "point":{"x":0.0,"y":0.0},
  "confidence":0.0,
  "evidence":"short Russian description of the visible surface"
}
Coordinates are normalized to the full image from 0 to 1. Do not choose a toolbar, sidebar, palette, menu, dialog, ruler, or area outside the visible editable surface. If a safe editable surface is not clearly visible, set targetVisible to false and omit point.`;

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
    if (Math.hypot(action.to.x - action.from.x, action.to.y - action.from.y) < 0.02) {
      throw new TypeError('action.from and action.to must describe a visible non-zero drag.');
    }
    action.durationMs = Math.min(Math.max(Math.round(finite(rawAction.durationMs ?? 350, 'action.durationMs')), 50), 5_000);
    const modifiers = normalizeInputModifiers(rawAction.modifiers, { label: 'action.modifiers' });
    if (modifiers.length > 0) action.modifiers = modifiers;
  }
  if (type === 'scroll') action.delta = Math.min(Math.max(Math.round(finite(rawAction.delta ?? -120, 'action.delta')), -1_200), 1_200);
  if (type === 'typeText') {
    if (typeof rawAction.text !== 'string' || rawAction.text.length === 0) throw new TypeError('action.text is required.');
    if (rawAction.text.length > 2_000) throw new TypeError('action.text is too long.');
    action.text = rawAction.text;
    action.textMode = rawAction.textMode === 'insert' ? 'insert' : 'replace';
  }
  if (type === 'wait') action.durationMs = Math.min(Math.max(Math.round(finite(rawAction.durationMs ?? 750, 'action.durationMs')), 50), 5_000);

  if (['click', 'doubleClick', 'typeText'].includes(type)) {
    const rawHint = rawAction.targetHint;
    const validRawHint = rawHint && typeof rawHint === 'object' && !Array.isArray(rawHint);
    if (!validRawHint && ['click', 'doubleClick'].includes(type)) {
      throw new TypeError('action.targetHint is required for click actions.');
    }
    if (validRawHint) {
      const hintKeys = ['automationId', 'name', 'controlType', 'visibleText'];
      const validHint = {};
      for (const key of hintKeys) {
        if (typeof rawHint[key] === 'string' && rawHint[key].trim().length > 0) {
          validHint[key] = rawHint[key].trim();
        }
      }
      if (!['automationId', 'name', 'visibleText'].some((key) => validHint[key]) &&
          ['click', 'doubleClick'].includes(type)) {
        throw new TypeError('action.targetHint requires automationId, name, or visibleText.');
      }
      if (Object.keys(validHint).length > 0) action.targetHint = validHint;
    }
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
    precondition: typeof value.precondition === 'string' ? value.precondition.trim().slice(0, 500) : '',
    checkpoint: value.checkpoint === 'deterministic' ? 'deterministic' : 'visual',
    requiresConfirmation: type !== 'done'
  };
}

export function normalizePlannerMiniPlanOutput(value, screenshotBounds = null, maxSteps = 3) {
  const current = normalizePlannerOutput(value, screenshotBounds);
  const continuation = [];
  const rawSteps = Array.isArray(value?.nextActions) ? value.nextActions : [];
  const maximumContinuation = Math.max(0, Math.min(Number(maxSteps) || 3, 3) - 1);
  for (const raw of rawSteps.slice(0, maximumContinuation)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !raw.action) break;
    try {
      continuation.push(normalizePlannerOutput({
        observation: typeof raw.observation === 'string' ? raw.observation : '',
        action: raw.action,
        reason: raw.reason,
        expectedResult: raw.expectedResult,
        risk: raw.risk,
        confidence: raw.confidence,
        precondition: raw.precondition,
        checkpoint: raw.checkpoint
      }, screenshotBounds));
    } catch {
      break;
    }
  }
  return { current, continuation };
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
  if (action.type === 'drag') return {
    ...common,
    from: convert(action.from),
    to: convert(action.to),
    durationMs: action.durationMs,
    ...(action.modifiers?.length ? { modifiers: normalizeInputModifiers(action.modifiers, { label: 'action.modifiers' }) } : {})
  };
  if (action.type === 'scroll') return { ...common, point: convert(action.point), delta: action.delta };
  if (action.type === 'typeText') return {
    ...common,
    point: convert(action.point),
    text: action.text,
    textMode: action.textMode === 'insert' ? 'insert' : 'replace'
  };
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
    limitations: Array.isArray(value.limitations) ? value.limitations.filter((item) => typeof item === 'string').slice(0, 20) : [],
    learningUpdate: value.learningUpdate && typeof value.learningUpdate === 'object' && !Array.isArray(value.learningUpdate)
      ? value.learningUpdate
      : null
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

export function findRepeatedSuccessfulAction(action, history, tolerance = 0.005) {
  if (!Array.isArray(history)) return null;
  return history.findLast((item) =>
    item?.validation?.success === true && plannedActionsEquivalent(action, item.action, tolerance)
  ) ?? null;
}
