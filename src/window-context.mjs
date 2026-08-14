export function normalizeWindowTitle(value) {
  return String(value || '')
    .replace(/\*+\s*$/, '')
    .trim()
    .toLocaleLowerCase();
}

export function sameWindowContext(current, expected) {
  return sameWindowIdentity(current, expected);
}

export function sameWindowIdentity(current, expected) {
  if (!current || !expected) return false;
  return Number(current.processId) === Number(expected.processId) &&
    Number(current.nativeWindowHandle) === Number(expected.nativeWindowHandle) &&
    normalizeWindowTitle(current.name) === normalizeWindowTitle(expected.name);
}

export function sameWindowGeometry(current, expected, tolerance = 0) {
  if (!current || !expected) return false;
  const currentBounds = current.bounds ?? current;
  const expectedBounds = expected.bounds ?? expected;
  const left = { x: Number(currentBounds.x), y: Number(currentBounds.y), width: Number(currentBounds.width), height: Number(currentBounds.height) };
  const right = { x: Number(expectedBounds.x), y: Number(expectedBounds.y), width: Number(expectedBounds.width), height: Number(expectedBounds.height) };
  if (!Number.isFinite(left.x) || !Number.isFinite(left.y) || !Number.isFinite(left.width) || !Number.isFinite(left.height)) return false;
  if (!Number.isFinite(right.x) || !Number.isFinite(right.y) || !Number.isFinite(right.width) || !Number.isFinite(right.height)) return false;
  if (tolerance <= 0) {
    return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
  }
  return Math.abs(left.x - right.x) <= tolerance && Math.abs(left.y - right.y) <= tolerance &&
    Math.abs(left.width - right.width) <= tolerance && Math.abs(left.height - right.height) <= tolerance;
}

export function classifyWindowChange(current, expected) {
  if (!sameWindowIdentity(current, expected)) return 'identity_changed';
  if (!sameWindowGeometry(current, expected)) return 'geometry_changed';
  return 'same';
}
