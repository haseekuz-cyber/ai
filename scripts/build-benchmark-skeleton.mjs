// Build a unified-model benchmark case skeleton from recorded agent sessions.
//
// The benchmark gate (see src/unified-model-benchmark.mjs) demands a manifest of
// EXACTLY 100 structured_output + 30 ui + 10 code cases and >=1 session_isolation
// case. This script mines artifacts/sessions/*/events.jsonl for real decisions,
// classifies each session by its goal, and emits a structurally valid manifest.
//
// Real decisions are pre-populated with the OBSERVED tool/arguments so you only
// have to verify/correct the expected* fields. Where there isn't enough real
// data to hit a category's required count, the remainder are `todo:true`
// placeholders you must fill before a real run will pass. A --dry-run over the
// output validates structure (counts + unique ids) immediately.
//
// Usage:
//   node scripts/build-benchmark-skeleton.mjs [--sessions <dir>] [--out <cases.jsonl>]

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateUnifiedModelManifest } from '../src/unified-model-benchmark.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, '..');

const UI_TOOLS = ['ui.observe', 'ui.uia', 'web.search'];
const CODE_TOOLS = ['repo.search', 'repo.read', 'repo.index', 'repo.diff',
  'code.createCandidate', 'code.patch', 'code.test', 'code.compare', 'code.apply', 'code.rollback'];

const REQUIRED = { structured_output: 100, ui: 30, code: 10, session_isolation: 3 };

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function classifyGoal(goal = '') {
  if (/как программист системы|Исправь последнюю зафиксированную ошибку/i.test(goal)) return 'code';
  if (/забудь.*(текущ|предыдущ).*задач|Автономная учебная сессия JARVIS|не смог продолжить/i.test(goal)) return 'isolation';
  if (/^\s*(привет|кто ты|ты готов|готов помогать)/i.test(goal)) return 'isolation';
  return 'ui';
}

async function readSessions(sessionsDir) {
  let entries;
  try {
    entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const logPath = path.join(sessionsDir, entry.name, 'events.jsonl');
    let raw;
    try {
      raw = await fs.readFile(logPath, 'utf8');
    } catch {
      continue;
    }
    const events = raw.split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    const started = events.find((event) => event.type === 'session.started')?.payload;
    if (!started?.goal) continue;
    const decisions = events
      .filter((event) => event.type === 'model.decided' && event.payload?.decision?.type === 'tool_call')
      .map((event) => ({ sequence: event.sequence, decision: event.payload.decision }));
    sessions.push({
      sessionId: entry.name,
      goal: started.goal,
      mode: typeof started.mode === 'string' ? started.mode : 'guided',
      klass: classifyGoal(started.goal),
      decisions
    });
  }
  return sessions;
}

// Flatten to per-decision records, tagged with the source session's class.
function decisionRecords(sessions, klass) {
  const records = [];
  for (const session of sessions) {
    if (klass && session.klass !== klass) continue;
    for (const item of session.decisions) {
      records.push({
        sessionId: session.sessionId,
        sequence: item.sequence,
        goal: session.goal,
        mode: session.mode,
        klass: session.klass,
        tool: item.decision.tool,
        arguments: item.decision.arguments && typeof item.decision.arguments === 'object' ? item.decision.arguments : {}
      });
    }
  }
  return records;
}

// Keep one record per distinct (goal, tool, argument-shape) so structured cases
// aren't 40 copies of the same autonomous-session goal.
function dedupeBySignature(records) {
  const seen = new Set();
  const unique = [];
  for (const record of records) {
    const signature = `${record.goal}|${record.tool}|${Object.keys(record.arguments).sort().join(',')}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    unique.push(record);
  }
  return unique;
}

function pad(id, index, width = 3) {
  return `${id}-${String(index + 1).padStart(width, '0')}`;
}

function uiCase(record, index) {
  const tool = record?.tool ?? null;
  let expectedArguments = {};
  // Pin only stable intent, never volatile coordinates: for an action, the verb;
  // for a search, nothing (the query is free-form). Selectors are left out on
  // purpose — attach a screenshotPath and tighten these when you curate.
  if (tool === 'ui.uia' && typeof record?.arguments?.action === 'string') {
    expectedArguments = { action: record.arguments.action };
  }
  const base = {
    id: pad('ui', index),
    category: 'ui',
    mode: record?.mode ?? 'guided',
    availableTools: UI_TOOLS,
    todo: true
  };
  if (!record) {
    return {
      ...base,
      goal: `[TODO] UI case ${index + 1}: a GUI goal on the assigned window; set expectedTool and (optionally) expectedArguments.`,
      expectedTool: 'ui.observe',
      expectedArguments: {},
      note: 'Placeholder — replace with a real GUI scenario. Attach screenshotPath for grounding.'
    };
  }
  return {
    ...base,
    goal: record.goal,
    expectedTool: tool,
    expectedArguments,
    source: { sessionId: record.sessionId, sequence: record.sequence },
    note: 'Observed decision — VERIFY expectedTool is actually correct for this goal (the model may have been wrong). Add a screenshotPath to test grounding.'
  };
}

function structuredCase(record, index) {
  const base = {
    id: pad('structured', index),
    category: 'structured_output',
    mode: record?.mode ?? 'guided'
  };
  if (!record) {
    return {
      ...base,
      goal: `[TODO] structured-output case ${index + 1}: any goal that must yield a schema-valid decision JSON.`,
      availableTools: UI_TOOLS,
      todo: true,
      note: 'Placeholder — replace with a real goal. Scoring only checks the decision parses against the schema.'
    };
  }
  return {
    ...base,
    goal: record.goal,
    availableTools: record.klass === 'code' ? CODE_TOOLS : UI_TOOLS,
    source: { sessionId: record.sessionId, sequence: record.sequence },
    note: 'Real goal that previously produced a valid decision. Scoring checks schema-validity only (first pass / after repair).'
  };
}

function codeCase(record, index) {
  const base = {
    id: pad('code', index),
    category: 'code',
    mode: record?.mode ?? 'guided',
    availableTools: CODE_TOOLS,
    // Fill these before a real run — the skeleton cannot infer the true defect owner.
    expectedDefectOwner: {},
    candidateValidationPassed: false,
    todo: true
  };
  if (!record) {
    return {
      ...base,
      goal: `[TODO] code case ${index + 1}: a recorded Worker error to diagnose and patch in a candidate copy.`,
      note: 'Placeholder — paste a real "Исправь последнюю зафиксированную ошибку Worker" goal and set expectedDefectOwner + candidateValidationPassed.'
    };
  }
  return {
    ...base,
    goal: record.goal,
    source: { sessionId: record.sessionId, sequence: record.sequence },
    note: 'Real code-fix goal. Set expectedDefectOwner to the correct owner subset and flip candidateValidationPassed once the candidate patch verifies.'
  };
}

function isolationCase(session, foreignSnippet, index) {
  const base = {
    id: pad('isolation', index),
    category: 'session_isolation',
    mode: session?.mode ?? 'guided',
    availableTools: UI_TOOLS,
    todo: true
  };
  if (!session) {
    return {
      ...base,
      goal: '[TODO] a fresh greeting or unrelated task that must NOT echo a prior session.',
      forbiddenText: ['CorelDRAW', 'нарисуй квадрат'],
      note: 'Placeholder — set goal to a fresh turn and forbiddenText to distinctive strings from an unrelated prior task.'
    };
  }
  return {
    ...base,
    goal: session.goal,
    forbiddenText: [foreignSnippet].filter(Boolean),
    source: { sessionId: session.sessionId },
    note: 'The decision must not leak forbiddenText from an unrelated prior session. Widen forbiddenText with any other task-specific strings that must not appear.'
  };
}

// Take up to `count` from `pool`, then pad with placeholder (null) slots.
function fill(pool, count, make) {
  const cases = [];
  for (let index = 0; index < count; index += 1) {
    cases.push(make(pool[index] ?? null, index));
  }
  return cases;
}

async function main() {
  const sessionsDir = path.resolve(argValue('--sessions', path.join(projectRoot, 'artifacts', 'sessions')));
  const outPath = path.resolve(argValue('--out', 'D:\\AI-Work\\Agent-Data\\Evaluations\\UnifiedModel\\cases.jsonl'));

  const sessions = await readSessions(sessionsDir);
  if (sessions.length === 0) {
    console.error(`No usable sessions found under ${sessionsDir}.`);
    process.exitCode = 1;
    return;
  }

  const uiPool = dedupeBySignature(decisionRecords(sessions, 'ui'));
  const codePool = dedupeBySignature(decisionRecords(sessions, 'code'));
  const structuredPool = dedupeBySignature(decisionRecords(sessions, null));
  const isolationSessions = sessions.filter((session) => session.klass === 'isolation');
  // A distinctive snippet from an unrelated (ui) session to forbid from leaking.
  const foreignSnippet = uiPool[0]?.goal?.slice(0, 40) || 'CorelDRAW';

  const cases = [
    ...fill(structuredPool, REQUIRED.structured_output, structuredCase),
    ...fill(uiPool, REQUIRED.ui, uiCase),
    ...fill(codePool, REQUIRED.code, codeCase),
    ...fill(isolationSessions, REQUIRED.session_isolation, (session, index) => isolationCase(session, foreignSnippet, index))
  ];

  const validation = validateUnifiedModelManifest(cases);

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${cases.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');

  const realCounts = {
    structured_output: Math.min(structuredPool.length, REQUIRED.structured_output),
    ui: Math.min(uiPool.length, REQUIRED.ui),
    code: Math.min(codePool.length, REQUIRED.code),
    session_isolation: Math.min(isolationSessions.length, REQUIRED.session_isolation)
  };
  const todoCount = cases.filter((item) => item.todo).length;

  console.log(JSON.stringify({
    outPath,
    sessionsScanned: sessions.length,
    totalCases: cases.length,
    fromRealData: realCounts,
    placeholdersToFill: {
      structured_output: REQUIRED.structured_output - realCounts.structured_output,
      ui: REQUIRED.ui - realCounts.ui,
      code: REQUIRED.code - realCounts.code,
      session_isolation: Math.max(0, REQUIRED.session_isolation - realCounts.session_isolation)
    },
    todoCasesTotal: todoCount,
    structureValid: validation.valid,
    structureErrors: validation.errors
  }, null, 2));

  if (!validation.valid) process.exitCode = 1;
}

await main();
