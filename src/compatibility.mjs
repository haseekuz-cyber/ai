export function evaluateCompatibility(report) {
  const blockers = [];
  const warnings = [];

  if (!report || typeof report !== 'object') {
    return {
      readyForIndependentWorkplace: false,
      readyForNonInvasivePilot: false,
      requiresSeparateWindowsSession: false,
      blockers: ['Windows diagnostics are unavailable.'],
      warnings
    };
  }

  const screens = report.hardware?.screens?.length ?? 0;
  const ramGB = Number(report.hardware?.ramGB ?? 0);
  const gpus = report.hardware?.gpus?.length ?? 0;
  const architecture = report.operatingSystem?.architecture ?? '';

  if (screens < 2) blockers.push('At least two active displays are required.');
  if (ramGB < 16) blockers.push('At least 16 GB of RAM is required for the design-workload pilot.');
  if (gpus < 1) blockers.push('No supported display adapter was detected.');
  if (!String(architecture).includes('64')) blockers.push('A 64-bit Windows installation is required.');

  if (String(report.operatingSystem?.caption ?? '').includes('Windows 10')) {
    warnings.push('The pilot can run on Windows 10, but the production target should be Windows 11.');
  }

  return {
    readyForIndependentWorkplace: blockers.length === 0,
    readyForNonInvasivePilot: blockers.length === 0,
    requiresSeparateWindowsSession: false,
    runtimeVerificationRequired: true,
    blockers,
    warnings
  };
}
