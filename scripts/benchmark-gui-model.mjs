import fs from 'node:fs/promises';
import path from 'node:path';
import { analyzeImageWithLmStudio } from '../src/lmstudio-client.mjs';
import { PLANNER_SYSTEM_PROMPT, normalizePlannerMiniPlanOutput } from '../src/agent-planner.mjs';
import { corelGroundingCases, scoreGuiPlan } from '../src/gui-benchmark.mjs';

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const model = argument('--model');
const imagePath = argument('--image', 'D:/AI-Work/Agent-Data/Screenshots/1786606090635-b2ad27ac-1860-4008-aaf8-21c96b2c2cca-agent-before.png');
const outputPath = argument('--output', path.resolve('artifacts', 'benchmarks', `${String(model || 'unknown').replaceAll(/[^a-z0-9._-]/gi, '_')}.json`));
const baseUrl = argument('--base-url', 'http://127.0.0.1:1234');

if (!model) throw new Error('--model is required.');

const results = [];
for (const benchmarkCase of corelGroundingCases) {
  const startedAt = Date.now();
  try {
    const response = await analyzeImageWithLmStudio({
      baseUrl,
      model,
      imagePath,
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      prompt: benchmarkCase.instruction,
      maxOutputTokens: 550,
      timeoutMs: 60_000
    });
    const plan = normalizePlannerMiniPlanOutput(response.analysis, { x: 0, y: 0, width: 1936, height: 1096 });
    results.push({
      id: benchmarkCase.id,
      elapsedMs: Date.now() - startedAt,
      score: scoreGuiPlan(plan, benchmarkCase),
      plan,
      raw: response.raw,
      finishReason: response.finishReason,
      stats: response.stats
    });
  } catch (error) {
    results.push({
      id: benchmarkCase.id,
      elapsedMs: Date.now() - startedAt,
      score: { passed: false },
      error: { code: error.code || null, message: error.message }
    });
  }
}

const passed = results.filter((item) => item.score.passed).length;
const report = {
  model,
  imagePath,
  createdAt: new Date().toISOString(),
  passed,
  total: results.length,
  passRate: passed / results.length,
  results
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ model, passed, total: results.length, passRate: report.passRate, outputPath, results: results.map(({ id, elapsedMs, score, error }) => ({ id, elapsedMs, score, error })) }, null, 2));
