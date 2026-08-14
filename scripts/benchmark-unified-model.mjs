import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { normalizeAgentDecision } from '../src/agent-model-protocol.mjs';
import { config } from '../src/config.mjs';
import { createLmStudioAgentClient, getLmStudioStatus } from '../src/lmstudio-client.mjs';
import {
  scoreUnifiedModelCases,
  validateUnifiedModelManifest
} from '../src/unified-model-benchmark.mjs';

const execFileAsync = promisify(execFile);
const protocolVersion = 1;
const promptVersion = 1;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function readManifest(filePath) {
  const text = await fs.readFile(filePath, 'utf8');
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : parsed.cases;
  } catch {
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function buildCaseContext(item) {
  let context = item.context && typeof item.context === 'object' ? structuredClone(item.context) : {};
  if (item.contextPath) context = await readJson(item.contextPath);
  if (item.eventLogPath) {
    const events = (await fs.readFile(item.eventLogPath, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const from = Number(item.eventRange?.from) || 1;
    const to = Number(item.eventRange?.to) || Number.MAX_SAFE_INTEGER;
    context.recentEvents = events.filter((event) => event.sequence >= from && event.sequence <= to);
  }
  if (item.errorPacketPath) context.errorPacket = await readJson(item.errorPacketPath);
  const screenshotPath = item.screenshotPath || item.screenshotPaths?.at(-1) || null;
  context.pinned = {
    protocolVersion,
    goal: String(item.goal || context.pinned?.goal || item.prompt || ''),
    mode: String(item.mode || context.pinned?.mode || 'guided'),
    ...context.pinned,
    ...(screenshotPath ? { lastObservation: { screenshotPath } } : {})
  };
  context.availableTools = Array.isArray(item.availableTools) ? item.availableTools : (context.availableTools || []);
  return context;
}

function containsSubset(actual, expected) {
  if (expected == null) return true;
  if (typeof expected !== 'object' || Array.isArray(expected)) return Object.is(actual, expected);
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([key, value]) => containsSubset(actual[key], value));
}

function rawHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function evaluateCase(item, client) {
  const startedAt = performance.now();
  const context = await buildCaseContext(item);
  let rawDecision = null;
  let decision = null;
  let firstPass = false;
  let afterRepair = false;
  let firstError = null;
  try {
    rawDecision = await client(context, { model: config.activeModel });
    decision = normalizeAgentDecision(rawDecision);
    firstPass = true;
    afterRepair = true;
  } catch (error) {
    firstError = error.message;
    try {
      rawDecision = await client(context, {
        model: config.activeModel,
        repair: true,
        formatError: error.message
      });
      decision = normalizeAgentDecision(rawDecision);
      afterRepair = true;
    } catch { }
  }
  const result = {
    id: item.id,
    category: item.category,
    firstPass,
    afterRepair,
    latencyMs: Math.round(performance.now() - startedAt),
    rawDecisionHash: rawHash(rawDecision),
    ...(firstError ? { firstError } : {})
  };
  if (item.category === 'ui') {
    result.toolChoiceCorrect = Boolean(decision && (!item.expectedTool || decision.tool === item.expectedTool));
    result.groundingCorrect = Boolean(decision && containsSubset(decision.arguments, item.expectedArguments));
  } else if (item.category === 'code') {
    result.defectOwnerCorrect = Boolean(decision && containsSubset(decision, item.expectedDefectOwner));
    result.candidatePassed = result.defectOwnerCorrect && item.candidateValidationPassed === true;
  } else if (item.category === 'session_isolation') {
    const serialized = JSON.stringify(decision || {});
    result.passed = afterRepair && !(item.forbiddenText || []).some((value) => serialized.includes(value));
  }
  return result;
}

async function currentCommit() {
  try {
    return (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: config.projectRoot, windowsHide: true })).stdout.trim();
  } catch {
    return 'unknown';
  }
}

function reportedQuantization(status) {
  const model = (status.models || []).find((item) =>
    item.id === config.activeModel || item.key === config.activeModel || item.path === config.activeModel);
  return model?.quantization || model?.quantization_type || model?.format || null;
}

async function main() {
  const manifestPath = argument('--manifest');
  const dryRun = process.argv.includes('--dry-run');
  if (!manifestPath) {
    console.error('Usage: node scripts/benchmark-unified-model.mjs --manifest <cases.jsonl> [--dry-run]');
    process.exitCode = 2;
    return;
  }
  const resolvedManifestPath = path.resolve(manifestPath);
  let cases;
  try {
    cases = await readManifest(resolvedManifestPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.error(JSON.stringify({
      status: 'not_verified',
      reason: 'manifest_unavailable',
      manifestPath: resolvedManifestPath,
      modelCalls: 0
    }, null, 2));
    process.exitCode = 1;
    return;
  }
  const validation = validateUnifiedModelManifest(cases);
  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, modelCalls: 0, ...validation }, null, 2));
    if (!validation.valid) process.exitCode = 1;
    return;
  }
  if (!validation.valid) {
    console.error(JSON.stringify(validation, null, 2));
    process.exitCode = 1;
    return;
  }
  const status = await getLmStudioStatus({ baseUrl: config.lmStudioBaseUrl });
  if (!status.reachable) throw new Error(`LM Studio is unavailable: ${status.error}`);
  const client = createLmStudioAgentClient({ baseUrl: config.lmStudioBaseUrl });
  const evaluatedCases = [];
  for (const item of cases) evaluatedCases.push(await evaluateCase(item, client));
  const report = {
    ...scoreUnifiedModelCases(evaluatedCases),
    model: config.activeModel,
    quantization: reportedQuantization(status),
    contextSize: config.unifiedAgentContextTokens,
    codeCommit: await currentCommit(),
    protocolVersion,
    promptVersion,
    evaluatedAt: new Date().toISOString(),
    manifestPath: resolvedManifestPath,
    cases: evaluatedCases
  };
  const reportPath = path.join(path.dirname(resolvedManifestPath), 'latest-report.json');
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ...report, cases: undefined, reportPath }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

await main();
