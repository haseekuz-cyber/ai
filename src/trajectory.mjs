export const TRAJECTORY_MODES = Object.freeze(['exact', 'adaptive', 'optional', 'replaceable']);

export function normalizeTrajectoryMode(value, fallback = 'adaptive') {
  const normalized = String(value || '');
  if (TRAJECTORY_MODES.includes(normalized)) return normalized;
  if (TRAJECTORY_MODES.includes(fallback)) return fallback;
  throw new TypeError('Unknown trajectory mode.');
}

export function normalizeLearnedTrajectory(points, { required = false, maxPoints = 500 } = {}) {
  if (points == null) {
    if (required) throw new TypeError('An exact trajectory requires recorded points.');
    return [];
  }
  if (!Array.isArray(points)) throw new TypeError('trajectory must be an array.');
  const normalized = [];
  for (const point of points.slice(0, maxPoints)) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
      throw new TypeError('trajectory points must use normalized coordinates.');
    }
    const previous = normalized.at(-1);
    if (!previous || previous.x !== x || previous.y !== y) normalized.push({ x, y });
  }
  if (required && normalized.length < 2) throw new TypeError('An exact trajectory requires at least two points.');
  return normalized;
}

export function trajectoryPolicy(step) {
  const mode = normalizeTrajectoryMode(step?.trajectoryMode, 'adaptive');
  const includeRecordedPath = mode === 'exact' || mode === 'adaptive';
  const trajectory = includeRecordedPath
    ? normalizeLearnedTrajectory(step?.trajectory, { required: mode === 'exact' })
    : [];
  return { mode, includeRecordedPath, trajectory };
}
