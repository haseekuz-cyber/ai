// Deterministic, model-independent actuator smoke test.
//
// This proves the "hands" work — that the UIA bridge can see and drive a real
// control on the assigned AI display — using the EXACT production path the agent
// uses (config.uiaScript + createBoundedUiRequest + runUiAutomation), minus the
// model and minus every policy gate. If this passes, any failure of guided mode
// is the model's grounding, not the actuator. If this fails, the bridge/display
// wiring is the bottleneck and no benchmark work matters yet.
//
// SAFE BY DEFAULT: with no --do flag it only lists windows and inspects (both
// read-only) and prints the invokable elements it found, with their selectors.
// It performs a real click ONLY when you pass --do, so you choose the moment.
//
// Usage:
//   node scripts/smoke-uia.mjs --title "Кальк"            # inspect only (safe)
//   node scripts/smoke-uia.mjs --title "Кальк" --do --name "2"   # actually invoke button "2"
//   node scripts/smoke-uia.mjs --title "Кальк" --do --automationId num2Button

import { config } from '../src/config.mjs';
import { collectWindowsDiagnostics } from '../src/windows-diagnostics.mjs';
import { createBoundedUiRequest, runUiAutomation } from '../src/uia-bridge.mjs';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

async function bridge(diagnostics, request) {
  const bounded = createBoundedUiRequest({
    diagnostics,
    configuredDeviceName: config.assignedDisplay,
    request
  });
  return runUiAutomation(config.uiaScript, bounded, { timeoutMs: 30_000 });
}

// Depth-first flatten of the inspect element tree into a flat list.
function flatten(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  for (const child of Array.isArray(node.children) ? node.children : []) flatten(child, out);
  return out;
}

function selectorFor(element) {
  for (const key of ['automationId', 'name', 'className']) {
    if (typeof element?.[key] === 'string' && element[key].length > 0) return { [key]: element[key] };
  }
  return null;
}

function isInvokable(element) {
  const caps = Array.isArray(element?.capabilities) ? element.capabilities : [];
  const type = String(element?.controlType || '');
  return caps.some((c) => /invoke|toggle|selectionitem|expandcollapse/i.test(c)) || /Button|MenuItem/.test(type);
}

async function main() {
  const titleQuery = arg('--title');
  if (!titleQuery) {
    console.error('Usage: node scripts/smoke-uia.mjs --title "<window title substring>" [--do --name "<text>" | --automationId <id>]');
    process.exitCode = 2;
    return;
  }

  console.log(`[1/4] display: ${config.assignedDisplay || '(auto: single secondary)'}  bridge: ${config.uiaScript}`);
  const diagnostics = await collectWindowsDiagnostics(config.diagnosticsScript);
  const screens = diagnostics?.hardware?.screens ?? [];
  console.log(`      screens seen: ${screens.map((s) => `${s.deviceName}${s.primary ? '(primary)' : ''}`).join(', ') || 'none'}`);

  console.log('[2/4] listWindows on the AI display...');
  const windows = await bridge(diagnostics, { operation: 'listWindows' });
  const list = Array.isArray(windows?.windows) ? windows.windows : (Array.isArray(windows) ? windows : []);
  const match = list.find((w) => String(w.name || w.title || '').toLowerCase().includes(titleQuery.toLowerCase()));
  if (!match) {
    console.error(`      no window on the AI display matches "${titleQuery}". Windows found:`);
    for (const w of list) console.error(`        - ${w.name || w.title || '(unnamed)'}  handle=${w.nativeWindowHandle}`);
    process.exitCode = 1;
    return;
  }
  const windowHandle = Number(match.nativeWindowHandle);
  console.log(`      matched: "${match.name || match.title}"  handle=${windowHandle}`);

  console.log('[3/4] inspect...');
  const inspected = await bridge(diagnostics, { operation: 'inspect', windowHandle, maxDepth: 6, maxElements: 400 });
  // The bridge returns a FLAT elements array; fall back to tree-flatten only if nested.
  const elements = Array.isArray(inspected?.elements) ? inspected.elements : flatten(inspected);
  const invokable = elements.filter((e) => isInvokable(e) && selectorFor(e)).slice(0, 40);
  console.log(`      elements: ${elements.length}, invokable candidates: ${invokable.length}`);
  for (const e of invokable.slice(0, 20)) {
    console.log(`        · ${e.controlType || '?'}  ${JSON.stringify(selectorFor(e))}  name="${e.name || ''}"`);
  }

  if (!has('--do')) {
    console.log('[4/4] read-only smoke complete. Pass --do with --name/--automationId to perform one real invoke.');
    return;
  }

  const selector = arg('--automationId') ? { automationId: arg('--automationId') }
    : arg('--name') ? { name: arg('--name') }
    : null;
  if (!selector) {
    console.error('[4/4] --do requires --name "<text>" or --automationId <id>. Pick one from the candidates above.');
    process.exitCode = 2;
    return;
  }

  console.log(`[4/4] invoking ${JSON.stringify(selector)} ...`);
  const result = await bridge(diagnostics, {
    operation: 'action',
    action: arg('--action', 'invoke'),
    selector,
    windowHandle,
    confirmed: true,
    ...(arg('--value') ? { value: arg('--value') } : {})
  });
  console.log('      actuator result:', JSON.stringify(result, null, 2));
  console.log('DONE. If the control reacted on the second screen, the actuator path is proven end-to-end.');
}

await main().catch((error) => {
  console.error('SMOKE FAILED:', error?.code ? `[${error.code}] ` : '', error?.message || error);
  process.exitCode = 1;
});
