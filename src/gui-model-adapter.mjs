export function guiModelFamily(model) {
  const identifier = String(model || '').toLowerCase();
  if (identifier.includes('gui-owl')) return 'gui-owl';
  if (identifier.includes('ui-tars')) return 'ui-tars';
  return 'generic';
}

function normalizeThousandPoint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return value;
  if (x >= 0 && x <= 1 && y >= 0 && y <= 1) return value;
  if (x >= 0 && x <= 1_000 && y >= 0 && y <= 1_000) return { ...value, x: x / 1_000, y: y / 1_000 };
  return value;
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
