import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { config } from './config.mjs';
import { readJson, sendJson, sendText } from './http-utils.mjs';
import { normalizeTask } from './protocol.mjs';
import { collectWindowsDiagnostics } from './windows-diagnostics.mjs';
import { evaluateIndependentControl } from './independent-control.mjs';

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);

let ownerDiagnostics;
let ownerDiagnosticsError;

async function refreshOwnerDiagnostics() {
  try {
    ownerDiagnostics = await collectWindowsDiagnostics(config.diagnosticsScript);
    ownerDiagnosticsError = undefined;
  } catch (error) {
    ownerDiagnosticsError = error.message;
  }
}

async function callWorker(pathname, options = {}) {
  const { timeoutMs = 5_000, ...fetchOptions } = options;
  const response = await fetch(`http://${config.host}:${config.workerPort}${pathname}`, {
    ...fetchOptions,
    headers: {
      authorization: `Bearer ${config.authToken}`,
      'content-type': 'application/json',
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(timeoutMs)
  });

  const value = await response.json();
  return { status: response.status, value };
}

async function systemState() {
  const worker = await callWorker('/health');
  const independentControl = evaluateIndependentControl(worker.value);
  return { worker, independentControl };
}

await refreshOwnerDiagnostics();

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${config.host}:${config.controllerPort}`);

    if (request.method === 'GET' && url.pathname === '/api/status') {
      try {
        const state = await systemState();
        return sendJson(response, state.worker.status, {
          connected: true,
          owner: {
            diagnostics: ownerDiagnostics,
            diagnosticsError: ownerDiagnosticsError
          },
          worker: state.worker.value,
          independentControl: state.independentControl
        });
      } catch (error) {
        return sendJson(response, 503, { connected: false, error: error.message });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/refresh') {
      await refreshOwnerDiagnostics();
      try {
        await callWorker('/refresh', { method: 'POST', body: '{}' });
        const state = await systemState();
        return sendJson(response, 200, {
          connected: true,
          owner: { diagnostics: ownerDiagnostics, diagnosticsError: ownerDiagnosticsError },
          worker: state.worker.value,
          independentControl: state.independentControl
        });
      } catch (error) {
        return sendJson(response, 503, { connected: false, error: error.message });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/tasks') {
      let task;
      try {
        task = normalizeTask(await readJson(request));
      } catch (error) {
        return sendJson(response, 400, { error: 'invalid_task', message: error.message });
      }

      try {
        if (task.mode === 'execute') {
          const state = await systemState();
          if (!state.independentControl.ready) {
            return sendJson(response, 409, {
              error: 'independent_control_not_ready',
              message: 'Window-local AI control is not ready. Fix the failed independent-control checks first.',
              independentControl: state.independentControl
            });
          }
        }

        const worker = await callWorker('/tasks', {
          method: 'POST',
          body: JSON.stringify(task)
        });
        return sendJson(response, worker.status, worker.value);
      } catch (error) {
        return sendJson(response, 503, { error: 'worker_unavailable', message: error.message });
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/uia/windows') {
      try {
        const worker = await callWorker('/uia/windows', { timeoutMs: 30_000 });
        return sendJson(response, worker.status, worker.value);
      } catch (error) {
        return sendJson(response, 503, { error: 'worker_unavailable', message: error.message });
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/vision/status') {
      try {
        const worker = await callWorker('/vision/status', { timeoutMs: 10_000 });
        return sendJson(response, worker.status, worker.value);
      } catch (error) {
        return sendJson(response, 503, { error: 'worker_unavailable', message: error.message });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/vision/analyze-window') {
      try {
        const input = await readJson(request);
        const worker = await callWorker('/vision/analyze-window', {
          method: 'POST',
          body: JSON.stringify(input),
          timeoutMs: 240_000
        });
        return sendJson(response, worker.status, worker.value);
      } catch (error) {
        return sendJson(response, error.statusCode || 503, { error: 'worker_unavailable', message: error.message });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/telegram/audit-preview') {
      try {
        const input = await readJson(request);
        const worker = await callWorker('/telegram/audit-preview', {
          method: 'POST',
          body: JSON.stringify(input),
          timeoutMs: 60_000
        });
        return sendJson(response, worker.status, worker.value);
      } catch (error) {
        return sendJson(response, error.statusCode || 503, { error: 'worker_unavailable', message: error.message });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/uia/inspect') {
      try {
        const input = await readJson(request);
        const worker = await callWorker('/uia/inspect', {
          method: 'POST',
          body: JSON.stringify(input),
          timeoutMs: 35_000
        });
        return sendJson(response, worker.status, worker.value);
      } catch (error) {
        return sendJson(response, error.statusCode || 503, { error: 'worker_unavailable', message: error.message });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/uia/actions') {
      try {
        const input = await readJson(request);
        const worker = await callWorker('/uia/actions', {
          method: 'POST',
          body: JSON.stringify(input)
        });
        return sendJson(response, worker.status, worker.value);
      } catch (error) {
        return sendJson(response, error.statusCode || 503, { error: 'worker_unavailable', message: error.message });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/pointer/actions') {
      try {
        const input = await readJson(request);
        const worker = await callWorker('/pointer/actions', {
          method: 'POST',
          body: JSON.stringify(input),
          timeoutMs: 15_000
        });
        return sendJson(response, worker.status, worker.value);
      } catch (error) {
        return sendJson(response, error.statusCode || 503, { error: 'worker_unavailable', message: error.message });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/agent/plan-window') {
      try {
        const input = await readJson(request);
        const worker = await callWorker('/agent/plan-window', {
          method: 'POST',
          body: JSON.stringify(input),
          timeoutMs: 240_000
        });
        return sendJson(response, worker.status, worker.value);
      } catch (error) {
        return sendJson(response, error.statusCode || 503, { error: 'worker_unavailable', message: error.message });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/agent/execute-plan') {
      try {
        const input = await readJson(request);
        const worker = await callWorker('/agent/execute-plan', {
          method: 'POST',
          body: JSON.stringify(input),
          timeoutMs: 240_000
        });
        return sendJson(response, worker.status, worker.value);
      } catch (error) {
        return sendJson(response, error.statusCode || 503, { error: 'worker_unavailable', message: error.message });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/feedback/like') {
      try {
        const input = await readJson(request);
        const worker = await callWorker('/feedback/like', {
          method: 'POST', body: JSON.stringify(input), timeoutMs: 15_000
        });
        return sendJson(response, worker.status, worker.value);
      } catch (error) {
        return sendJson(response, error.statusCode || 503, { error: 'worker_unavailable', message: error.message });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/feedback/rate') {
      try {
        const input = await readJson(request);
        const worker = await callWorker('/feedback/rate', {
          method: 'POST', body: JSON.stringify(input), timeoutMs: 15_000
        });
        return sendJson(response, worker.status, worker.value);
      } catch (error) {
        return sendJson(response, error.statusCode || 503, { error: 'worker_unavailable', message: error.message });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/missions') {
      try {
        const input = await readJson(request);
        const worker = await callWorker('/missions', {
          method: 'POST', body: JSON.stringify(input), timeoutMs: 35_000
        });
        return sendJson(response, worker.status, worker.value);
      } catch (error) {
        return sendJson(response, error.statusCode || 503, { error: 'worker_unavailable', message: error.message });
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/missions/status') {
      try {
        const missionId = url.searchParams.get('missionId') || '';
        const worker = await callWorker(`/missions/status?missionId=${encodeURIComponent(missionId)}`);
        return sendJson(response, worker.status, worker.value);
      } catch (error) {
        return sendJson(response, 503, { error: 'worker_unavailable', message: error.message });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/missions/plan-next') {
      try {
        const input = await readJson(request);
        const worker = await callWorker('/missions/plan-next', {
          method: 'POST', body: JSON.stringify(input), timeoutMs: 240_000
        });
        return sendJson(response, worker.status, worker.value);
      } catch (error) {
        return sendJson(response, error.statusCode || 503, { error: 'worker_unavailable', message: error.message });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/missions/cancel') {
      try {
        const input = await readJson(request);
        const worker = await callWorker('/missions/cancel', {
          method: 'POST', body: JSON.stringify(input)
        });
        return sendJson(response, worker.status, worker.value);
      } catch (error) {
        return sendJson(response, error.statusCode || 503, { error: 'worker_unavailable', message: error.message });
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/teach/status') {
      try {
        const worker = await callWorker('/teach/status');
        return sendJson(response, worker.status, worker.value);
      } catch (error) {
        return sendJson(response, 503, { error: 'worker_unavailable', message: error.message });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/teach/start') {
      try {
        const input = await readJson(request);
        const worker = await callWorker('/teach/start', { method: 'POST', body: JSON.stringify(input), timeoutMs: 45_000 });
        return sendJson(response, worker.status, worker.value);
      } catch (error) {
        return sendJson(response, error.statusCode || 503, { error: 'worker_unavailable', message: error.message });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/teach/stop') {
      try {
        const input = await readJson(request);
        const worker = await callWorker('/teach/stop', { method: 'POST', body: JSON.stringify(input), timeoutMs: 45_000 });
        return sendJson(response, worker.status, worker.value);
      } catch (error) {
        return sendJson(response, error.statusCode || 503, { error: 'worker_unavailable', message: error.message });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/teach/cancel') {
      try {
        const input = await readJson(request);
        const worker = await callWorker('/teach/cancel', { method: 'POST', body: JSON.stringify(input) });
        return sendJson(response, worker.status, worker.value);
      } catch (error) {
        return sendJson(response, error.statusCode || 503, { error: 'worker_unavailable', message: error.message });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/skills/recommend') {
      try {
        const input = await readJson(request);
        const worker = await callWorker('/skills/recommend', {
          method: 'POST', body: JSON.stringify(input), timeoutMs: 240_000
        });
        return sendJson(response, worker.status, worker.value);
      } catch (error) {
        return sendJson(response, error.statusCode || 503, { error: 'worker_unavailable', message: error.message });
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/skills') {
      try {
        const worker = await callWorker('/skills', { timeoutMs: 15_000 });
        return sendJson(response, worker.status, worker.value);
      } catch (error) {
        return sendJson(response, 503, { error: 'worker_unavailable', message: error.message });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/skills/prepare') {
      try {
        const input = await readJson(request);
        const worker = await callWorker('/skills/prepare', { method: 'POST', body: JSON.stringify(input), timeoutMs: 35_000 });
        return sendJson(response, worker.status, worker.value);
      } catch (error) {
        return sendJson(response, error.statusCode || 503, { error: 'worker_unavailable', message: error.message });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/skills/execute-step') {
      try {
        const input = await readJson(request);
        const worker = await callWorker('/skills/execute-step', { method: 'POST', body: JSON.stringify(input), timeoutMs: 240_000 });
        return sendJson(response, worker.status, worker.value);
      } catch (error) {
        return sendJson(response, error.statusCode || 503, { error: 'worker_unavailable', message: error.message });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/skills/cancel-run') {
      try {
        const input = await readJson(request);
        const worker = await callWorker('/skills/cancel-run', { method: 'POST', body: JSON.stringify(input) });
        return sendJson(response, worker.status, worker.value);
      } catch (error) {
        return sendJson(response, error.statusCode || 503, { error: 'worker_unavailable', message: error.message });
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/safety/status') {
      try {
        const worker = await callWorker('/safety/status');
        return sendJson(response, worker.status, worker.value);
      } catch (error) {
        return sendJson(response, 503, { error: 'worker_unavailable', message: error.message });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/safety/pause') {
      try {
        const input = await readJson(request);
        const worker = await callWorker('/safety/pause', { method: 'POST', body: JSON.stringify(input) });
        return sendJson(response, worker.status, worker.value);
      } catch (error) {
        return sendJson(response, error.statusCode || 503, { error: 'worker_unavailable', message: error.message });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/safety/resume') {
      try {
        const input = await readJson(request);
        const worker = await callWorker('/safety/resume', { method: 'POST', body: JSON.stringify(input) });
        return sendJson(response, worker.status, worker.value);
      } catch (error) {
        return sendJson(response, error.statusCode || 503, { error: 'worker_unavailable', message: error.message });
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/audit') {
      try {
        const limit = url.searchParams.get('limit') || '100';
        const worker = await callWorker(`/audit?limit=${encodeURIComponent(limit)}`);
        return sendJson(response, worker.status, worker.value);
      } catch (error) {
        return sendJson(response, 503, { error: 'worker_unavailable', message: error.message });
      }
    }

    const staticFile = staticFiles.get(url.pathname);
    if (request.method === 'GET' && staticFile) {
      const [fileName, contentType] = staticFile;
      const body = await fs.readFile(path.join(config.publicDirectory, fileName), 'utf8');
      return sendText(response, 200, body, contentType);
    }

    return sendJson(response, 404, { error: 'not_found' });
  } catch (error) {
    return sendJson(response, error.statusCode || 500, {
      error: 'controller_error',
      message: error.message
    });
  }
});

server.listen(config.controllerPort, config.host, () => {
  console.log(`AI Workstation controller: http://${config.host}:${config.controllerPort}`);
});
