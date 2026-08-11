export function normalizeWindowTitle(value) {
  return String(value || '')
    .replace(/\*+\s*$/, '')
    .trim()
    .toLocaleLowerCase();
}

export function sameWindowContext(current, expected) {
  if (!current || !expected) return false;
  return Number(current.processId) === Number(expected.processId) &&
    Number(current.nativeWindowHandle) === Number(expected.nativeWindowHandle) &&
    normalizeWindowTitle(current.name) === normalizeWindowTitle(expected.name);
}
