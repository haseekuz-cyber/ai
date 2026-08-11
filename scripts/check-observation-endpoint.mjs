import fs from 'node:fs/promises';
import path from 'node:path';

const token = process.env.AI_WORKSTATION_TOKEN || 'development-local-only';
const workerPort = process.env.AI_WORKSTATION_WORKER_PORT || '47731';
const workerBase = `http://127.0.0.1:${workerPort}`;
const headers = { authorization: `Bearer ${token}` };

const capabilitiesResponse = await fetch(`${workerBase}/observation/capabilities`, { headers });
const capabilities = await capabilitiesResponse.json();
if (!capabilitiesResponse.ok || !capabilities.captureEnabled || !capabilities.boundaryReady) {
  throw new Error(`Observation capability is not ready: ${JSON.stringify(capabilities)}`);
}

let capturedPath;
try {
  const captureResponse = await fetch(`${workerBase}/observations`, { method: 'POST', headers });
  const body = await captureResponse.json();
  if (captureResponse.status !== 201) {
    throw new Error(`Expected HTTP 201 from observation endpoint; received ${captureResponse.status}: ${JSON.stringify(body)}`);
  }

  capturedPath = path.resolve(body.observation.outputPath);
  const stat = await fs.stat(capturedPath);
  if (!stat.isFile() || stat.size !== body.observation.bytes) {
    throw new Error('Observation file metadata does not match the captured PNG.');
  }

  console.log(JSON.stringify({
    captureStatus: captureResponse.status,
    sessionId: body.observation.sessionId,
    deviceName: body.observation.deviceName,
    width: body.observation.bounds.width,
    height: body.observation.bounds.height,
    hashLength: body.observation.sha256.length,
    bytes: body.observation.bytes
  }, null, 2));
} finally {
  if (capturedPath) await fs.unlink(capturedPath).catch(() => {});
}
