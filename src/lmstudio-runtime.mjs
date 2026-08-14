import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { getLmStudioStatus } from './lmstudio-client.mjs';

const execFileAsync = promisify(execFile);

function runtimeExecutable() {
  return path.join(process.env.USERPROFILE || '', '.lmstudio', 'bin', 'lms.exe');
}

async function runLms(args, timeout = 120_000) {
  const executable = runtimeExecutable();
  await fs.access(executable);
  const result = await execFileAsync(executable, args, {
    windowsHide: true,
    timeout,
    maxBuffer: 4 * 1024 * 1024
  });
  return `${result.stdout || ''}${result.stderr || ''}`.trim();
}

async function waitForServer(baseUrl, expectedReachable, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let status = null;
  do {
    status = await getLmStudioStatus({ baseUrl, timeoutMs: 1_500 });
    if (status.reachable === expectedReachable) return status;
    await new Promise((resolve) => setTimeout(resolve, 300));
  } while (Date.now() < deadline);
  return status;
}

async function stopWindowsProcessImages(imageNames) {
  if (process.platform !== 'win32') return [];
  const stopped = [];
  let listing = '';
  try {
    const result = await execFileAsync('C:\\Windows\\System32\\tasklist.exe', ['/FO', 'CSV', '/NH'], {
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024
    });
    listing = String(result.stdout || '').toLowerCase();
  } catch {
    return stopped;
  }
  for (const imageName of imageNames) {
    if (!listing.includes(`"${imageName.toLowerCase()}"`)) continue;
    try {
      await execFileAsync('C:\\Windows\\System32\\taskkill.exe', ['/IM', imageName, '/T', '/F'], {
        windowsHide: true,
        timeout: 20_000,
        maxBuffer: 2 * 1024 * 1024
      });
      stopped.push(imageName);
    } catch { }
  }
  return stopped;
}

export async function stopLmStudioRuntime({ baseUrl, closeDesktop = false }) {
  const errors = [];
  try {
    await runLms(['unload', '-a'], 45_000);
  } catch (error) {
    errors.push(`unload: ${error.message}`);
  }
  try {
    await runLms(['server', 'stop'], 30_000);
  } catch (error) {
    const status = await getLmStudioStatus({ baseUrl, timeoutMs: 1_500 });
    if (status.reachable) errors.push(`server stop: ${error.message}`);
  }
  let status = await waitForServer(baseUrl, false, 8_000);
  const stoppedProcesses = closeDesktop
    ? await stopWindowsProcessImages(['llama-server.exe', 'LM Studio.exe'])
    : [];
  if (closeDesktop && status?.reachable === true) {
    status = await waitForServer(baseUrl, false, 4_000);
  }
  return {
    running: status?.reachable === true,
    stopped: status?.reachable !== true,
    modelLoaded: false,
    desktopClosed: closeDesktop,
    stoppedProcesses,
    errors
  };
}

export async function startLmStudioRuntime({
  baseUrl,
  model,
  modelKey = process.env.AI_WORKSTATION_LM_STUDIO_MODEL_KEY || model,
  gpuOffload = process.env.AI_WORKSTATION_LM_STUDIO_GPU_OFFLOAD || 'max',
  contextLength = process.env.AI_WORKSTATION_LM_STUDIO_CONTEXT_LENGTH || '8192',
  parallel = process.env.AI_WORKSTATION_LM_STUDIO_PARALLEL || '1'
}) {
  const url = new URL(baseUrl);
  let status = await getLmStudioStatus({ baseUrl, timeoutMs: 1_500 });
  if (!status.reachable) {
    await runLms(['server', 'start', '--port', url.port || '1234', '--bind', url.hostname], 30_000);
  }

  const loaded = await runLms(['ps'], 30_000);
  if (!loaded.toLowerCase().includes(model.toLowerCase())) {
    const loadArgs = ['load', modelKey];
    if (model !== modelKey) loadArgs.push('--identifier', model);
    loadArgs.push(
      '--gpu', String(gpuOffload),
      '--context-length', String(contextLength),
      '--parallel', String(parallel),
      '-y'
    );
    await runLms(loadArgs, 180_000);
  }

  status = await waitForServer(baseUrl, true, 20_000);
  if (!status?.reachable) throw new Error(status?.error || 'LM Studio server did not become reachable.');
  return {
    running: true,
    stopped: false,
    modelLoaded: status.models.some((entry) => {
      const identifier = String(entry?.key || entry?.id || entry?.model || entry || '').toLowerCase();
      const identifierMatches = identifier.includes(model.toLowerCase()) || identifier.includes(modelKey.toLowerCase());
      return identifierMatches && (!Array.isArray(entry?.loaded_instances) || entry.loaded_instances.length > 0);
    }),
    model,
    errors: []
  };
}
