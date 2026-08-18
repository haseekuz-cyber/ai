import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const ERROR_PACKET_SCHEMA_VERSION = 1;
const SECRET_KEY = /token|authorization|cookie|password|secret|api[-_]?key/i;
const TEXT_ACTION_KEYS = new Set(['text', 'value', 'content', 'typedText']);

function shortText(value, maximum = 1_000) {
  if (value == null) return null;
  return String(value).replace(/\s+/g, ' ').trim().slice(0, maximum) || null;
}

function stableHash(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function sanitize(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return shortText(value, 2_000);
  if (typeof value !== 'object' || depth > 6) return null;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => sanitize(item, depth + 1, seen));
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 80)) {
    if (SECRET_KEY.test(key)) {
      result[key] = '[redacted]';
      continue;
    }
    if (TEXT_ACTION_KEYS.has(key) && typeof item === 'string') {
      result[key] = { redacted: true, length: item.length, sha256: stableHash(item) };
      continue;
    }
    result[key] = sanitize(item, depth + 1, seen);
  }
  return result;
}

export function classifyWorkerError(error, context = {}) {
  const code = shortText(error?.code || context.code || 'worker_error', 120) || 'worker_error';
  const message = shortText(error?.message || error, 1_000) || 'Unknown worker error.';
  const combined = `${code} ${message}`.toLowerCase();
  if (/capture|powershell|command failed|enoent|eaddr|network|timeout.*server/.test(combined)) return 'infrastructure';
  if (/json|schema|truncat|context size|invalid_local_plan|point must be/.test(combined)) return 'model_protocol';
  if (/ground|visual target|editable target|outside the ai display|confidence/.test(combined)) return 'grounding';
  if (/stale|window changed|document changed|process changed|fresh/.test(combined)) return 'state_change';
  if (/validation|expected result|no.change|result/.test(combined)) return 'validation';
  if (/pointer|uia|executor|physical action|click|drag|type/.test(combined)) return 'executor';
  return 'unknown';
}

export function buildErrorPacket(error, context = {}) {
  const category = classifyWorkerError(error, context);
  const phase = shortText(context.phase || 'request', 80) || 'request';
  const code = shortText(error?.code || context.code || 'worker_error', 120) || 'worker_error';
  const message = shortText(error?.message || error, 1_000) || 'Unknown worker error.';
  const fingerprintSource = [category, phase, code, context.action?.type, context.application?.processName]
    .map((item) => String(item || '').toLowerCase()).join('|');
  return {
    schemaVersion: ERROR_PACKET_SCHEMA_VERSION,
    errorId: randomUUID(),
    occurredAt: new Date().toISOString(),
    fingerprint: stableHash(fingerprintSource).slice(0, 24),
    category,
    phase,
    error: {
      code,
      message,
      retryable: context.retryable === true
    },
    mission: sanitize(context.mission ? {
      missionId: context.mission.missionId,
      mode: context.mission.mode,
      status: context.mission.status,
      stepCount: context.mission.stepCount,
      instruction: context.mission.instruction
    } : null),
    application: sanitize(context.application || null),
    window: sanitize(context.window || null),
    action: sanitize(context.action || null),
    expectedResult: shortText(context.expectedResult, 1_000),
    actualResult: shortText(context.actualResult, 1_000),
    evidence: sanitize(context.evidence || null),
    versions: sanitize(context.versions || null),
    telemetry: sanitize(context.telemetry || null)
  };
}

export function agentTurnFailureInput(result) {
  // Only an operational stall — the engine's no-progress guard ending the session — is a
  // worker error worth surfacing to the "fix latest error" flow. A model's own `final`
  // failed conclusion is a reasoned outcome, not a fault, and a poll that merely re-reads
  // an already-terminal session carries no decisionId; both are deliberately excluded so
  // the error journal stays honest instead of filling with non-faults.
  if (result?.kind !== 'terminal' || !result?.decisionId) return null;
  const state = result.state || null;
  if (!state || state.status !== 'failed' || !state.terminalReason) return null;
  const surface = state.surface || null;
  return {
    error: { code: 'agent_session_stalled', message: state.terminalReason },
    context: {
      phase: 'agent_session',
      mission: { missionId: state.sessionId, mode: state.mode, status: state.status, instruction: state.goal },
      window: surface
        ? { title: surface.name ?? null, nativeWindowHandle: surface.windowHandle ?? null, processId: surface.processId ?? null }
        : null,
      actualResult: state.lastToolResult?.error?.message ?? null,
      versions: state.versions ?? null
    }
  };
}

export async function persistErrorPacket(directory, packet) {
  if (!directory) throw new TypeError('Error packet directory is required.');
  if (!packet?.errorId || !packet?.fingerprint) throw new TypeError('A normalized ErrorPacket is required.');
  await fs.mkdir(directory, { recursive: true });
  const outputPath = path.join(directory, `${packet.occurredAt.replace(/[:.]/g, '-')}-${packet.errorId}.json`);
  await fs.writeFile(outputPath, `${JSON.stringify(packet, null, 2)}\n`, 'utf8');
  return outputPath;
}

export async function listErrorPackets(directory, { limit = 50 } = {}) {
  try {
    const names = (await fs.readdir(directory)).filter((name) => name.endsWith('.json')).sort().reverse().slice(0, limit);
    const packets = [];
    for (const name of names) {
      try { packets.push(JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'))); } catch { }
    }
    return packets;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
