import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.mjs';
import { compareReplayEvaluations, writeReplayEvaluation } from '../src/replay-eval.mjs';

async function readCases(filePath) {
  const text = await fs.readFile(filePath, 'utf8');
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : value.cases || [];
  } catch {
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  }
}

const defaultDirectory = path.join(config.evaluationDirectory, 'Replay');
const [, , baselineArgument, candidateArgument, outputArgument] = process.argv;
const baselinePath = path.resolve(baselineArgument || path.join(defaultDirectory, 'baseline.jsonl'));
const candidatePath = path.resolve(candidateArgument || path.join(defaultDirectory, 'candidate.jsonl'));
const outputDirectory = path.resolve(outputArgument || defaultDirectory);

async function exists(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

const missingInputs = [];
if (!await exists(baselinePath)) missingInputs.push(baselinePath);
if (!await exists(candidatePath)) missingInputs.push(candidatePath);
if (missingInputs.length) {
  const result = {
    status: 'not_verified',
    reason: 'replay_inputs_unavailable',
    evidenceType: 'replay',
    liveVerified: false,
    baselinePath,
    candidatePath,
    missingInputs
  };
  const outputPath = await writeReplayEvaluation(outputDirectory, result, 'latest-not-verified');
  console.error(JSON.stringify({ ...result, outputPath }, null, 2));
  process.exitCode = 1;
} else {
  const comparison = compareReplayEvaluations(await readCases(baselinePath), await readCases(candidatePath));
  const outputPath = await writeReplayEvaluation(outputDirectory, comparison, `comparison-${Date.now()}`);
  console.log(JSON.stringify({ evidenceType: 'replay', liveVerified: false, ...comparison, outputPath }, null, 2));
  if (!comparison.acceptable) process.exitCode = 1;
}
