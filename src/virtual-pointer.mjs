import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

export async function moveVirtualPointer(statePath, point, options = {}) {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
    throw new TypeError('Virtual pointer coordinates must be finite numbers.');
  }

  const state = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    x: Math.round(point.x),
    y: Math.round(point.y),
    visible: options.visible !== false,
    label: options.label || 'AI',
    message: typeof options.message === 'string' ? options.message.trim().slice(0, 320) : '',
    tone: ['working', 'success', 'warning', 'error'].includes(options.tone) ? options.tone : 'working'
  };
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(state), 'utf8');
  await fs.rename(temporaryPath, statePath);
  return state;
}

export async function startVirtualPointer({ scriptPath, statePath, displayBounds }) {
  const initialState = await moveVirtualPointer(statePath, {
    x: displayBounds.x + Math.min(80, Math.max(8, displayBounds.width - 80)),
    y: displayBounds.y + Math.min(80, Math.max(8, displayBounds.height - 80))
  });

  const child = spawn(
    powershell,
    [
      '-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-StatePath', statePath,
      '-ParentProcessId', String(process.pid)
    ],
    { windowsHide: true, stdio: 'ignore' }
  );
  child.unref();
  return { processId: child.pid, state: initialState, child };
}

export function centerOfBounds(bounds) {
  if (!bounds || bounds.empty || bounds.width <= 0 || bounds.height <= 0) return null;
  return {
    x: bounds.x + Math.min(24, bounds.width / 2),
    y: bounds.y + Math.min(24, bounds.height / 2)
  };
}
