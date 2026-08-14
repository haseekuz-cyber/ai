import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const activeModel = process.env.AI_WORKSTATION_ACTIVE_MODEL ||
  process.env.AI_WORKSTATION_LM_STUDIO_MODEL ||
  'qwen/qwen3-vl-8b';

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

function readInteger(name, fallback, { minimum, maximum }) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
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
  windowObserverScript: path.resolve(moduleDirectory, '..', 'scripts', 'window-observer.ps1'),
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
  feedbackLogPath: process.env.AI_WORKSTATION_FEEDBACK_LOG || path.resolve(moduleDirectory, '..', 'artifacts', 'learning', 'approved-steps.jsonl'),
  principlesPath: process.env.AI_WORKSTATION_PRINCIPLES || path.resolve(moduleDirectory, '..', 'artifacts', 'learning', 'principles.json'),
  teacherProfilePath: process.env.AI_WORKSTATION_TEACHER_PROFILE || path.resolve(moduleDirectory, '..', 'artifacts', 'learning', 'teacher-profile.json'),
  teacherChatLogPath: process.env.AI_WORKSTATION_TEACHER_CHAT_LOG || path.resolve(moduleDirectory, '..', 'artifacts', 'learning', 'teacher-chat.jsonl'),
  teacherExperiencesPath: process.env.AI_WORKSTATION_TEACHER_EXPERIENCES || path.resolve(moduleDirectory, '..', 'artifacts', 'learning', 'teacher-experiences.jsonl'),
  teacherMaterialsPath: process.env.AI_WORKSTATION_TEACHER_MATERIALS || path.resolve(moduleDirectory, '..', 'artifacts', 'learning', 'teacher-materials.jsonl'),
  teacherChatDirectory: process.env.AI_WORKSTATION_TEACHER_CHAT || path.resolve(moduleDirectory, '..', 'artifacts', 'teacher-chat'),
  teacherSandboxDirectory: process.env.AI_WORKSTATION_TEACHER_SANDBOX || path.resolve(moduleDirectory, '..', 'artifacts', 'teacher-sandbox'),
  teacherBackupDirectory: process.env.AI_WORKSTATION_TEACHER_BACKUPS || path.resolve(moduleDirectory, '..', 'artifacts', 'teacher-backups'),
  errorPacketsDirectory: process.env.AI_WORKSTATION_ERROR_PACKETS || path.resolve(moduleDirectory, '..', 'artifacts', 'self-improvement', 'errors'),
  improvementDirectory: process.env.AI_WORKSTATION_IMPROVEMENTS || path.resolve(moduleDirectory, '..', 'artifacts', 'self-improvement', 'candidates'),
  evaluationDirectory: process.env.AI_WORKSTATION_EVALUATIONS || path.resolve(moduleDirectory, '..', 'artifacts', 'evaluations'),
  safetyStatePath: process.env.AI_WORKSTATION_SAFETY_STATE || path.resolve(moduleDirectory, '..', 'artifacts', 'state', 'safety.json'),
  safetyHotkeyReadyPath: process.env.AI_WORKSTATION_SAFETY_HOTKEY_READY || path.resolve(moduleDirectory, '..', 'artifacts', 'state', 'safety-hotkey.ready'),
  assignedDisplay: process.env.AI_WORKSTATION_DISPLAY || null,
  captureEnabled: readBoolean('AI_WORKSTATION_CAPTURE_ENABLED'),
  pointerOverlayEnabled: readBoolean('AI_WORKSTATION_POINTER_OVERLAY_ENABLED', true),
  pointerStatePath: process.env.AI_WORKSTATION_POINTER_STATE || path.resolve(moduleDirectory, '..', 'artifacts', 'virtual-pointer.json'),
  lmStudioBaseUrl: process.env.AI_WORKSTATION_LM_STUDIO_URL || 'http://127.0.0.1:1234',
  activeModel,
  lmStudioModel: activeModel,
  visionModel: activeModel,
  plannerModel: activeModel,
  criticModel: activeModel,
  coderModel: activeModel,
  embeddingModel: process.env.AI_WORKSTATION_EMBEDDING_MODEL || 'qwen/qwen3-embedding-0.6b',
  teacherModel: activeModel,
  modelBrokerEnabled: readBoolean('AI_WORKSTATION_MODEL_BROKER', true),
  modelIdleTtlMs: readInteger('AI_WORKSTATION_MODEL_IDLE_TTL_MS', 120_000, { minimum: 10_000, maximum: 3_600_000 }),
  teacherFastPathEnabled: readBoolean('AI_WORKSTATION_TEACHER_FAST_PATH', true),
  miniPlansEnabled: readBoolean('AI_WORKSTATION_MINI_PLANS', true),
  eventObserverEnabled: readBoolean('AI_WORKSTATION_EVENT_OBSERVER', true),
  eventObserverIntervalMs: readInteger('AI_WORKSTATION_EVENT_INTERVAL_MS', 1_200, { minimum: 250, maximum: 5_000 }),
  eventObserverActiveIntervalMs: readInteger('AI_WORKSTATION_EVENT_ACTIVE_INTERVAL_MS', 200, { minimum: 100, maximum: 1_000 }),
  visionEnabled: readBoolean('AI_WORKSTATION_VISION_ENABLED', true)
});
