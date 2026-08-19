export function guiModelFamily(model) {
  const identifier = String(model || '').toLowerCase();
  if (identifier.includes('gui-owl')) return 'gui-owl';
  if (identifier.includes('ui-tars')) return 'ui-tars';
  return 'generic';
}

// The scale belongs to a single number, not to the pair. GUI-Owl has been observed emitting
// one axis as a 0..1 fraction and the other in thousandths inside the same point, and deciding
// for the pair divided the fraction by 1000 as well, which moved the click to the screen edge.
function axisScale(value) {
  if (value < 0 || value > 1_000) return 'out_of_range';
  if (value > 1) return 'thousandths';
  if (value > 0 && value < 1) return 'fraction';
  return 'ambiguous';
}

// 0 and 1 mean almost the same place in both conventions, so an axis that carries no scale of
// its own follows the axis that does.
function resolveScale(own, other) {
  if (own !== 'ambiguous') return own;
  return other === 'ambiguous' ? 'fraction' : other;
}

function normalizeThousandPoint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return value;
  const scaleX = axisScale(x);
  const scaleY = axisScale(y);
  if (scaleX === 'out_of_range' || scaleY === 'out_of_range') return value;
  return {
    ...value,
    x: resolveScale(scaleX, scaleY) === 'thousandths' ? x / 1_000 : x,
    y: resolveScale(scaleY, scaleX) === 'thousandths' ? y / 1_000 : y
  };
}

function normalizeActionCoordinates(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return action;
  return {
    ...action,
    ...(action.point ? { point: normalizeThousandPoint(action.point) } : {}),
    ...(action.from ? { from: normalizeThousandPoint(action.from) } : {}),
    ...(action.to ? { to: normalizeThousandPoint(action.to) } : {})
  };
}
export function adaptGuiModelAnalysis(model, analysis) {
  if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) return analysis;
  if (guiModelFamily(model) !== 'gui-owl') return analysis;
  return {
    ...analysis,
    ...(analysis.action ? { action: normalizeActionCoordinates(analysis.action) } : {}),
    ...(Array.isArray(analysis.nextActions)
      ? { nextActions: analysis.nextActions.map((step) => ({ ...step, ...(step?.action ? { action: normalizeActionCoordinates(step.action) } : {}) })) }
      : {}),
    ...(analysis.point ? { point: normalizeThousandPoint(analysis.point) } : {}),
    ...(analysis.from ? { from: normalizeThousandPoint(analysis.from) } : {}),
    ...(analysis.to ? { to: normalizeThousandPoint(analysis.to) } : {})
  };
}
