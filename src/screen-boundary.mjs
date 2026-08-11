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

  if (screens.length !== 1) {
    throw new Error('The Worker sees multiple displays. Set AI_WORKSTATION_DISPLAY explicitly before capture.');
  }

  return screens[0];
}

