import fs from 'node:fs/promises';
import path from 'node:path';

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

export function summarizeReplayCases(cases = []) {
  const normalized = cases.filter((item) => item && typeof item === 'object').map((item) => ({
    success: item.success === true,
    wrongAction: item.wrongAction === true,
    falsePositive: item.falsePositive === true,
    modelCalls: Math.max(0, Number(item.modelCalls) || 0),
    latencyMs: Math.max(0, Number(item.latencyMs) || 0)
  }));
  const total = normalized.length;
  const sum = (key) => normalized.reduce((value, item) => value + item[key], 0);
  return {
    cases: total,
    successes: normalized.filter((item) => item.success).length,
    successRate: total ? normalized.filter((item) => item.success).length / total : 0,
    wrongActions: normalized.filter((item) => item.wrongAction).length,
    falsePositives: normalized.filter((item) => item.falsePositive).length,
    averageModelCalls: total ? sum('modelCalls') / total : 0,
    averageLatencyMs: total ? sum('latencyMs') / total : 0,
    p95LatencyMs: percentile(normalized.map((item) => item.latencyMs), 0.95)
  };
}

export function compareReplayEvaluations(baselineCases, candidateCases, { maximumLatencyRegression = 0.2 } = {}) {
  const baseline = summarizeReplayCases(baselineCases);
  const candidate = summarizeReplayCases(candidateCases);
  const reasons = [];
  const caseIds = (cases) => cases.map((item, index) =>
    typeof item?.id === 'string' && item.id ? item.id : `index:${index}`);
  const sameCaseSet = JSON.stringify(caseIds(baselineCases)) === JSON.stringify(caseIds(candidateCases));
  if (candidate.cases !== baseline.cases || candidate.cases === 0 || !sameCaseSet) reasons.push('case_set_mismatch');
  if (candidate.successRate < baseline.successRate) reasons.push('success_rate_regressed');
  if (candidate.wrongActions > baseline.wrongActions) reasons.push('wrong_actions_increased');
  if (candidate.falsePositives > baseline.falsePositives) reasons.push('validation_false_positives_increased');
  if (candidate.averageModelCalls > baseline.averageModelCalls && candidate.successRate <= baseline.successRate) reasons.push('model_calls_increased_without_quality_gain');
  if (baseline.p95LatencyMs > 0 && candidate.p95LatencyMs > baseline.p95LatencyMs * (1 + maximumLatencyRegression) &&
      candidate.successRate <= baseline.successRate) reasons.push('latency_regressed_without_quality_gain');
  return {
    acceptable: reasons.length === 0,
    reasons,
    baseline,
    candidate,
    deltas: {
      successRate: candidate.successRate - baseline.successRate,
      wrongActions: candidate.wrongActions - baseline.wrongActions,
      falsePositives: candidate.falsePositives - baseline.falsePositives,
      averageModelCalls: candidate.averageModelCalls - baseline.averageModelCalls,
      p95LatencyMs: candidate.p95LatencyMs == null || baseline.p95LatencyMs == null ? null : candidate.p95LatencyMs - baseline.p95LatencyMs
    }
  };
}

export async function writeReplayEvaluation(directory, evaluation, name = 'latest') {
  await fs.mkdir(directory, { recursive: true });
  const safeName = String(name).replace(/[^a-z0-9._-]/gi, '-').slice(0, 100) || 'latest';
  const outputPath = path.join(directory, `${safeName}.json`);
  await fs.writeFile(outputPath, `${JSON.stringify({
    evidenceType: 'replay',
    liveVerified: false,
    ...evaluation,
    evaluatedAt: new Date().toISOString()
  }, null, 2)}\n`, 'utf8');
  return outputPath;
}
