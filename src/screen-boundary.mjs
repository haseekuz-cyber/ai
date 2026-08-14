export function resolveCaptureTarget(diagnostics, configuredDeviceName) {
  const screens = diagnostics?.hardware?.screens ?? [];

  if (screens.length === 0) {
    throw new Error('The Worker session has no active display.');
  }

  if (configuredDeviceName) {
    const matches = screens.filter((screen) => screen.deviceName === configuredDeviceName);
    if (matches.length !== 1) {
      throw new Error(`Configured display ${configuredDeviceName} is not uniquely visible in the Worker session.`);
    }
    return matches[0];
  }

  const secondaryScreens = screens.filter((screen) => !screen.primary);
  if (secondaryScreens.length === 1) return secondaryScreens[0];
  if (screens.length === 1) return screens[0];
  throw new Error('Set AI_WORKSTATION_DISPLAY because the Worker sees multiple secondary displays.');
}

function finiteBounds(value) {
  return value && [value.x, value.y, value.width, value.height].every(Number.isFinite) &&
    value.width > 0 && value.height > 0;
}

export function intersectBounds(displayBounds, surfaceBounds) {
  if (!finiteBounds(displayBounds)) throw new TypeError('displayBounds must be a non-empty rectangle.');
  if (!finiteBounds(surfaceBounds)) throw new TypeError('surfaceBounds must be a non-empty rectangle.');
  const left = Math.max(displayBounds.x, surfaceBounds.x);
  const top = Math.max(displayBounds.y, surfaceBounds.y);
  const right = Math.min(displayBounds.x + displayBounds.width, surfaceBounds.x + surfaceBounds.width);
  const bottom = Math.min(displayBounds.y + displayBounds.height, surfaceBounds.y + surfaceBounds.height);
  if (right <= left || bottom <= top) {
    const error = new Error('The selected application surface is outside the assigned AI display.');
    error.code = 'surface_outside_ai_display';
    throw error;
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}
