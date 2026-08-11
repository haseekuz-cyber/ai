import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function observationSignature(observation) {
  if (typeof observation?.sha256 === 'string' && observation.sha256) return observation.sha256;
  if (typeof observation?.outputPath !== 'string' || !observation.outputPath) {
    throw new TypeError('Observation must include sha256 or outputPath.');
  }
  const bytes = await fs.readFile(observation.outputPath);
  return createHash('sha256').update(bytes).digest('hex');
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return value;
}

export async function waitForSettledObservation({
  beforeObservation,
  capture,
  cleanup = async (outputPath) => fs.rm(outputPath, { force: true }),
  signature = observationSignature,
  sleep = delay,
  now = Date.now,
  initialDelayMs = 200,
  pollIntervalMs = 350,
  minimumObservationMs = 900,
  maxWaitMs = 4_500,
  stableSamples = 2
}) {
  if (typeof capture !== 'function') throw new TypeError('capture must be a function.');
  positiveInteger(initialDelayMs, 'initialDelayMs');
  positiveInteger(pollIntervalMs, 'pollIntervalMs');
  positiveInteger(minimumObservationMs, 'minimumObservationMs');
  positiveInteger(maxWaitMs, 'maxWaitMs');
  positiveInteger(stableSamples, 'stableSamples');
  if (minimumObservationMs > maxWaitMs) throw new TypeError('minimumObservationMs must not exceed maxWaitMs.');

  const beforeSignature = await signature(beforeObservation);
  const startedAtMs = now();
  let previousSignature = beforeSignature;
  let previousCapturePath = null;
  let finalObservation = null;
  let changed = false;
  let stableStreak = 0;
  let captureCount = 0;
  let reason = 'timeout_without_change';

  await sleep(initialDelayMs);
  while (true) {
    const observation = await capture(captureCount + 1);
    const currentSignature = await signature(observation);
    captureCount += 1;

    if (previousCapturePath && previousCapturePath !== observation.outputPath) {
      await cleanup(previousCapturePath);
    }
    previousCapturePath = observation.outputPath ?? null;
    finalObservation = observation;

    if (currentSignature !== beforeSignature) changed = true;
    stableStreak = changed && currentSignature === previousSignature ? stableStreak + 1 : (changed ? 1 : 0);
    previousSignature = currentSignature;

    const elapsedMs = now() - startedAtMs;
    if (changed && stableStreak >= stableSamples && elapsedMs >= minimumObservationMs) {
      reason = 'changed_and_stable';
      break;
    }
    if (elapsedMs >= maxWaitMs) {
      reason = changed ? 'timeout_after_change' : 'timeout_without_change';
      break;
    }
    await sleep(Math.min(pollIntervalMs, Math.max(1, maxWaitMs - elapsedMs)));
  }

  return {
    observation: finalObservation,
    settling: {
      changed,
      stable: reason === 'changed_and_stable',
      reason,
      captureCount,
      elapsedMs: now() - startedAtMs,
      stableSamples: stableStreak
    }
  };
}

