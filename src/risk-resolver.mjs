export const RISK_CLASSES = Object.freeze([
  'read_only',
  'reversible_local',
  'persistent_local',
  'external_or_destructive'
]);

const riskRank = new Map(RISK_CLASSES.map((risk, index) => [risk, index]));

export function resolveToolRisk(manifest = {}, args = {}) {
  const base = riskRank.has(manifest.risk) ? manifest.risk : 'external_or_destructive';
  if (typeof manifest.resolveRisk !== 'function') return base;
  let resolved;
  try {
    resolved = manifest.resolveRisk(args);
  } catch {
    return 'external_or_destructive';
  }
  if (!riskRank.has(resolved)) return 'external_or_destructive';
  return riskRank.get(resolved) > riskRank.get(base) ? resolved : base;
}
