// Deterministic, model-independent COORDINATE actuator smoke test.
//
// Companion to smoke-uia.mjs. Where that test proves the UIA "hands" (invoke a
// named element), this one proves the COORDINATE hands — that the pointer bridge
// can physically move the cursor and click an (x,y) point clamped to the assigned
// AI display, using the EXACT production path the agent would use once ui.pointer
// is registered (resolveUiAutomationDisplay -> inspect for window bounds ->
// intersectBounds -> createBoundedPointerRequest -> runPointerAction), minus the
// model and minus every policy gate.
//
// This is the actuator that CorelDRAW and other UIA-opaque / canvas apps need:
// they expose no invokable elements, so ui.uia structurally cannot drive them,
// but a bounds-safe coordinate click can. If this passes, the coordinate path is
// proven and ui.pointer can be wired with confidence. If it fails, the pointer
// bridge/display wiring is the bottleneck.
//
// SAFE BY DEFAULT: with no --do flag it only resolves the display, lists windows,
// inspects the target for its bounds, and PRINTS the point it would click — it
// never touches the cursor. It performs a real click ONLY when you pass --do, so
// you choose the moment. NOTE: a real click moves your physical cursor on the AI
// display; run --do yourself when that screen is clear.
//
// Usage:
//   node scripts/smoke-pointer.mjs --title "Кальк"                 # dry, prints target point (safe)
//   node scripts/smoke-pointer.mjs --title "Кальк" --do            # click the window-center point
//   node scripts/smoke-pointer.mjs --title "Кальк" --do --x 1600 --y 400   # click an explicit point
//   node scripts/smoke-pointer.mjs --title "Кальк" --do --action doubleClick

import { config } from '../src/config.mjs';
import { collectWindowsDiagnostics } from '../src/windows-diagnostics.mjs';
import {
  resolveUiAutomationDisplay,
  createBoundedUiRequest,
  runUiAutomation,
  forbiddenUiaProcesses
} from '../src/uia-bridge.mjs';
import { intersectBounds } from '../src/screen-boundary.mjs';
import { createBoundedPointerRequest, runPointerAction } from '../src/pointer-bridge.mjs';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

// Read-only UIA calls (listWindows, inspect) reuse the same bounded request path
// as production so display resolution and forbidden-process guards are identical.
async function uia(diagnostics, request) {
  const bounded = createBoundedUiRequest({
    diagnostics,
    configuredDeviceName: config.assignedDisplay,
    request
  });
  return runUiAutomation(config.uiaScript, bounded, { timeoutMs: 30_000 });
}

function centerOf(bounds) {
  return {
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2)
  };
}

async function main() {
  const titleQuery = arg('--title');
  if (!titleQuery) {
    console.error('Usage: node scripts/smoke-pointer.mjs --title "<window title substring>" [--do] [--x <n> --y <n>] [--action click|doubleClick]');
    process.exitCode = 2;
    return;
  }
  const action = arg('--action', 'click');
  if (!['click', 'doubleClick'].includes(action)) {
    console.error(`--action must be click or doubleClick for this smoke (got "${action}").`);
    process.exitCode = 2;
    return;
  }

  console.log(`[1/4] display: ${config.assignedDisplay || '(auto: single secondary)'}  pointer bridge: ${config.pointerBridgeScript}`);
  const diagnostics = await collectWindowsDiagnostics(config.diagnosticsScript);
  const display = resolveUiAutomationDisplay(diagnostics, config.assignedDisplay);
  console.log(`      AI display: ${display.deviceName}  bounds: ${JSON.stringify(display.bounds)}`);

  console.log('[2/4] listWindows on the AI display...');
  const windows = await uia(diagnostics, { operation: 'listWindows' });
  const list = Array.isArray(windows?.windows) ? windows.windows : [];
  const match = list.find((w) => String(w.name || w.title || '').toLowerCase().includes(titleQuery.toLowerCase()));
  if (!match) {
    console.error(`      no window on the AI display matches "${titleQuery}". Windows found:`);
    for (const w of list) console.error(`        - ${w.name || w.title || '(unnamed)'}  handle=${w.nativeWindowHandle}`);
    process.exitCode = 1;
    return;
  }
  const windowHandle = Number(match.nativeWindowHandle);
  console.log(`      matched: "${match.name || match.title}"  handle=${windowHandle}`);

  console.log('[3/4] inspect (window bounds only) + intersect with AI display...');
  const inspected = await uia(diagnostics, { operation: 'inspect', windowHandle, maxDepth: 0, maxElements: 1 });
  if (!inspected?.window?.bounds) {
    console.error('      inspect did not return window bounds; cannot compute a safe target point.');
    process.exitCode = 1;
    return;
  }
  console.log(`      window bounds: ${JSON.stringify(inspected.window.bounds)}  process: ${inspected.window.processName || '(unknown)'}`);
  let executionBounds;
  try {
    executionBounds = intersectBounds(display.bounds, inspected.window.bounds);
  } catch (error) {
    console.error(`      ${error.message} The window must sit on the AI display for a coordinate click.`);
    process.exitCode = 1;
    return;
  }
  console.log(`      allowed action area (window ∩ AI display): ${JSON.stringify(executionBounds)}`);

  // Explicit --x/--y wins; otherwise aim at the center of the allowed area. The
  // bridge clamps to executionBounds regardless, so an off-point can't escape it.
  const explicitX = arg('--x');
  const explicitY = arg('--y');
  const point = (explicitX && explicitY)
    ? { x: Number(explicitX), y: Number(explicitY) }
    : centerOf(executionBounds);
  console.log(`      target point: ${JSON.stringify(point)}  (${explicitX && explicitY ? 'explicit --x/--y' : 'window center'})`);

  if (!has('--do')) {
    console.log('[4/4] dry run complete — cursor untouched. Re-run with --do (clear the AI screen first) to perform one real click.');
    return;
  }

  // Build the request through the SAME bounded path production uses. No
  // executionSurface is passed, so no inputLease is required (that gate only
  // applies to shared-surface leases from the InputArbiter).
  const bridgeRequest = createBoundedPointerRequest({
    action: { windowHandle, action, point, confirmed: true, button: 'left' },
    allowedBounds: executionBounds,
    forbiddenProcessNames: forbiddenUiaProcesses
  });
  if (bridgeRequest.boundaryAdjusted) {
    console.log(`      note: target was clamped into the allowed area -> ${JSON.stringify(bridgeRequest.point)}`);
  }

  console.log(`[4/4] performing real ${action} at ${JSON.stringify(bridgeRequest.point)} ...`);
  const result = await runPointerAction(config.pointerBridgeScript, bridgeRequest, { timeoutMs: 10_000 });
  console.log('      actuator result:', JSON.stringify(result, null, 2));
  console.log('DONE. If the cursor moved and clicked on the second screen, the COORDINATE actuator path is proven end-to-end.');
}

await main().catch((error) => {
  console.error('SMOKE FAILED:', error?.code ? `[${error.code}] ` : '', error?.message || error);
  process.exitCode = 1;
});
