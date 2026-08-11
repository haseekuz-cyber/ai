import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

function readPort(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`${name} must be an integer between 1024 and 65535`);
  }
  return value;
}

function readBoolean(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export const config = Object.freeze({
  host: '127.0.0.1',
  controllerPort: readPort('AI_WORKSTATION_CONTROLLER_PORT', 47730),
  workerPort: readPort('AI_WORKSTATION_WORKER_PORT', 47731),
  authToken: process.env.AI_WORKSTATION_TOKEN || 'development-local-only',
  projectRoot: path.resolve(moduleDirectory, '..'),
  publicDirectory: path.resolve(moduleDirectory, '..', 'public'),
  diagnosticsScript: path.resolve(moduleDirectory, '..', 'scripts', 'diagnose.ps1'),
  captureScript: path.resolve(moduleDirectory, '..', 'scripts', 'capture-display.ps1'),
  windowCaptureScript: path.resolve(moduleDirectory, '..', 'scripts', 'capture-window.ps1'),
  imageRegionScript: path.resolve(moduleDirectory, '..', 'scripts', 'crop-image-region.ps1'),
  telegramBadgeScript: path.resolve(moduleDirectory, '..', 'scripts', 'detect-telegram-badges.ps1'),
  windowMessageScript: path.resolve(moduleDirectory, '..', 'scripts', 'window-message.ps1'),
  pointerBridgeScript: path.resolve(moduleDirectory, '..', 'scripts', 'pointer-bridge.ps1'),
  uiaScript: path.resolve(moduleDirectory, '..', 'scripts', 'uia-bridge.ps1'),
  virtualPointerScript: path.resolve(moduleDirectory, '..', 'scripts', 'virtual-pointer.ps1'),
  teachingRecorderScript: path.resolve(moduleDirectory, '..', 'scripts', 'teach-recorder.ps1'),
  safetyHotkeyScript: path.resolve(moduleDirectory, '..', 'scripts', 'safety-hotkey.ps1'),
  observationsDirectory: process.env.AI_WORKSTATION_OBSERVATIONS || path.resolve(moduleDirectory, '..', 'artifacts', 'observations'),
  teachingDirectory: process.env.AI_WORKSTATION_TEACHING || path.resolve(moduleDirectory, '..', 'artifacts', 'teaching'),
  skillsDirectory: process.env.AI_WORKSTATION_SKILLS || path.resolve(moduleDirectory, '..', 'artifacts', 'skills'),
  auditLogPath: process.env.AI_WORKSTATION_AUDIT_LOG || path.resolve(moduleDirectory, '..', 'artifacts', 'logs', 'actions.jsonl'),
  safetyStatePath: process.env.AI_WORKSTATION_SAFETY_STATE || path.resolve(moduleDirectory, '..', 'artifacts', 'state', 'safety.json'),
  safetyHotkeyReadyPath: process.env.AI_WORKSTATION_SAFETY_HOTKEY_READY || path.resolve(moduleDirectory, '..', 'artifacts', 'state', 'safety-hotkey.ready'),
  assignedDisplay: process.env.AI_WORKSTATION_DISPLAY || null,
  captureEnabled: readBoolean('AI_WORKSTATION_CAPTURE_ENABLED'),
  pointerOverlayEnabled: readBoolean('AI_WORKSTATION_POINTER_OVERLAY_ENABLED', true),
  pointerStatePath: process.env.AI_WORKSTATION_POINTER_STATE || path.resolve(moduleDirectory, '..', 'artifacts', 'virtual-pointer.json'),
  lmStudioBaseUrl: process.env.AI_WORKSTATION_LM_STUDIO_URL || 'http://127.0.0.1:1234',
  lmStudioModel: process.env.AI_WORKSTATION_LM_STUDIO_MODEL || 'qwen/qwen3-vl-8b',
  visionEnabled: readBoolean('AI_WORKSTATION_VISION_ENABLED', true)
});
