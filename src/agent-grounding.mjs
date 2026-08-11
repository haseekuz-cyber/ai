function contains(bounds, point) {
  return bounds && !bounds.empty && bounds.width > 0 && bounds.height > 0 &&
    point.x >= bounds.x && point.y >= bounds.y &&
    point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height;
}

function screenPoint(point, bounds) {
  return {
    x: Number(bounds.x) + Number(point.x) * Math.max(0, Number(bounds.width) - 1),
    y: Number(bounds.y) + Number(point.y) * Math.max(0, Number(bounds.height) - 1)
  };
}

function normalizedCenter(bounds, windowBounds) {
  return {
    x: Math.min(1, Math.max(0, (bounds.x + bounds.width / 2 - windowBounds.x) / windowBounds.width)),
    y: Math.min(1, Math.max(0, (bounds.y + bounds.height / 2 - windowBounds.y) / windowBounds.height))
  };
}

function isEditable(element) {
  const capabilities = Array.isArray(element.capabilities) ? element.capabilities : [];
  return capabilities.includes('setValue') ||
    ['Edit', 'Document'].includes(element.controlType) ||
    /(^|\b)(edit|richedit|scintilla|text)(\b|$)/i.test(String(element.className || ''));
}

function targetSummary(target) {
  return {
    automationId: target.automationId || null,
    name: target.name || null,
    className: target.className || null,
    controlType: target.controlType || null,
    bounds: target.bounds
  };
}

export function groundPlannedAction({ proposal, elements = [], windowBounds }) {
  if (proposal?.action?.type !== 'typeText') return { proposal, grounding: { adjusted: false, reason: 'not_text_input' } };
  const editable = elements.filter((element) =>
    element.enabled !== false && !element.offscreen && !element.isPassword &&
    element.bounds?.width > 0 && element.bounds?.height > 0 && isEditable(element)
  );
  const proposedScreenPoint = screenPoint(proposal.action.point, windowBounds);
  const hit = editable.find((element) => contains(element.bounds, proposedScreenPoint));
  if (hit) return { proposal, grounding: { adjusted: false, reason: 'already_inside_editable', target: targetSummary(hit) } };
  if (editable.length !== 1) {
    return {
      proposal,
      grounding: { adjusted: false, reason: editable.length ? 'ambiguous_editable_targets' : 'no_editable_target' }
    };
  }
  const target = editable[0];
  return {
    proposal: {
      ...proposal,
      action: { ...proposal.action, point: normalizedCenter(target.bounds, windowBounds) }
    },
    grounding: {
      adjusted: true,
      reason: 'single_editable_target',
      target: targetSummary(target)
    }
  };
}
