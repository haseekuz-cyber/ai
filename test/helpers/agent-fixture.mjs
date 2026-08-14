import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AgentEngine } from '../../src/agent-engine.mjs';
import { SessionStore } from '../../src/session-store.mjs';
import { ToolInvocationLedger } from '../../src/tool-invocation-ledger.mjs';
import { ToolRegistry } from '../../src/tool-registry.mjs';

export async function createAgentFixture({ modelClient, directory: existingDirectory } = {}) {
  const directory = existingDirectory ?? await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-agent-'));
  const sessionStore = new SessionStore({ directory });
  const ledger = new ToolInvocationLedger({ eventStore: sessionStore });
  const toolRegistry = new ToolRegistry({
    ledger,
    policy: { authorize: () => ({ allowed: true }) },
    inputArbiter: null
  });
  toolRegistry.register({
    name: 'test.read',
    description: 'Return a deterministic test observation.',
    risk: 'read_only',
    readOnly: true,
    idempotency: 'retryable',
    inputSchema: { type: 'object', additionalProperties: false }
  }, async () => ({ ok: true }));
  const engine = new AgentEngine({
    sessionStore,
    contextCompiler: {
      compile: ({ state }) => ({
        pinned: {
          sessionId: state.sessionId,
          goal: state.goal,
          lastToolResult: state.lastToolResult || null
        },
        contextUsage: { estimatedInputTokens: 1 }
      })
    },
    modelClient,
    toolRegistry,
    activeModel: 'test-model'
  });
  return { directory, engine, sessionStore, toolRegistry };
}
