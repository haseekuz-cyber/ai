import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const UNIFIED_MODEL_THRESHOLDS = Object.freeze({
  structuredCases: 100,
  structuredFirstPass: 98,
  structuredAfterRepair: 100,
  uiCases: 30,
  uiToolChoice: 27,
  uiGrounding: 24,
  codeCases: 10,
  codeDefectOwner: 7,
  codeCandidatePassed: 6,
  sessionContamination: 0
});

function categoryCases(cases, category) {
  return cases.filter((item) => item?.category === category);
}

function evidencePaths(item) {
  const paths = [];
  for (const field of ['screenshotPath', 'eventLogPath', 'errorPacketPath']) {
    if (typeof item?.[field] === 'string' && item[field]) paths.push({ caseId: item.id, field, path: item[field] });
  }
  for (const [index, value] of (Array.isArray(item?.screenshotPaths) ? item.screenshotPaths : []).entries()) {
    if (typeof value === 'string' && value) paths.push({ caseId: item.id, field: `screenshotPaths[${index}]`, path: value });
  }
  return paths;
}

export function validateUnifiedModelManifest(cases = []) {
  if (!Array.isArray(cases)) throw new TypeError('Benchmark manifest must be an array.');
  const errors = [];
  const ids = new Set();
  for (const [index, item] of cases.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`case_${index}_invalid`);
      continue;
    }
    if (typeof item.id !== 'string' || !item.id) errors.push(`case_${index}_missing_id`);
    else if (ids.has(item.id)) errors.push(`duplicate_id:${item.id}`);
    else ids.add(item.id);
    if (!['structured_output', 'ui', 'code', 'session_isolation'].includes(item.category)) {
      errors.push(`case_${item.id || index}_invalid_category`);
    }
  }
  const counts = {
    structured: categoryCases(cases, 'structured_output').length,
    ui: categoryCases(cases, 'ui').length,
    code: categoryCases(cases, 'code').length,
    sessionIsolation: categoryCases(cases, 'session_isolation').length
  };
  if (counts.structured !== UNIFIED_MODEL_THRESHOLDS.structuredCases) errors.push('structured_case_count_must_equal_100');
  if (counts.ui !== UNIFIED_MODEL_THRESHOLDS.uiCases) errors.push('ui_case_count_must_equal_30');
  if (counts.code !== UNIFIED_MODEL_THRESHOLDS.codeCases) errors.push('code_case_count_must_equal_10');
  if (counts.sessionIsolation < 1) errors.push('session_isolation_case_required');
  return {
    valid: errors.length === 0,
    errors,
    totalCases: cases.length,
    caseCounts: counts,
    referencedEvidence: cases.flatMap(evidencePaths)
  };
}

export function scoreUnifiedModelCases(cases = []) {
  const manifest = validateUnifiedModelManifest(cases);
  const structured = categoryCases(cases, 'structured_output');
  const ui = categoryCases(cases, 'ui');
  const code = categoryCases(cases, 'code');
  const isolation = categoryCases(cases, 'session_isolation');
  const metrics = {
    structuredFirstPass: structured.filter((item) => item.firstPass === true).length,
    structuredAfterRepair: structured.filter((item) => item.afterRepair === true).length,
    uiToolChoice: ui.filter((item) => item.toolChoiceCorrect === true).length,
    uiGrounding: ui.filter((item) => item.groundingCorrect === true).length,
    codeDefectOwner: code.filter((item) => item.defectOwnerCorrect === true).length,
    codeCandidatePassed: code.filter((item) => item.candidatePassed === true).length,
    sessionContamination: isolation.filter((item) => item.passed !== true).length
  };
  const failures = [...manifest.errors];
  if (metrics.structuredFirstPass < UNIFIED_MODEL_THRESHOLDS.structuredFirstPass) failures.push('structured_first_pass_below_98');
  if (metrics.structuredAfterRepair < UNIFIED_MODEL_THRESHOLDS.structuredAfterRepair) failures.push('structured_after_repair_below_100');
  if (metrics.uiToolChoice < UNIFIED_MODEL_THRESHOLDS.uiToolChoice) failures.push('ui_tool_choice_below_27');
  if (metrics.uiGrounding < UNIFIED_MODEL_THRESHOLDS.uiGrounding) failures.push('ui_grounding_below_24');
  if (metrics.codeDefectOwner < UNIFIED_MODEL_THRESHOLDS.codeDefectOwner) failures.push('code_owner_below_7');
  if (metrics.codeCandidatePassed < UNIFIED_MODEL_THRESHOLDS.codeCandidatePassed) failures.push('code_candidate_below_6');
  if (metrics.sessionContamination > UNIFIED_MODEL_THRESHOLDS.sessionContamination) failures.push('session_contamination');
  return {
    passed: failures.length === 0,
    failures: [...new Set(failures)],
    caseCounts: manifest.caseCounts,
    thresholds: UNIFIED_MODEL_THRESHOLDS,
    metrics
  };
}

export function benchmarkReportAllowsMutations({ report, activeModel, protocolVersion } = {}) {
  if (!report || typeof report !== 'object') return { allowed: false, reason: 'report_unavailable' };
  if (!Array.isArray(report.cases)) return { allowed: false, reason: 'report_incomplete' };
  const verifiedSummary = scoreUnifiedModelCases(report.cases);
  if (report.passed !== true || verifiedSummary.passed !== true) {
    return { allowed: false, reason: 'benchmark_failed', summary: verifiedSummary };
  }
  if (report.model !== activeModel) return { allowed: false, reason: 'model_mismatch' };
  if (report.protocolVersion !== protocolVersion) return { allowed: false, reason: 'protocol_mismatch' };
  return { allowed: true, reason: 'benchmark_passed', summary: verifiedSummary };
}

export async function readUnifiedModelBenchmarkReport(reportPath) {
  try {
    return JSON.parse(await fs.readFile(reportPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    const wrapped = new Error(`Unified model benchmark report is invalid: ${error.message}`, { cause: error });
    wrapped.code = 'benchmark_report_invalid';
    throw wrapped;
  }
}

export async function readCurrentGitCommit(projectRoot) {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 64 * 1024
    });
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}
