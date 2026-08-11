const MIN_CONFIDENCE_THRESHOLD = 0.6;

function validBounds(bounds) {
  return bounds && !bounds.empty &&
    Number.isFinite(Number(bounds.x)) && Number.isFinite(Number(bounds.y)) &&
    Number(bounds.width) > 0 && Number(bounds.height) > 0;
}

function contains(bounds, point) {
  return validBounds(bounds) && point &&
    Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)) &&
    point.x >= bounds.x && point.y >= bounds.y &&
    point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height;
}

function containsBounds(outer, inner) {
  return validBounds(outer) && validBounds(inner) &&
    inner.x >= outer.x && inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height &&
    (inner.x !== outer.x || inner.y !== outer.y ||
      inner.width !== outer.width || inner.height !== outer.height);
}

function screenPoint(point, bounds) {
  if (!validBounds(bounds) || !point ||
      !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) {
    throw new TypeError('A valid normalized point and window bounds are required.');
  }
  return {
    x: Number(bounds.x) + Number(point.x) * Math.max(0, Number(bounds.width) - 1),
    y: Number(bounds.y) + Number(point.y) * Math.max(0, Number(bounds.height) - 1)
  };
}

function normalizedPoint(point, windowBounds) {
  if (!validBounds(windowBounds) || !point) {
    throw new TypeError('A valid screen point and window bounds are required.');
  }
  return {
    x: Math.min(1, Math.max(0,
      (Number(point.x) - Number(windowBounds.x)) / Math.max(1, Number(windowBounds.width) - 1))),
    y: Math.min(1, Math.max(0,
      (Number(point.y) - Number(windowBounds.y)) / Math.max(1, Number(windowBounds.height) - 1)))
  };
}

function normalizedCenter(bounds, windowBounds) {
  return normalizedPoint({
    x: Number(bounds.x) + Number(bounds.width) / 2,
    y: Number(bounds.y) + Number(bounds.height) / 2
  }, windowBounds);
}

function normalizedCapabilities(element) {
  return new Set((Array.isArray(element?.capabilities) ? element.capabilities : [])
    .map((capability) => String(capability).trim().toLowerCase()));
}

function isEditable(element) {
  const capabilities = normalizedCapabilities(element);
  const controlType = String(element?.controlType || '').toLowerCase();
  return capabilities.has('value') || capabilities.has('setvalue') ||
    controlType === 'edit' || controlType === 'document' ||
    /(^|\b)(edit|richedit|scintilla|text)(\b|$)/i.test(String(element?.className || ''));
}

function isActionable(element) {
  const capabilities = normalizedCapabilities(element);
  const controlType = String(element?.controlType || '').toLowerCase();
  const actionableControls = new Set([
    'button', 'menuitem', 'listitem', 'tabitem', 'treeitem', 'hyperlink',
    'checkbox', 'radiobutton', 'combobox'
  ]);
  return capabilities.has('invoke') || capabilities.has('toggle') ||
    capabilities.has('select') || capabilities.has('expandcollapse') ||
    actionableControls.has(controlType);
}

function targetSummary(target) {
  return {
    runtimeId: target.runtimeId || null,
    parentRuntimeId: target.parentRuntimeId || null,
    automationId: target.automationId || null,
    name: target.name || null,
    className: target.className || null,
    controlType: target.controlType || null,
    bounds: target.bounds
  };
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function textMatchScore(expected, actual) {
  const hint = cleanText(expected);
  const value = cleanText(actual);
  if (!hint || !value) return 0;
  if (hint === value) return 0.9;
  if (value.includes(hint) && hint.length >= 3) return 0.7;
  return 0;
}

function matchTargetHint(element, targetHint) {
  if (!targetHint || typeof targetHint !== 'object' || Array.isArray(targetHint)) {
    return { matched: false, reason: 'invalid_target_hint', score: 0 };
  }

  const identityFields = ['automationId', 'name', 'visibleText']
    .filter((field) => cleanText(targetHint[field]));
  if (identityFields.length === 0) {
    return { matched: false, reason: 'target_hint_has_no_identity', score: 0 };
  }

  if (cleanText(targetHint.controlType) &&
      cleanText(targetHint.controlType) !== cleanText(element.controlType)) {
    return { matched: false, reason: 'control_type_mismatch', score: 0 };
  }

  const identityScores = [];
  if (cleanText(targetHint.automationId)) {
    if (String(targetHint.automationId).trim() !== String(element.automationId || '').trim()) {
      return { matched: false, reason: 'automation_id_mismatch', score: 0 };
    }
    identityScores.push(1);
  }
  if (cleanText(targetHint.name)) {
    const score = textMatchScore(targetHint.name, element.name);
    if (score === 0) return { matched: false, reason: 'name_mismatch', score: 0 };
    identityScores.push(score);
  }
  if (cleanText(targetHint.visibleText)) {
    const score = textMatchScore(targetHint.visibleText, element.name);
    if (score === 0) return { matched: false, reason: 'visible_text_mismatch', score: 0 };
    identityScores.push(Math.min(score, 0.85));
  }

  return {
    matched: true,
    score: Math.min(...identityScores),
    matchedFields: identityScores.length + (cleanText(targetHint.controlType) ? 1 : 0)
  };
}

function isDescendant(candidate, ancestor, byRuntimeId) {
  let parentId = candidate.parentRuntimeId;
  const visited = new Set();
  while (parentId && !visited.has(parentId)) {
    if (parentId === ancestor.runtimeId) return true;
    visited.add(parentId);
    parentId = byRuntimeId.get(parentId)?.parentRuntimeId || '';
  }
  return false;
}

function uniqueNestedCandidate(candidates, allElements) {
  if (candidates.length === 1) return candidates[0];
  const byRuntimeId = new Map(allElements
    .filter((element) => element.runtimeId)
    .map((element) => [element.runtimeId, element]));
  const nested = candidates.filter((candidate) => candidates.every((other) =>
    candidate === other || isDescendant(candidate, other, byRuntimeId) ||
      containsBounds(other.bounds, candidate.bounds)
  ));
  return nested.length === 1 ? nested[0] : null;
}

function selectSemanticTarget(elements, targetHint, proposedScreenPoint) {
  if (!Array.isArray(elements) || elements.length === 0) {
    return { blocked: true, reason: 'no_candidates' };
  }
  const actionableHits = elements.filter((element) =>
    element.enabled !== false && !element.offscreen && validBounds(element.bounds) &&
    isActionable(element) && contains(element.bounds, proposedScreenPoint)
  );
  if (actionableHits.length === 0) {
    return { blocked: true, reason: 'no_actionable_target' };
  }

  const scored = actionableHits.map((element) => ({
    element,
    ...matchTargetHint(element, targetHint)
  })).filter((candidate) => candidate.matched);
  if (scored.length === 0) {
    return { blocked: true, reason: 'no_semantic_match' };
  }

  const bestScore = Math.max(...scored.map((candidate) => candidate.score));
  const bestByScore = scored.filter((candidate) => candidate.score === bestScore);
  const mostFields = Math.max(...bestByScore.map((candidate) => candidate.matchedFields));
  const best = bestByScore
    .filter((candidate) => candidate.matchedFields === mostFields)
    .map((candidate) => candidate.element);
  const selected = uniqueNestedCandidate(best, elements);
  if (!selected) return { blocked: true, reason: 'ambiguous_target' };
  return { element: selected, confidence: bestScore };
}

function safeClickPoint(element, windowBounds, proposedScreenPoint) {
  const clickablePoint = element.clickablePoint;
  if (contains(element.bounds, clickablePoint)) {
    return { point: normalizedPoint(clickablePoint, windowBounds), method: 'uia_clickable_point' };
  }

  // The fresh screenshot point already hit this semantically matched UIA element.
  // Keep it deterministic and move it only enough to remain inside a 1 px inset.
  const left = Number(element.bounds.x) + Math.min(1, Number(element.bounds.width) / 4);
  const top = Number(element.bounds.y) + Math.min(1, Number(element.bounds.height) / 4);
  const right = Number(element.bounds.x) + Number(element.bounds.width) - 1;
  const bottom = Number(element.bounds.y) + Number(element.bounds.height) - 1;
  const interior = {
    x: Math.min(Math.max(Number(proposedScreenPoint.x), left), Math.max(left, right)),
    y: Math.min(Math.max(Number(proposedScreenPoint.y), top), Math.max(top, bottom))
  };
  return { point: normalizedPoint(interior, windowBounds), method: 'planned_interior_point' };
}

function blockedResult(proposal, reason, details = {}) {
  return {
    proposal,
    grounding: { adjusted: false, blocked: true, reason, ...details },
    blocked: true,
    abortReason: reason
  };
}

function groundTextInput({ proposal, elements, windowBounds }) {
  const editable = elements.filter((element) =>
    element.enabled !== false && !element.offscreen && !element.isPassword &&
    validBounds(element.bounds) && isEditable(element)
  );
  const proposedScreenPoint = screenPoint(proposal.action.point, windowBounds);
  const hits = editable.filter((element) => contains(element.bounds, proposedScreenPoint));
  const hit = uniqueNestedCandidate(hits, elements);
  if (hit) {
    return {
      proposal,
      grounding: {
        adjusted: false,
        blocked: false,
        reason: 'inside_editable_target',
        target: targetSummary(hit)
      },
      blocked: false
    };
  }
  if (hits.length > 1) return blockedResult(proposal, 'ambiguous_editable_targets');
  if (editable.length !== 1) {
    return blockedResult(proposal, editable.length ? 'ambiguous_editable_targets' : 'no_editable_target');
  }
  const target = editable[0];
  return {
    proposal: {
      ...proposal,
      action: { ...proposal.action, point: normalizedCenter(target.bounds, windowBounds) }
    },
    grounding: {
      adjusted: true,
      blocked: false,
      reason: 'single_editable_target',
      target: targetSummary(target)
    },
    blocked: false
  };
}

export function normalizeAndGround({ proposal, elements = [], windowBounds }) {
  const actionType = proposal?.action?.type;
  if (actionType === 'typeText') {
    return groundTextInput({ proposal, elements, windowBounds });
  }
  if (!['click', 'doubleClick'].includes(actionType)) {
    return {
      proposal,
      grounding: { adjusted: false, blocked: false, reason: 'grounding_not_required' },
      blocked: false
    };
  }

  const targetHint = proposal.action.targetHint || proposal.targetHint;
  const hasIdentity = targetHint && ['automationId', 'name', 'visibleText']
    .some((field) => cleanText(targetHint[field]));
  if (!hasIdentity) return blockedResult(proposal, 'missing_target_identity');

  const proposedScreenPoint = screenPoint(proposal.action.point, windowBounds);
  const selection = selectSemanticTarget(elements, targetHint, proposedScreenPoint);
  if (selection.blocked) return blockedResult(proposal, selection.reason);
  if (selection.confidence < MIN_CONFIDENCE_THRESHOLD) {
    return blockedResult(proposal, 'low_confidence', {
      confidence: selection.confidence,
      minRequired: MIN_CONFIDENCE_THRESHOLD
    });
  }

  const safePoint = safeClickPoint(selection.element, windowBounds, proposedScreenPoint);
  const grounding = {
    adjusted: true,
    blocked: false,
    reason: 'semantic_target_found',
    target: targetSummary(selection.element),
    confidence: selection.confidence,
    safePoint: safePoint.point,
    pointMethod: safePoint.method,
    originalPoint: proposal.action.point
  };
  return {
    proposal: {
      ...proposal,
      action: { ...proposal.action, point: safePoint.point },
      grounding
    },
    grounding,
    blocked: false
  };
}

export function groundPlannerProposal(options) {
  const grounded = normalizeAndGround(options);
  if (grounded.blocked) {
    const error = new Error(`Action blocked during grounding: ${grounded.abortReason}`);
    error.code = 'invalid_local_plan';
    error.abortReason = grounded.abortReason;
    error.groundingResult = grounded.grounding;
    throw error;
  }
  return { proposal: grounded.proposal, grounding: grounded.grounding };
}

export async function executeGroundedAction({ action, grounding, execute }) {
  if (typeof execute !== 'function') throw new TypeError('execute must be a function.');
  const requiresGrounding = ['click', 'doubleClick', 'typeText'].includes(action?.type);
  if (requiresGrounding && (!grounding || grounding.blocked !== false)) {
    const error = new Error('Grounding is missing or blocked. No action was executed.');
    error.code = 'grounding_blocked';
    throw error;
  }
  if (['click', 'doubleClick'].includes(action?.type) &&
      Number(grounding.confidence) < MIN_CONFIDENCE_THRESHOLD) {
    const error = new Error('Grounding confidence is below the execution threshold.');
    error.code = 'grounding_blocked';
    throw error;
  }
  return execute();
}

export function groundPlannedAction(options) {
  return normalizeAndGround(options);
}
