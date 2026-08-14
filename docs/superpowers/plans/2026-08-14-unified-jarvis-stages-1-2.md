# Unified JARVIS Stages 1–2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace diverging JARVIS/Planner/Teacher/Coder state with one event-sourced AgentSession and route ordinary UI work plus programmer work through one model → tool → result loop.

**Architecture:** SessionEventLog is the source of truth; SessionReducer reconstructs state; ContextCompiler creates bounded model input. AgentEngine owns one active model and invokes deterministic tools through ToolRegistry. Existing capture, UIA, Pointer, LM Studio and candidate-test code are retained behind adapters during migration.

**Tech Stack:** Node.js 22 ESM, `node:test`, NDJSON event storage, SHA-256, RFC 8785-compatible canonical JSON, LM Studio OpenAI-compatible endpoint, PowerShell Windows bridges.

## Global Constraints

- One active generative model and one AgentSession owner; no new Planner, Teacher, Critic or Coder personalities.
- The event log and reducer, not model context, are the source of truth.
- All writes and UI effects are serialized; parallel read-only results commit by assigned dispatch order.
- Physical input in a shared session is at-most-once and requires a valid InputLease; absolute input isolation is promised only for an isolated execution surface.
- Risk is assigned by tool manifests and deterministic code; model-provided risk cannot lower it.
- Existing UIA, Pointer, capture, teaching data and confirmed skills must remain usable.
- Existing HTTP routes remain compatible until the unified frontend migration is complete.
- No GitHub publication before local user verification.

---

## File Structure

### New runtime units

- `src/canonical-json.mjs` — canonical serialization and logical state hashing.
- `src/session-events.mjs` — event schema and event constructors.
- `src/session-reducer.mjs` — pure deterministic AgentSession reducer.
- `src/session-store.mjs` — append-only log, snapshots and recovery.
- `src/context-compiler.mjs` — pinned context and budget enforcement.
- `src/input-arbiter.mjs` — InputLease issuance and validation.
- `src/windows-user-activity.mjs` — Windows activity snapshot adapter.
- `scripts/user-activity.ps1` — `GetLastInputInfo` bridge.
- `src/risk-resolver.mjs` — deterministic risk classification.
- `src/tool-invocation-ledger.mjs` — idempotency status and cached ToolResult.
- `src/tool-registry.mjs` — typed tool manifests and ordered execution.
- `src/agent-model-protocol.mjs` — one model response schema.
- `src/agent-engine.mjs` — the unified model → tool → result loop.
- `src/repository-tools.mjs` — bounded repository read/search/index tools.
- `src/code-candidate.mjs` — candidate sandbox, patch, test, diff and rollback.
- `scripts/benchmark-unified-model.mjs` — replay benchmark gate.

### Existing integration units

- `src/config.mjs` — one `activeModel`, unified-agent paths and rollout switch.
- `src/lmstudio-client.mjs` — one unified structured response schema.
- `src/pointer-bridge.mjs` and `scripts/pointer-bridge.ps1` — lease propagation and mid-gesture cancellation.
- `src/action-policy.mjs` — compatibility wrapper around RiskResolver and PolicyEngine contract.
- `src/worker.mjs` — construct AgentEngine, register existing UI tools, expose unified routes and compatibility adapters.
- `src/controller.mjs` — proxy unified routes.
- `public/app.js`, `public/index.html` — one JARVIS chat/session surface and «Автономный режим» label.

---

### Task 1: Canonical state hashing and event contract

**Files:**
- Create: `src/canonical-json.mjs`
- Create: `src/session-events.mjs`
- Test: `test/session-events.test.mjs`

**Interfaces:**
- Produces: `canonicalJson(value): string`
- Produces: `logicalStateHash(state): string`
- Produces: `createSessionEvent(input): SessionEvent`
- Produces: `validateSessionEvent(event, previousSequence): SessionEvent`

- [ ] **Step 1: Write failing canonicalization tests**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, logicalStateHash } from '../src/canonical-json.mjs';

test('canonical state hash is independent of object insertion order', () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  assert.equal(logicalStateHash({ b: 2, a: 1 }), logicalStateHash({ a: 1, b: 2 }));
});

test('canonical state rejects non-finite values', () => {
  assert.throws(() => canonicalJson({ confidence: Number.NaN }), /finite JSON number/);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/session-events.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/canonical-json.mjs`.

- [ ] **Step 3: Implement canonical JSON and SHA-256**

```js
// src/canonical-json.mjs
import { createHash } from 'node:crypto';

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON requires a finite JSON number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('Canonical JSON accepts only JSON values.');
  }
  const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(',')}}`;
}

export function logicalStateHash(state) {
  return createHash('sha256').update(canonicalJson(state), 'utf8').digest('hex');
}
```

- [ ] **Step 4: Add failing event-schema tests**

```js
import { createSessionEvent, validateSessionEvent } from '../src/session-events.mjs';

test('tool lifecycle events require toolInvocationId', () => {
  assert.throws(() => createSessionEvent({
    sessionId: 's1', sequence: 1, type: 'tool.requested', payload: { tool: 'ui.click' }, stateHash: 'a'.repeat(64)
  }), /toolInvocationId/);
});

test('event sequence must be contiguous', () => {
  const event = createSessionEvent({
    sessionId: 's1', sequence: 3, type: 'session.started', payload: {}, stateHash: 'a'.repeat(64)
  });
  assert.throws(() => validateSessionEvent(event, 1), /expected sequence 2/);
});
```

- [ ] **Step 5: Implement strict event construction**

`createSessionEvent` must accept only `schemaVersion`, `sessionId`, `sequence`, `type`, `causationId`, `toolInvocationId`, `at`, `payload` and `stateHash`; tool lifecycle types require `toolInvocationId`; `stateHash` must be 64 lowercase hex characters; sequence starts at 1 and is contiguous.

- [ ] **Step 6: Run focused tests and commit**

Run: `node --test test/session-events.test.mjs`

Expected: all tests PASS.

Commit: `git commit -m "feat: define canonical JARVIS session events"`

---

### Task 2: Session reducer, append-only store and snapshots

**Files:**
- Create: `src/session-reducer.mjs`
- Create: `src/session-store.mjs`
- Test: `test/session-reducer.test.mjs`
- Test: `test/session-store.test.mjs`

**Interfaces:**
- Consumes: `createSessionEvent`, `validateSessionEvent`, `logicalStateHash`
- Produces: `createInitialSessionState({ sessionId, goal, mode, surface }): AgentSessionState`
- Produces: `reduceSessionEvent(state, event): AgentSessionState`
- Produces: `new SessionStore({ directory, snapshotEvery = 100 })`
- Produces: `SessionStore.start({ sessionId, goal, mode, surface }): Promise<{event,state}>`
- Produces: `SessionStore.append(sessionId, draftEvent): Promise<{event,state}>`
- Produces: `SessionStore.load(sessionId): Promise<{state,events}>`

- [ ] **Step 1: Write reducer RED tests**

```js
test('new user goal cannot inherit an unfinished previous goal', () => {
  const first = createInitialSessionState({ sessionId: 's1', goal: 'Старая задача', mode: 'guided', surface: null });
  const second = createInitialSessionState({ sessionId: 's2', goal: 'Привет кто ты?', mode: 'chat', surface: null });
  assert.equal(second.goal, 'Привет кто ты?');
  assert.equal(second.pendingCriteria.length, 0);
  assert.doesNotMatch(JSON.stringify(second), /Старая задача/);
});

test('reducer records tool lifecycle without executing effects', () => {
  const state = createInitialSessionState({ sessionId: 's1', goal: 'Нажми кнопку', mode: 'guided', surface: null });
  const next = reduceSessionEvent(state, { type: 'tool.dispatched', toolInvocationId: 't1', payload: { tool: 'ui.click' } });
  assert.equal(next.tools.t1.status, 'dispatched');
});
```

- [ ] **Step 2: Verify reducer tests fail, then implement pure reducer**

Run: `node --test test/session-reducer.test.mjs`

Expected RED: missing module. Implement without filesystem, clocks or model calls. Freeze returned top-level state in tests to catch accidental mutation.

- [ ] **Step 3: Write store recovery RED test**

```js
test('store restores identical state from log and verified snapshot', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-session-'));
  const store = new SessionStore({ directory, snapshotEvery: 2 });
  await store.start({ sessionId: 's1', goal: 'Задача', mode: 'guided', surface: null });
  await store.append('s1', { type: 'user.message', payload: { text: 'уточнение' } });
  const before = await store.load('s1');
  const reopened = await new SessionStore({ directory, snapshotEvery: 2 }).load('s1');
  assert.deepEqual(reopened.state, before.state);
});
```

- [ ] **Step 4: Implement serialized append and verified snapshots**

Use one promise tail per `sessionId`. Append the event only after calculating the next reduced state and its hash. Write snapshots through `<sequence>.json.tmp` followed by atomic rename. On load, validate snapshot hash, then replay later events. Reject gaps, duplicate sequence values and mismatched hashes.

- [ ] **Step 5: Add corrupt-log tests**

Cover truncated final line, sequence gap and changed payload with stale stateHash. A truncated final line may be quarantined only if no effect event is lost; any other mismatch must return `session_corrupt` and never start a new goal in the same directory.

- [ ] **Step 6: Run focused tests and commit**

Run: `node --test test/session-reducer.test.mjs test/session-store.test.mjs`

Commit: `git commit -m "feat: persist deterministic JARVIS sessions"`

---

### Task 3: ContextCompiler and compaction contract

**Files:**
- Create: `src/context-compiler.mjs`
- Test: `test/context-compiler.test.mjs`

**Interfaces:**
- Consumes: reduced AgentSession state and ordered events.
- Produces: `compileAgentContext({ state, events, contextWindowTokens, estimateTokens }): CompiledContext`
- Produces: `new ContextCompiler({ contextWindowTokens, estimateTokens })` with `compile({ state, events }): CompiledContext`
- Produces: `contextUsage` with `inputBudget`, `outputReserve`, `recoveryReserve` and `estimatedInputTokens`.

- [ ] **Step 1: Write pinned-context RED tests**

```js
test('compiler never removes goal, pending criteria or last tool result', () => {
  const compiled = compileAgentContext({
    state: {
      sessionId: 's1', goal: 'Создать документ', mode: 'guided', surface: null,
      pendingCriteria: ['Документ виден'], corrections: [], hypothesis: null,
      lastObservation: { sha256: 'screen-1' },
      lastToolResult: { toolInvocationId: 'tool-last', tool: 'observe.display', ok: true },
      versions: { protocol: 1, model: 'test-model' }
    },
    events: Array.from({ length: 200 }, (_, index) => ({
      sequence: index + 1, type: 'diagnostic.note', payload: { text: `noise-${index}` }
    })),
    contextWindowTokens: 8_192,
    estimateTokens: (value) => Math.ceil(JSON.stringify(value).length / 4)
  });
  assert.equal(compiled.pinned.goal, 'Создать документ');
  assert.deepEqual(compiled.pinned.pendingCriteria, ['Документ виден']);
  assert.equal(compiled.pinned.lastToolResult.toolInvocationId, 'tool-last');
  assert.ok(compiled.contextUsage.estimatedInputTokens <= Math.floor(8_192 * 0.65));
});
```

- [ ] **Step 2: Verify RED and implement deterministic selection**

Context order is fixed: protocol version → goal/mode/surface → pending criteria → user corrections → current hypothesis → latest observation → latest ToolResult → relevant verified memory → bounded recent events → compaction references.

- [ ] **Step 3: Add contamination and reproducibility tests**

Compile the same state twice and assert deep equality. Create a second session with `Привет кто ты?` and assert no old CorelDRAW error text appears. Assert compaction references contain exact `fromSequence` and `toSequence` values.

- [ ] **Step 4: Run focused tests and commit**

Run: `node --test test/context-compiler.test.mjs`

Commit: `git commit -m "feat: compile bounded deterministic agent context"`

---

### Task 4: InputLease and shared-session cancellation

**Files:**
- Create: `src/input-arbiter.mjs`
- Create: `src/windows-user-activity.mjs`
- Create: `scripts/user-activity.ps1`
- Modify: `src/pointer-bridge.mjs`
- Modify: `scripts/pointer-bridge.ps1`
- Test: `test/input-arbiter.test.mjs`
- Modify: `test/pointer-bridge-powershell.test.mjs`

**Interfaces:**
- Produces: `readWindowsUserActivity(scriptPath): Promise<{sequence,lastInputTick,cursor,focusedWindowHandle}>`
- Produces: `new InputArbiter({ activityProvider, now, ttlMs = 250 })`
- Produces: `InputArbiter.acquire(surface): Promise<InputLease>`
- Produces: `InputArbiter.validate(lease, surface): Promise<{valid,reason}>`
- Extends: `createBoundedPointerRequest` with required `inputLease` only when `executionSurface.mode === 'shared'` and the selected transport may use physical input.

- [ ] **Step 1: Write lease expiry and race RED tests**

```js
test('lease is rejected when user activity changes before dispatch', async () => {
  let sequence = 4;
  const arbiter = new InputArbiter({ activityProvider: async () => ({ sequence }), now: () => 1_000, ttlMs: 250 });
  const lease = await arbiter.acquire({ id: 'display-1', mode: 'shared' });
  sequence = 5;
  assert.deepEqual(await arbiter.validate(lease, { id: 'display-1', mode: 'shared' }), {
    valid: false, reason: 'user_activity_changed'
  });
});

test('lease cannot be reused for another surface', async () => {
  const arbiter = new InputArbiter({ activityProvider: async () => ({ sequence: 1 }), now: () => 1_000 });
  const lease = await arbiter.acquire({ id: 'display-1', mode: 'shared' });
  assert.equal((await arbiter.validate(lease, { id: 'display-2', mode: 'shared' })).valid, false);
});
```

- [ ] **Step 2: Implement Windows activity snapshot**

`scripts/user-activity.ps1` calls Win32 `GetLastInputInfo`, reads cursor position and focused top-level handle, then emits one compact JSON object. `src/windows-user-activity.mjs` invokes it with a 2-second timeout and derives a stable sequence from `lastInputTick`, cursor and focus.

- [ ] **Step 3: Implement InputArbiter and verify RED becomes GREEN**

Lease fields: `leaseId`, `surfaceId`, `userActivitySequence`, `issuedAtMs`, `expiresAtMs`. Validation rejects expired, consumed, wrong-surface or changed-activity leases. A lease is consumed immediately before an effect dispatch.

- [ ] **Step 4: Add bridge checks**

PowerShell must validate lease expiry and `lastInputTick` immediately before the first effect. During drag trajectory and multi-character fallback typing, recheck activity before every subsequent event; on change, release pressed mouse/modifier state in `finally`, return `user_activity_during_action`, and perform no remaining events.

- [ ] **Step 5: Run focused tests and commit**

Run: `node --test test/input-arbiter.test.mjs test/pointer-bridge-powershell.test.mjs`

Commit: `git commit -m "feat: cancel shared input through short leases"`

---

### Task 5: RiskResolver, invocation ledger and ToolRegistry

**Files:**
- Create: `src/risk-resolver.mjs`
- Create: `src/tool-invocation-ledger.mjs`
- Create: `src/tool-registry.mjs`
- Test: `test/risk-resolver.test.mjs`
- Test: `test/tool-registry.test.mjs`

**Interfaces:**
- Produces: `resolveToolRisk(manifest, args): RiskClass`
- Produces: `new ToolInvocationLedger({ eventStore })`
- Produces: `new ToolRegistry({ ledger, policy, inputArbiter })`
- Produces: `ToolRegistry.register(manifest, handler)`
- Produces: `ToolRegistry.executeBatch({ sessionId, calls, surface }): Promise<ToolResult[]>`

- [ ] **Step 1: Write deterministic-risk RED tests**

```js
test('model cannot lower manifest risk', () => {
  const manifest = { name: 'code.apply', risk: 'persistent_local' };
  assert.equal(resolveToolRisk(manifest, { modelRisk: 'read_only' }), 'persistent_local');
});

test('ambiguous tool arguments upgrade to stricter risk', () => {
  const manifest = { name: 'ui.click', risk: 'reversible_local', resolveRisk: () => null };
  assert.equal(resolveToolRisk(manifest, { target: null }), 'external_or_destructive');
});
```

- [ ] **Step 2: Implement risk ranking and PolicyEngine adapter**

Use exactly `read_only`, `reversible_local`, `persistent_local`, `external_or_destructive`. Keep legacy `read_only`, `local_change`, `external_effect`, `dangerous` mapping only inside `src/action-policy.mjs` until compatibility routes are removed.

- [ ] **Step 3: Write idempotency RED tests**

```js
test('completed invocation returns cached result without repeating effect', async () => {
  const isolatedSurface = { id: 'surface-1', mode: 'isolated' };
  let executions = 0;
  registry.register({ name: 'test.effect', risk: 'reversible_local', idempotency: 'at_most_once' }, async () => {
    executions += 1;
    return { ok: true };
  });
  const call = { toolInvocationId: 't1', name: 'test.effect', arguments: {} };
  await registry.executeBatch({ sessionId: 's1', calls: [call], surface: isolatedSurface });
  await registry.executeBatch({ sessionId: 's1', calls: [call], surface: isolatedSurface });
  assert.equal(executions, 1);
});
```

- [ ] **Step 4: Implement lifecycle and deterministic parallel commit order**

Assign `dispatchIndex` before starting handlers. Run only manifests marked `readOnly: true` concurrently. Buffer their results and append `tool.completed` in ascending `dispatchIndex`. Writes and UI effects execute sequentially. A `dispatched` at-most-once invocation recovered after a crash returns `indeterminate` and never invokes the handler automatically.

- [ ] **Step 5: Run focused tests and commit**

Run: `node --test test/risk-resolver.test.mjs test/tool-registry.test.mjs`

Commit: `git commit -m "feat: execute typed tools with deterministic idempotency"`

---

### Task 6: Unified model protocol and AgentEngine

**Files:**
- Create: `src/agent-model-protocol.mjs`
- Create: `src/agent-engine.mjs`
- Create: `test/helpers/agent-fixture.mjs`
- Modify: `src/config.mjs`
- Modify: `src/lmstudio-client.mjs`
- Test: `test/agent-model-protocol.test.mjs`
- Test: `test/agent-engine.test.mjs`

**Interfaces:**
- Produces: `UNIFIED_AGENT_SYSTEM_PROMPT`
- Produces: `normalizeAgentDecision(value): ToolDecision | FinalDecision | UserQuestionDecision`
- Produces: `new AgentEngine({ sessionStore, contextCompiler, modelClient, toolRegistry, activeModel })`
- Produces: `AgentEngine.start({ goal, mode, surface }): Promise<AgentSessionState>`
- Produces: `AgentEngine.next(sessionId): Promise<AgentTurnResult>`
- Produces: `AgentEngine.message(sessionId, text): Promise<AgentTurnResult>`
- Produces: `AgentEngine.stop(sessionId, reason): Promise<AgentSessionState>`

- [ ] **Step 1: Write one-protocol RED tests**

```js
test('decision schema accepts one tool call or final result but no role switch', () => {
  assert.deepEqual(normalizeAgentDecision({
    type: 'tool_call', tool: 'repo.search', arguments: { query: 'sendTeacherMessage' }, reason: 'Find caller'
  }).tool, 'repo.search');
  assert.throws(() => normalizeAgentDecision({ type: 'delegate', role: 'critic' }), /unsupported decision type/);
});
```

- [ ] **Step 2: Add one active model to config**

Add `activeModel = AI_WORKSTATION_ACTIVE_MODEL || AI_WORKSTATION_LM_STUDIO_MODEL || 'qwen/qwen3-vl-8b'`. During migration expose old model fields as exact aliases of `activeModel`; add a test asserting all five aliases are equal even when old role environment variables conflict.

- [ ] **Step 3: Write AgentEngine RED test with fake model and real ToolRegistry**

```js
// test/helpers/agent-fixture.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentEngine } from '../../src/agent-engine.mjs';
import { SessionStore } from '../../src/session-store.mjs';
import { ToolInvocationLedger } from '../../src/tool-invocation-ledger.mjs';
import { ToolRegistry } from '../../src/tool-registry.mjs';

export async function createAgentFixture({ modelClient }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-agent-'));
  const sessionStore = new SessionStore({ directory });
  const ledger = new ToolInvocationLedger({ eventStore: sessionStore });
  const toolRegistry = new ToolRegistry({ ledger, policy: { authorize: () => ({ allowed: true }) }, inputArbiter: null });
  toolRegistry.register({ name: 'test.read', risk: 'read_only', readOnly: true, idempotency: 'retryable' }, async () => ({ ok: true }));
  return new AgentEngine({
    sessionStore,
    contextCompiler: {
      compile: ({ state }) => ({
        pinned: { goal: state.goal, lastToolResult: state.lastToolResult || null },
        contextUsage: { estimatedInputTokens: 1 }
      })
    },
    modelClient,
    toolRegistry,
    activeModel: 'test-model'
  });
}

// test/agent-engine.test.mjs
test('same session returns tool result to the same model context', async () => {
  const isolatedSurface = { id: 'surface-1', mode: 'isolated' };
  const seen = [];
  const modelClient = async (context) => {
    seen.push(context);
    return seen.length === 1
      ? { type: 'tool_call', tool: 'test.read', arguments: {}, reason: 'Inspect' }
      : { type: 'final', status: 'completed', summary: 'Готово', evidence: ['visible'] };
  };
  const engine = await createAgentFixture({ modelClient });
  const session = await engine.start({ goal: 'Проверь', mode: 'guided', surface: isolatedSurface });
  await engine.next(session.sessionId);
  await engine.next(session.sessionId);
  assert.equal(seen[1].pinned.goal, 'Проверь');
  assert.equal(seen[1].pinned.lastToolResult.tool, 'test.read');
});
```

- [ ] **Step 4: Implement one-turn-at-a-time engine**

Serialize `next` calls per session. The engine, not the model, creates `decisionId` and `toolInvocationId`. Append `model.requested`, `model.decided`, tool lifecycle events and final result. A format repair may call the same active model once with the schema error; it does not create another role.

- [ ] **Step 5: Add stop, restart and stale-goal tests**

Verify Stop aborts the current LM Studio request, appends `session.cancelled`, and prevents queued tools. Reopen store and continue the same session. Start a new chat session and prove no previous goal or last error enters its compiled context.

- [ ] **Step 6: Run focused tests and commit**

Run: `node --test test/agent-model-protocol.test.mjs test/agent-engine.test.mjs test/lmstudio-cancellation.test.mjs`

Commit: `git commit -m "feat: add single-model JARVIS agent engine"`

---

### Task 7: Repository and candidate-code tools

**Files:**
- Create: `src/repository-tools.mjs`
- Create: `src/code-candidate.mjs`
- Modify: `src/teacher-chat.mjs`
- Modify: `src/self-improvement.mjs`
- Modify: `src/worker.mjs`
- Test: `test/repository-tools.test.mjs`
- Test: `test/code-candidate.test.mjs`

**Interfaces:**
- Produces tools: `repo.index`, `repo.search`, `repo.read`, `repo.diff`
- Produces tools: `code.createCandidate`, `code.patch`, `code.test`, `code.compare`, `code.apply`, `code.rollback`
- Produces: `createCodeCandidate({ projectRoot, candidateRoot, proposalId })`
- Produces: `runCandidateTests(candidateRoot)`
- Reuses: `compareCandidateRuns`, backup and rollback behavior from `src/self-improvement.mjs`.

- [ ] **Step 1: Write bounded repository RED tests**

```js
test('repo search reads the real call path and never escapes project root', async () => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-repo-'));
  await fs.mkdir(path.join(fixtureRoot, 'public'), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(fixtureRoot, 'public', 'app.js'), 'function sendTeacherMessage() {}\n', 'utf8');
  const tools = createRepositoryTools({ projectRoot: fixtureRoot });
  const result = await tools.search({ query: 'sendTeacherMessage', paths: ['public', 'src'] });
  assert.match(result.matches[0].path, /public\/app\.js/);
  await assert.rejects(() => tools.read({ path: '../secret.txt' }), /outside project root/);
});
```

- [ ] **Step 2: Implement index/search/read with `rg`**

Exclude `.git`, `node_modules`, runtime binaries, artifacts and model files. Return bounded line ranges with file hash, not arbitrary 3500-character snippets. `repo.index` returns paths plus sizes; `repo.search` returns exact lines and caller-selected context; `repo.read` accepts explicit start/end lines.

- [ ] **Step 3: Write candidate RED test**

Create a fixture project whose test initially fails. Apply an exact-search patch only inside its candidate directory, run `node --test`, compare baseline/candidate and assert the source fixture remains unchanged.

- [ ] **Step 4: Extract candidate lifecycle from worker**

Move reusable sandbox/test/apply/rollback functions from `src/worker.mjs` into `src/code-candidate.mjs`. Keep thin imports in worker so existing `/teacher/code/apply` and rollback endpoints continue working during migration.

- [ ] **Step 5: Register programmer tools with strict risk**

Repository reads are `read_only`; candidate patch/test are `reversible_local`; applying to project is `persistent_local`; Git publishing is not registered in stages 1–2. `code.apply` requires `confirmed: true`, passing candidate comparison and no base drift.

- [ ] **Step 6: Run focused tests and commit**

Run: `node --test test/repository-tools.test.mjs test/code-candidate.test.mjs test/jarvis-2.test.mjs`

Commit: `git commit -m "feat: expose tested repository tools to JARVIS"`

---

### Task 8: Worker, Controller and frontend compatibility migration

**Files:**
- Modify: `src/worker.mjs`
- Modify: `src/controller.mjs`
- Modify: `public/app.js`
- Modify: `public/index.html`
- Modify: `public/styles.css`
- Modify: `test/api-route-contract.test.mjs`
- Modify: `test/programmer-ui.test.mjs`
- Create: `test/unified-agent-routes.test.mjs`

**Interfaces:**
- Add worker/controller routes:
  - `POST /agent/sessions` and `/api/agent/sessions`
  - `POST /agent/sessions/next` and `/api/agent/sessions/next`
  - `POST /agent/sessions/message` and `/api/agent/sessions/message`
  - `POST /agent/sessions/stop` and `/api/agent/sessions/stop`
  - `GET /agent/sessions/status` and `/api/agent/sessions/status`
- Existing `/missions*` and `/teacher/chat` remain adapters until UI migration is verified.

- [ ] **Step 1: Write route-contract RED test**

```js
test('controller forwards every unified AgentSession route', async () => {
  const controller = await fs.readFile(new URL('../src/controller.mjs', import.meta.url), 'utf8');
  for (const route of ['/agent/sessions', '/agent/sessions/next', '/agent/sessions/message', '/agent/sessions/stop', '/agent/sessions/status']) {
    assert.match(controller, new RegExp(`callWorker\\(['"]${route.replaceAll('/', '\\/')}['"]`));
  }
});
```

- [ ] **Step 2: Construct the engine once in worker**

Register existing observation and action functions as tools through closures; do not duplicate their implementations. Expose one `activeModel`, active session count and event-log health in `/health`. Keep `ModelBroker` disabled for unified sessions and remove it only after all legacy model calls are migrated.

- [ ] **Step 3: Add compatibility adapters**

`/missions` creates a `guided` AgentSession. `/teacher/chat` without an existing session creates `chat` or `programmer` based on explicit frontend mode, never keyword history. `/teacher/chat` no longer starts internet automatically; `web.search` is a model-selected tool. Existing response fields remain until frontend stops reading them.

- [ ] **Step 4: Migrate frontend to one session identity**

Replace separate `currentMission`, `currentTeacherTask` and teacher chat state with `currentAgentSessionId` for new calls. The main task input and programmer chat send messages to the same JARVIS API with different explicit modes. Rename button and copy from «Анархичность» to «Автономный режим» while sending canonical mode `autonomous`; accept legacy `anarchy` only on backend adapters.

- [ ] **Step 5: Add greeting regression test**

Use a fake model and fake web tool. Send an old failed UI session followed by a new chat session containing `привет кто ты?`. Assert the second model context excludes the old error and the web tool execution count remains zero.

- [ ] **Step 6: Run cross-stage tests and commit**

Run: `node --test test/api-route-contract.test.mjs test/programmer-ui.test.mjs test/unified-agent-routes.test.mjs test/agent-engine.test.mjs`

Commit: `git commit -m "feat: route UI and programmer work through unified JARVIS"`

---

### Task 9: Model benchmark gate, replay and rollout verification

**Files:**
- Create: `scripts/benchmark-unified-model.mjs`
- Create: `src/unified-model-benchmark.mjs`
- Create: `test/unified-model-benchmark.test.mjs`
- Modify: `src/config.mjs`
- Modify: `src/worker.mjs`
- Modify: `README.md`
- Modify: `docs/architecture.md`

**Interfaces:**
- Produces: `scoreUnifiedModelCases(cases): BenchmarkSummary`
- Consumes case manifest: `D:\AI-Work\Agent-Data\Evaluations\UnifiedModel\cases.jsonl`
- Writes report: `D:\AI-Work\Agent-Data\Evaluations\UnifiedModel\latest-report.json`
- Adds health fields: `unifiedAgent.modelBenchmark.status`, `model`, `caseCounts`, `thresholds`, `reportPath`.

- [ ] **Step 1: Write scoring RED tests**

```js
test('benchmark gate fails when any session contaminates the next goal', () => {
  const summary = scoreUnifiedModelCases([
    { category: 'session_isolation', passed: false },
    ...Array.from({ length: 99 }, () => ({ category: 'structured_output', passed: true }))
  ]);
  assert.equal(summary.passed, false);
  assert.ok(summary.failures.includes('session_contamination'));
});
```

- [ ] **Step 2: Implement exact thresholds from the design**

Gate requires: 98/100 first-pass structured responses and 100/100 after one format repair; 27/30 correct UI tool choices and 24/30 correct grounding decisions; 7/10 correct defect owners and 6/10 passing candidates; 0 session contamination cases.

- [ ] **Step 3: Implement benchmark runner**

The runner reads only manifest-referenced screenshots, event ranges and error packets. It records model name, quantization reported by LM Studio when available, context size, code commit, prompt version, per-case latency and raw decision hash. It never executes UI effects or applies code.

- [ ] **Step 4: Add rollout gate**

`AI_WORKSTATION_UNIFIED_AGENT=1` may expose unified routes in evaluation mode, but state-changing unified tools remain disabled until the latest report matches `activeModel`, current protocol version and passing thresholds. Legacy routes remain available for comparison until the user completes local verification.

- [ ] **Step 5: Run complete automated verification**

Run: `node --test`

Expected: zero failures, zero cancelled tests.

Run: `node scripts/benchmark-unified-model.mjs --manifest "D:\AI-Work\Agent-Data\Evaluations\UnifiedModel\cases.jsonl" --dry-run`

Expected: manifest validation report with exactly 100 structured, 30 UI and 10 code cases, plus at least one session-isolation case; no model call in dry-run mode.

- [ ] **Step 6: Perform replay verification**

Run: `node scripts/evaluate-replay.mjs`

Record results under `D:\AI-Work\Agent-Data\Evaluations` and label them `replay`, not `live`.

- [ ] **Step 7: Perform bounded live verification with the user**

Test A: new chat `привет кто ты?` — no internet call and no previous mission text.

Test B: one reversible UI click on the assigned monitor — verify event order, fresh observation, InputLease behavior and visible result.

Test C: report one seeded Worker defect — JARVIS must use repo tools, create a failing test, patch only a candidate, run tests and show diff without modifying the working project.

Stop after each test for user confirmation. Mark any unperformed check `not verified`; do not infer success from source or unit tests.

- [ ] **Step 8: Commit documentation and benchmark harness**

Commit: `git commit -m "test: gate unified JARVIS with replay benchmarks"`

---

## Final verification checklist

- [ ] `node --test` passes with no failures or cancellations.
- [ ] Event replay reconstructs identical stateHash after process restart.
- [ ] Parallel read-only tools commit by dispatchIndex.
- [ ] Completed toolInvocationId never repeats an effect.
- [ ] Indeterminate physical UI action observes before replanning.
- [ ] Shared-session activity invalidates InputLease and stops remaining input.
- [ ] RiskResolver ignores model attempts to lower risk.
- [ ] New chat contains no previous mission goal or error.
- [ ] Exactly one active model is visible in health and runtime logs.
- [ ] Programmer flow reads repository through tools, not six heuristic snippets.
- [ ] Working code changes only after candidate tests and explicit confirmation.
- [ ] Live, replay and automated evidence are reported separately.
