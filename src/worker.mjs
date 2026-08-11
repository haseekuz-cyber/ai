import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.mjs';
import { readJson, sendJson } from './http-utils.mjs';
import { isAuthorized, normalizeTask } from './protocol.mjs';
import { collectWindowsDiagnostics } from './windows-diagnostics.mjs';
import { evaluateCompatibility } from './compatibility.mjs';
import { resolveCaptureTarget } from './screen-boundary.mjs';
import { captureDisplay } from './screen-capture.mjs';
import { captureWindow } from './window-capture.mjs';
import { createBoundedUiRequest, resolveUiAutomationDisplay, runUiAutomation } from './uia-bridge.mjs';
import { centerOfBounds, moveVirtualPointer, startVirtualPointer } from './virtual-pointer.mjs';
import { createBoundedPointerRequest, normalizePointerAction, runPointerAction } from './pointer-bridge.mjs';
import { analyzeImageWithLmStudio, analyzeTextWithLmStudio, getLmStudioStatus, normalizeVisionPrompt } from './lmstudio-client.mjs';
import {
  FIELD_REFINER_SYSTEM_PROMPT,
  FOCUSED_VALIDATOR_SYSTEM_PROMPT,
  PLANNER_SYSTEM_PROMPT,
  POINTER_REFINER_SYSTEM_PROMPT,
  VALIDATOR_SYSTEM_PROMPT,
  findRepeatedFailedAction,
  mergeFocusedValidation,
  normalizeAgentInstruction,
  normalizePlannerOutput,
  normalizePointerRefinement,
  normalizeValidatorOutput,
  toScreenPointerAction
} from './agent-planner.mjs';
import { detectTelegramBadges } from './telegram-audit.mjs';
import {
  buildSkillFromRecording,
  normalizePointToWindow,
  normalizeTeachingText,
  pointerActionToTeachingEvent,
  startTeachingRecorder,
  waitForFile
} from './teaching.mjs';
import {
  learnedStepToPointerAction,
  groundLearnedStepToElements,
  normalizeSkillId,
  publicLearnedStep,
  validateSkillForWindow
} from './skill-runner.mjs';
import { appendAuditEvent, readAuditEvents } from './audit-log.mjs';
import { startSafetyHotkey } from './safety-hotkey.mjs';
import { evaluateActionPolicy, evaluateLearnedStepPolicy } from './action-policy.mjs';
import { executeGroundedAction, groundPlannerProposal } from './agent-grounding.mjs';
import { sameWindowContext } from './window-context.mjs';
import { normalizeSkillRecommendation, publicSkillCandidate, SKILL_ROUTER_SYSTEM_PROMPT } from './skill-router.mjs';
import { waitForSettledObservation } from './observation-settling.mjs';
import { cropImageRegion } from './image-region.mjs';
import {
  appendStepFeedback,
  buildPlanFeedback,
  buildStepFeedback,
  ratedStepsForPrompt,
  readRatedSteps
} from './feedback-store.mjs';
import { buildInterfaceContext } from './interface-context.mjs';
import { buildBoundedPlannerPrompt } from './planner-prompt.mjs';

let diagnostics;
let diagnosticsError;
let pointerOverlay = null;
let pointerOverlayError;
const actionPlans = new Map();
const actionPlanTtlMs = 3 * 60 * 1000;
let teachingSession = null;
const skillRuns = new Map();
const missions = new Map();
const missionTtlMs = 30 * 60 * 1000;
let executionPaused = false;
let safetyReason = null;
let safetyUpdatedAt = new Date().toISOString();
let auditError = null;
let safetyHotkey = null;
let safetyHotkeyError = null;

function publicSafetyState() {
  return {
    paused: executionPaused,
    reason: safetyReason,
    updatedAt: safetyUpdatedAt,
    blocks: ['uia-actions', 'pointer-actions', 'agent-execution', 'skill-execution']
  };
}

async function captureWindowAfterSettling({ windowHandle, beforeObservation, label }) {
  await fs.mkdir(config.observationsDirectory, { recursive: true });
  return waitForSettledObservation({
    beforeObservation,
    capture: async (attempt) => captureWindow({
      scriptPath: config.windowCaptureScript,
      windowHandle,
      outputPath: path.join(
        config.observationsDirectory,
        `${Date.now()}-${randomUUID()}-${label}-${attempt}.png`
      )
    })
  });
}

async function refinePlannedTarget({ planned, observation, instruction }) {
  const action = planned.proposal.action;
  if (!['click', 'doubleClick', 'typeText'].includes(action.type) || planned.grounding?.adjusted) {
    return { planned, visualRefinement: null };
  }

  const textFieldRefinement = action.type === 'typeText' &&
    planned.grounding?.reason === 'visual_text_refinement_required';
  const visualRefinementRequired = planned.grounding?.reason === 'visual_refinement_required' ||
    textFieldRefinement;

  const width = observation.bounds.width;
  const height = observation.bounds.height;
  const coarsePoint = { x: action.point.x, y: action.point.y };
  const cropPath = path.join(config.observationsDirectory, `${Date.now()}-${randomUUID()}-pointer-crop.png`);
  const fieldPurpose = `${planned.proposal.reason} ${JSON.stringify(action.targetHint || {})}`;
  const selectedObjectSizeField = textFieldRefinement &&
    /(ширин|высот|размер|width|height|object size)/i.test(fieldPurpose);
  const broadTopFieldSearch = textFieldRefinement &&
    (coarsePoint.y <= 0.25 || selectedObjectSizeField);
  const cropWidth = broadTopFieldSearch ? Math.min(1_200, width) : 220;
  const cropHeight = broadTopFieldSearch ? Math.min(260, height) : 220;
  const cropCenterX = broadTopFieldSearch
    ? (selectedObjectSizeField || coarsePoint.x < 0.5 ? cropWidth / 2 : width - cropWidth / 2)
    : coarsePoint.x * Math.max(0, width - 1);
  const cropCenterY = broadTopFieldSearch
    ? cropHeight / 2
    : coarsePoint.y * Math.max(0, height - 1);
  const crop = await cropImageRegion({
    scriptPath: config.imageRegionScript,
    inputPath: observation.outputPath,
    outputPath: cropPath,
    centerX: cropCenterX,
    centerY: cropCenterY,
    width: cropWidth,
    height: cropHeight,
    scale: broadTopFieldSearch ? 2 : 3
  });

  try {
    const refinementVision = await analyzeImageWithLmStudio({
      baseUrl: config.lmStudioBaseUrl,
      model: config.lmStudioModel,
      imagePath: crop.outputPath,
      systemPrompt: textFieldRefinement ? FIELD_REFINER_SYSTEM_PROMPT : POINTER_REFINER_SYSTEM_PROMPT,
      prompt: textFieldRefinement
        ? `Задача: ${instruction}\nНазначение поля: ${planned.proposal.reason}\nЦелевое поле: ${JSON.stringify(action.targetHint || {})}\nТекст для ввода: ${action.text}\nНайди точный центр существующего редактируемого поля, чья роль соответствует назначению. Не принимай желаемое новое значение за текущий видимый текст и не выбирай другое числовое поле.${selectedObjectSizeField ? ' Это поле геометрического размера выбранного объекта; не выбирай X, Y, толщину контура, проценты, угол или поле другой роли.' : ''}`
        : `Задача: ${instruction}\nНужное действие: ${planned.proposal.reason}\nЦелевой элемент: ${JSON.stringify(action.targetHint || {})}\nОжидаемый результат: ${planned.proposal.expectedResult}\nНайди точный центр только нужного элемента в увеличенном фрагменте.`,
      maxOutputTokens: 400
    });
    const refinement = normalizePointerRefinement(refinementVision.analysis, crop, observation.bounds);
    const combinedConfidence = Math.min(planned.proposal.confidence, refinement.confidence);
    const usable = refinement.targetVisible && refinement.point && combinedConfidence >= 0.6;
    const visualRefinement = {
      applied: usable,
      coarsePoint,
      refinedPoint: refinement.point,
      targetVisible: refinement.targetVisible,
      confidence: refinement.confidence,
      combinedConfidence,
      evidence: refinement.evidence,
      targetHint: action.targetHint || null,
      cropPath: crop.outputPath,
      stats: refinementVision.stats
    };
    if (!usable && visualRefinementRequired) {
      const error = new Error('Visual target could not be verified safely. No action was planned.');
      error.code = 'invalid_local_plan';
      error.abortReason = 'visual_target_not_verified';
      error.visualRefinement = visualRefinement;
      error.plannedProposal = planned.proposal;
      error.rawLocalModelOutput = refinementVision.raw;
      throw error;
    }
    const grounding = usable && visualRefinementRequired ? {
      ...planned.grounding,
      adjusted: true,
      blocked: false,
      reason: textFieldRefinement ? 'visual_text_target_refined' : 'visual_target_refined',
      confidence: combinedConfidence,
      safePoint: refinement.point,
      pointMethod: 'vision_refined_point'
    } : planned.grounding;
    return {
      planned: {
        ...planned,
        proposal: {
          ...planned.proposal,
          action: usable ? { ...action, point: refinement.point } : action,
          confidence: usable ? combinedConfidence : 0,
          ...(usable && visualRefinementRequired ? { grounding } : {})
        },
        grounding
      },
      visualRefinement
    };
  } catch (error) {
    if (visualRefinementRequired) {
      if (!error.code) error.code = 'invalid_local_plan';
      if (!error.abortReason) error.abortReason = 'visual_target_not_verified';
      throw error;
    }
    return {
      planned: {
        ...planned,
        proposal: { ...planned.proposal, confidence: 0 }
      },
      visualRefinement: {
        applied: false,
        coarsePoint,
        refinedPoint: null,
        targetVisible: false,
        confidence: 0,
        evidence: '',
        cropPath: crop.outputPath,
        error: String(error.message || error).slice(0, 400)
      }
    };
  }
}

async function loadSafetyState() {
  try {
    const stored = JSON.parse(await fs.readFile(config.safetyStatePath, 'utf8'));
    executionPaused = stored.paused === true;
    safetyReason = typeof stored.reason === 'string' ? stored.reason : null;
    safetyUpdatedAt = typeof stored.updatedAt === 'string' ? stored.updatedAt : safetyUpdatedAt;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function persistSafetyState() {
  await fs.mkdir(path.dirname(config.safetyStatePath), { recursive: true });
  await fs.writeFile(config.safetyStatePath, JSON.stringify(publicSafetyState(), null, 2), 'utf8');
}

async function audit(type, details = {}) {
  try {
    const entry = await appendAuditEvent(config.auditLogPath, type, details);
    auditError = null;
    return entry;
  } catch (error) {
    auditError = error.message;
    return null;
  }
}

function rejectWhenPaused(response) {
  if (!executionPaused) return false;
  sendJson(response, 423, {
    error: 'execution_paused',
    message: 'AI execution is paused. Resume it explicitly before performing actions.',
    safety: publicSafetyState()
  });
  return true;
}

async function loadSkill(skillId) {
  const normalizedId = normalizeSkillId(skillId);
  const skillPath = path.join(config.skillsDirectory, `${normalizedId}.json`);
  return { skill: JSON.parse(await fs.readFile(skillPath, 'utf8')), skillPath };
}

async function loadAllSkills() {
  await fs.mkdir(config.skillsDirectory, { recursive: true });
  const entries = await fs.readdir(config.skillsDirectory, { withFileTypes: true });
  const skills = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const skill = JSON.parse(await fs.readFile(path.join(config.skillsDirectory, entry.name), 'utf8'));
      if (skill?.schemaVersion === 1 && typeof skill.skillId === 'string' && Array.isArray(skill.steps)) skills.push(skill);
    } catch { }
  }
  skills.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  return skills;
}

function pruneSkillRuns() {
  const now = Date.now();
  for (const [runId, run] of skillRuns) {
    if (run.expiresAtMs < now || run.status === 'cancelled') skillRuns.delete(runId);
  }
}

function pruneActionPlans() {
  const now = Date.now();
  for (const [planId, plan] of actionPlans) {
    if (plan.expiresAtMs < now || plan.status === 'executed') actionPlans.delete(planId);
  }
}

function pruneMissions() {
  const now = Date.now();
  for (const [missionId, mission] of missions) {
    if (mission.expiresAtMs < now || mission.status === 'cancelled') missions.delete(missionId);
  }
}

function publicMission(mission) {
  if (!mission) return null;
  return {
    missionId: mission.missionId,
    status: mission.status,
    instruction: mission.instruction,
    stepCount: mission.stepCount,
    maxSteps: mission.maxSteps,
    createdAt: mission.createdAt,
    expiresAt: mission.expiresAt,
    window: mission.window,
    lastResult: mission.history.at(-1) ?? null
  };
}

function publicTeachingEvent(event, bounds) {
  const item = {
    type: event.type,
    atMs: Math.max(0, Math.round(Number(event.atMs) || 0))
  };
  if (['pointerMove', 'click', 'doubleClick', 'scroll', 'drag'].includes(event.type)) {
    item.point = normalizePointToWindow({ x: event.x, y: event.y }, bounds);
  }
  if (event.type === 'drag') {
    item.to = normalizePointToWindow({ x: event.toX, y: event.toY }, bounds);
  }
  if (event.type === 'pressKey' || event.type === 'keyPreview') item.key = String(event.key || '').slice(0, 40);
  if (event.type === 'click' || event.type === 'doubleClick' || event.type === 'drag') item.button = event.button === 'right' ? 'right' : 'left';
  if (event.type === 'scroll') item.delta = Number(event.delta) || 0;
  if (event.type === 'typeText') item.textChanged = true;
  return item;
}

async function readTeachingPreview(session) {
  try {
    const recording = JSON.parse(await fs.readFile(session.livePath, 'utf8'));
    const events = [...(recording.events ?? []), ...(session.injectedEvents ?? [])]
      .sort((left, right) => Number(left.atMs) - Number(right.atMs));
    return {
      eventCount: events.length,
      events: events.slice(-800).map((event) => publicTeachingEvent(event, session.window.bounds))
    };
  } catch {
    return { eventCount: 0, events: [] };
  }
}

function publicLearnedStepForProcess(step, processName) {
  return {
    ...publicLearnedStep(step),
    policy: evaluateLearnedStepPolicy({ step, processName })
  };
}

function sameBounds(left, right) {
  return ['x', 'y', 'width', 'height'].every((key) => Number(left?.[key]) === Number(right?.[key]));
}

async function refreshDiagnostics() {
  try {
    diagnostics = await collectWindowsDiagnostics(config.diagnosticsScript);
    diagnosticsError = undefined;
  } catch (error) {
    diagnosticsError = error.message;
  }
}

function observationCapability() {
  try {
    const target = resolveCaptureTarget(diagnostics, config.assignedDisplay);
    return {
      captureEnabled: config.captureEnabled,
      assignedDisplay: target.deviceName,
      bounds: target.bounds,
      boundaryReady: true
    };
  } catch (error) {
    return {
      captureEnabled: config.captureEnabled,
      assignedDisplay: config.assignedDisplay,
      boundaryReady: false,
      boundaryError: error.message
    };
  }
}

function uiAutomationCapability() {
  try {
    const target = resolveUiAutomationDisplay(diagnostics, config.assignedDisplay);
    return {
      available: true,
      mode: 'non-invasive',
      assignedDisplay: target.deviceName,
      bounds: target.bounds,
      systemPointerMoved: false,
      supportedActions: ['invoke', 'setValue', 'toggle', 'select', 'expand', 'collapse']
    };
  } catch (error) {
    return { available: false, mode: 'non-invasive', error: error.message };
  }
}

function visionCapability() {
  return {
    enabled: config.visionEnabled,
    provider: 'LM Studio',
    baseUrl: config.lmStudioBaseUrl,
    model: config.lmStudioModel,
    mode: 'read-only-analysis',
    actionsAllowed: false
  };
}

function pointerCapability() {
  return {
    available: true,
    mode: 'direct-window',
    assignedDisplay: uiAutomationCapability().assignedDisplay,
    systemPointerMoved: false,
    supportedActions: ['click', 'doubleClick', 'scroll', 'drag', 'typeText', 'pressKey'],
    requiresConfirmation: true
  };
}

function boundedUiRequest(request) {
  return createBoundedUiRequest({
    diagnostics,
    configuredDeviceName: config.assignedDisplay,
    request
  });
}

function validateActionRequest(input) {
  const allowedActions = new Set(['invoke', 'setValue', 'toggle', 'select', 'expand', 'collapse']);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Action request must be an object.');
  if (!Number.isInteger(input.windowHandle) || input.windowHandle <= 0) throw new TypeError('windowHandle must be a positive integer.');
  if (!allowedActions.has(input.action)) throw new TypeError('Unsupported non-invasive UI action.');
  if (!input.selector || typeof input.selector !== 'object' || Array.isArray(input.selector)) {
    throw new TypeError('selector must be an object.');
  }
  const selectorKeys = ['runtimeId', 'automationId', 'name', 'nameContains', 'className', 'controlType'];
  if (!selectorKeys.some((key) => typeof input.selector[key] === 'string' && input.selector[key].length > 0)) {
    throw new TypeError('selector must include a stable UI Automation property.');
  }
  if (input.action === 'setValue' && typeof input.value !== 'string') throw new TypeError('setValue requires a string value.');
  if (typeof input.value === 'string' && input.value.length > 2_000) throw new TypeError('Action value is too long.');
  if (input.confirmed !== true) throw new TypeError('confirmed=true is required for a UI action.');
  return input;
}

function taskTokens(text) {
  return new Set(String(text || '').toLowerCase().match(/[a-zа-яё0-9]{3,}/gi) || []);
}

function learnedDemonstrationsForPrompt(skills, instruction, processName) {
  const wanted = taskTokens(instruction);
  const relevant = skills
    .filter((skill) => String(skill.application?.processName || '').toLowerCase() === String(processName || '').toLowerCase())
    .map((skill) => {
      const known = taskTokens(`${skill.name} ${skill.instruction}`);
      const score = [...wanted].filter((token) => known.has(token)).length;
      return { skill, score };
    })
    .sort((left, right) => right.score - left.score || String(right.skill.createdAt).localeCompare(String(left.skill.createdAt)))
    .slice(0, 1)
    .map(({ skill }) => {
      const trajectory = skill.demonstration?.trajectory || [];
      const stride = Math.max(1, Math.ceil(trajectory.length / 16));
      return {
        shownTask: skill.instruction,
        logicalSteps: skill.steps.slice(0, 10).map((step) => ({
          type: step.type,
          target: step.target || null,
          point: step.point || null,
          from: step.from || null,
          to: step.to || null,
          key: step.key || null,
          text: step.text || null
        })),
        trajectoryEvidence: trajectory.filter((_, index) => index % stride === 0).slice(0, 16),
        keyboardEvidence: (skill.demonstration?.keyboard || []).slice(-16)
      };
    });
  if (!relevant.length) return '';
  const prefix = '\nДемонстрация пользователя в этой программе: ';
  const suffix = '\nПойми цель движений и клавиш. Точную траекторию сохраняй только там, где она влияет на результат.';
  const example = relevant[0];
  while (prefix.length + JSON.stringify([example]).length + suffix.length > 1_000) {
    if (example.trajectoryEvidence.length) example.trajectoryEvidence.pop();
    else if (example.keyboardEvidence.length) example.keyboardEvidence.pop();
    else if (example.logicalSteps.length > 1) example.logicalSteps.pop();
    else return '';
  }
  return `${prefix}${JSON.stringify([example])}${suffix}`;
}

async function createWindowActionPlan({ windowHandle, instruction, mission = null }) {
  const inspected = await runUiAutomation(
    config.uiaScript,
    boundedUiRequest({ operation: 'inspect', windowHandle, maxDepth: 8, maxElements: 1_000 }),
    { timeoutMs: 30_000 }
  );
  if (mission && !sameWindowContext(inspected.window, mission.window)) {
    const error = new Error('The target window or active document changed. Start a new mission for the current document.');
    error.code = 'stale_mission';
    throw error;
  }

  await fs.mkdir(config.observationsDirectory, { recursive: true });
  const outputPath = path.join(config.observationsDirectory, `${Date.now()}-${randomUUID()}-agent-before.png`);
  const observation = await captureWindow({
    scriptPath: config.windowCaptureScript,
    windowHandle,
    outputPath
  });
  const history = mission?.history.slice(-4).map((item) => ({
    step: item.step,
    action: item.action,
    validation: item.validation,
    expectedResult: item.expectedResult,
    humanFeedback: item.humanFeedback || null
  })) ?? [];
  const historyPrompt = history.length
    ? `\nПредыдущие проверенные шаги этой задачи: ${JSON.stringify(history)}`
    : '';
  const ratedSteps = await readRatedSteps(config.feedbackLogPath, {
    processName: inspected.window.processName,
    limit: 8
  });
  const interfacePrompt = buildInterfaceContext(inspected.elements, observation.bounds, { limit: 80, maxChars: 1_600 });
  const feedbackPrompt = ratedStepsForPrompt(ratedSteps);
  const learnedSkills = await loadAllSkills();
  const demonstrationPrompt = learnedDemonstrationsForPrompt(
    learnedSkills,
    instruction,
    inspected.window.processName
  );
  const planningContextParts = [historyPrompt, interfacePrompt, demonstrationPrompt, feedbackPrompt];
  let vision = await analyzeImageWithLmStudio({
    baseUrl: config.lmStudioBaseUrl,
    model: config.lmStudioModel,
    imagePath: observation.outputPath,
    systemPrompt: PLANNER_SYSTEM_PROMPT,
    prompt: buildBoundedPlannerPrompt({
      instruction,
      contextParts: planningContextParts,
      directive: 'Предложи только следующий видимый шаг по свежему снимку. Не повторяй успешный шаг, если его результат всё ещё виден. Если свежий снимок противоречит истории, сначала восстанови необходимое состояние. Для создания или изменения фигуры на холсте используй drag, а не click по пустой области. Если предыдущий шаг не прошёл проверку, не повторяй ту же координату или метод.'
    }),
    maxOutputTokens: 1_200
  });

  const normalizeAndGroundStep = (localVision) => {
    let proposal;
    try {
      proposal = normalizePlannerOutput(localVision.analysis, observation.bounds);
    } catch (error) {
      error.code = 'invalid_local_plan';
      error.rawLocalModelOutput = localVision.raw;
      throw error;
    }
    return groundPlannerProposal({
      proposal,
      elements: inspected.elements,
      windowBounds: observation.bounds
    });
  };

  let planned;
  let recoveryAttempts = 0;
  try {
    planned = normalizeAndGroundStep(vision);
  } catch (error) {
    if (error.code !== 'invalid_local_plan') throw error;
    recoveryAttempts = 1;
    vision = await analyzeImageWithLmStudio({
      baseUrl: config.lmStudioBaseUrl,
      model: config.lmStudioModel,
      imagePath: observation.outputPath,
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      prompt: buildBoundedPlannerPrompt({
        instruction,
        contextParts: planningContextParts,
        directive: `Предыдущий ответ отклонён как недопустимый: ${error.message}. Используй только реально видимые элементы свежего снимка и верни все обязательные координаты. Не выдумывай кнопку или панель свойств. Если объект выбран и нужно задать точный размер, верни typeText прямо в видимое числовое поле ширины или высоты верхней панели: point внутри поля, targetHint с ролью поля, text только с числом без единицы измерения. Предложи один следующий шаг.`
      }),
      maxOutputTokens: 1_200
    });
    planned = normalizeAndGroundStep(vision);
  }
  let refined;
  let visualRefinement = null;
  try {
    refined = await refinePlannedTarget({ planned, observation, instruction });
  } catch (error) {
    if (error.abortReason !== 'visual_target_not_verified') throw error;
    recoveryAttempts += 1;
    vision = await analyzeImageWithLmStudio({
      baseUrl: config.lmStudioBaseUrl,
      model: config.lmStudioModel,
      imagePath: observation.outputPath,
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      prompt: buildBoundedPlannerPrompt({
        instruction,
        contextParts: planningContextParts,
        directive: `Предыдущее предложенное действие отклонено: целевой элемент не виден рядом с точкой ${JSON.stringify(error.plannedProposal?.action?.point || null)}. Заново проверь свежий снимок и не выдумывай кнопку или панель, которой нет на экране. Если выбранный объект уже виден и нужно изменить его размер, используй typeText прямо в реально видимом поле ширины или высоты на панели свойств; укажи targetHint с ролью поля, point внутри поля и только числовой text без единицы измерения. Если нужно создать фигуру на холсте, ОБЯЗАТЕЛЬНО верни action.type=drag с разными видимыми from и to на рабочей области. Click по пустому Canvas запрещён. Предложи только один следующий шаг.`
      }),
      maxOutputTokens: 1_200
    });
    planned = normalizeAndGroundStep(vision);
    refined = await refinePlannedTarget({ planned, observation, instruction });
  }
  planned = refined.planned;
  visualRefinement = refined.visualRefinement;
  let repeatedFailure = findRepeatedFailedAction(planned.proposal.action, history);
  if (repeatedFailure) {
    recoveryAttempts += 1;
    vision = await analyzeImageWithLmStudio({
      baseUrl: config.lmStudioBaseUrl,
      model: config.lmStudioModel,
      imagePath: observation.outputPath,
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      prompt: buildBoundedPlannerPrompt({
        instruction,
        contextParts: planningContextParts,
        directive: `Запрещено повторять проваленное действие: ${JSON.stringify(repeatedFailure.action)}. Выбери другую точку минимум в 1% размера окна или другой метод. Предложи только один следующий видимый шаг.`
      }),
      maxOutputTokens: 1_200
    });
    planned = normalizeAndGroundStep(vision);
    refined = await refinePlannedTarget({ planned, observation, instruction });
    planned = refined.planned;
    visualRefinement = refined.visualRefinement;
    repeatedFailure = findRepeatedFailedAction(planned.proposal.action, history);
    if (repeatedFailure) {
      const error = new Error('Local model repeated a failed UI action after a forced replan. No action was executed.');
      error.code = 'invalid_local_plan';
      error.rawLocalModelOutput = vision.raw;
      throw error;
    }
  }
  const proposal = planned.proposal;
  const pointerAction = toScreenPointerAction(proposal.action, observation.bounds, windowHandle);
  const policy = evaluateActionPolicy({ proposal, processName: inspected.window.processName });
  const planId = randomUUID();
  const now = Date.now();
  const plan = {
    planId,
    missionId: mission?.missionId ?? null,
    status: 'planned',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + actionPlanTtlMs).toISOString(),
    expiresAtMs: now + actionPlanTtlMs,
    instruction,
    window: inspected.window,
    observation,
    proposal: { ...proposal, requiresConfirmation: policy.requiresConfirmation },
    policy,
    grounding: planned.grounding,
    visualRefinement,
    recoveryAttempts,
    pointerAction
  };
  actionPlans.set(planId, plan);
  await audit('plan.created', {
    planId, missionId: plan.missionId, action: proposal.action.type, windowHandle,
    processName: inspected.window?.processName || null,
    riskLevel: policy.effectiveRisk,
    requiresConfirmation: policy.requiresConfirmation,
    allowExecution: policy.allowExecution
  });
  return { plan, vision };
}

function publicActionPlan(plan, vision) {
  return {
    planId: plan.planId,
    missionId: plan.missionId,
    status: plan.status,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    instruction: plan.instruction,
    window: plan.window,
    proposal: plan.proposal,
    policy: plan.policy,
    grounding: plan.grounding,
    visualRefinement: plan.visualRefinement,
    recoveryAttempts: plan.recoveryAttempts,
    pointerAction: plan.pointerAction,
    actionsPerformed: false,
    localModel: vision.model,
    stats: vision.stats,
    screenshot: plan.observation.outputPath
  };
}

await loadSafetyState();
await refreshDiagnostics();

if (config.pointerOverlayEnabled) {
  try {
    const display = resolveUiAutomationDisplay(diagnostics, config.assignedDisplay);
    pointerOverlay = await startVirtualPointer({
      scriptPath: config.virtualPointerScript,
      statePath: config.pointerStatePath,
      displayBounds: display.bounds
    });
    pointerOverlay.child.once('exit', (code) => {
      pointerOverlayError = `Virtual pointer overlay exited unexpectedly (code ${code ?? 'unknown'}).`;
      pointerOverlay = null;
    });
  } catch (error) {
    pointerOverlayError = error.message;
  }
}

try {
  await fs.rm(config.safetyHotkeyReadyPath, { force: true });
  safetyHotkey = startSafetyHotkey({
    scriptPath: config.safetyHotkeyScript,
    pauseUrl: `http://${config.host}:${config.workerPort}/safety/pause`,
    authToken: config.authToken,
    parentProcessId: process.pid,
    readyPath: config.safetyHotkeyReadyPath
  });
  if (!await waitForFile(config.safetyHotkeyReadyPath, 6_000)) {
    safetyHotkey.child.kill();
    safetyHotkey = null;
    safetyHotkeyError = 'Emergency hotkey did not become ready.';
  } else {
    safetyHotkey.child.once('exit', (code) => {
      safetyHotkeyError = `Emergency hotkey exited unexpectedly (code ${code ?? 'unknown'}).`;
      safetyHotkey = null;
    });
  }
} catch (error) {
  safetyHotkeyError = error.message;
}

const server = http.createServer(async (request, response) => {
  try {
    if (!isAuthorized(request.headers.authorization, config.authToken)) {
      return sendJson(response, 401, { error: 'unauthorized' });
    }

    const url = new URL(request.url, `http://${config.host}:${config.workerPort}`);

    if (request.method === 'GET' && url.pathname === '/health') {
      return sendJson(response, 200, {
        status: diagnosticsError ? 'degraded' : 'ready',
        autonomousExecutionLocked: true,
        autonomousExecutionLockReason: 'Unconfirmed UI execution is disabled; every state-changing step requires approval.',
        executionMode: 'window-local-confirmed',
        diagnostics,
        compatibility: evaluateCompatibility(diagnostics),
        observation: observationCapability(),
        uiAutomation: uiAutomationCapability(),
        pointer: pointerCapability(),
        vision: visionCapability(),
        pointerOverlay: {
          enabled: config.pointerOverlayEnabled,
          processId: pointerOverlay?.processId ?? null,
          statePath: config.pointerStatePath,
          error: pointerOverlayError
        },
        safety: publicSafetyState(),
        emergencyHotkey: {
          registered: Boolean(safetyHotkey) && !safetyHotkeyError,
          shortcut: 'Ctrl+Shift+F12',
          processId: safetyHotkey?.processId ?? null,
          error: safetyHotkeyError
        },
        audit: { path: config.auditLogPath, error: auditError },
        diagnosticsError
      });
    }

    if (request.method === 'GET' && url.pathname === '/safety/status') {
      return sendJson(response, 200, publicSafetyState());
    }

    if (request.method === 'POST' && url.pathname === '/safety/pause') {
      const input = await readJson(request);
      executionPaused = true;
      safetyReason = typeof input.reason === 'string' && input.reason.trim()
        ? input.reason.trim().slice(0, 240)
        : 'Paused by user';
      safetyUpdatedAt = new Date().toISOString();
      await persistSafetyState();
      await audit('safety.paused', { reason: safetyReason });
      return sendJson(response, 200, publicSafetyState());
    }

    if (request.method === 'POST' && url.pathname === '/safety/resume') {
      const input = await readJson(request);
      if (input.confirmed !== true) {
        return sendJson(response, 409, { error: 'confirmation_required', message: 'confirmed=true is required to resume AI execution.' });
      }
      executionPaused = false;
      safetyReason = null;
      safetyUpdatedAt = new Date().toISOString();
      await persistSafetyState();
      await audit('safety.resumed');
      return sendJson(response, 200, publicSafetyState());
    }

    if (request.method === 'GET' && url.pathname === '/audit') {
      const events = await readAuditEvents(config.auditLogPath, url.searchParams.get('limit') ?? 100);
      return sendJson(response, 200, { count: events.length, events, error: auditError });
    }

    if (request.method === 'POST' && url.pathname === '/refresh') {
      await refreshDiagnostics();
      return sendJson(response, diagnosticsError ? 500 : 200, {
        status: diagnosticsError ? 'degraded' : 'ready',
        diagnosticsError,
        diagnostics,
        compatibility: evaluateCompatibility(diagnostics)
      });
    }

    if (request.method === 'GET' && url.pathname === '/observation/capabilities') {
      return sendJson(response, 200, observationCapability());
    }

    if (request.method === 'POST' && url.pathname === '/observations') {
      if (!config.captureEnabled) {
        return sendJson(response, 409, {
          error: 'capture_disabled',
          message: 'Set AI_WORKSTATION_CAPTURE_ENABLED=1 in the Worker session to allow display capture.'
        });
      }

      let target;
      try {
        target = resolveCaptureTarget(diagnostics, config.assignedDisplay);
      } catch (error) {
        return sendJson(response, 409, { error: 'display_boundary_not_ready', message: error.message });
      }

      await fs.mkdir(config.observationsDirectory, { recursive: true });
      const outputPath = path.join(config.observationsDirectory, `${Date.now()}-${randomUUID()}.png`);
      const observation = await captureDisplay({
        scriptPath: config.captureScript,
        deviceName: target.deviceName,
        outputPath
      });
      return sendJson(response, 201, { observation });
    }

    if (request.method === 'GET' && url.pathname === '/vision/status') {
      const local = await getLmStudioStatus({ baseUrl: config.lmStudioBaseUrl });
      return sendJson(response, local.reachable ? 200 : 503, {
        ...visionCapability(),
        local
      });
    }

    if (request.method === 'POST' && url.pathname === '/vision/analyze-window') {
      if (!config.visionEnabled) {
        return sendJson(response, 409, { error: 'vision_disabled', message: 'Local vision analysis is disabled.' });
      }

      const input = await readJson(request);
      if (!Number.isInteger(input.windowHandle) || input.windowHandle <= 0) {
        return sendJson(response, 400, { error: 'invalid_window', message: 'windowHandle must be a positive integer.' });
      }

      let analysisPrompt;
      try {
        analysisPrompt = normalizeVisionPrompt(input.prompt);
      } catch (error) {
        return sendJson(response, 400, { error: 'invalid_prompt', message: error.message });
      }

      // This read-only inspection proves that the live window is still inside the assigned display
      // and is not one of the protected assistant or terminal processes.
      const inspected = await runUiAutomation(
        config.uiaScript,
        boundedUiRequest({
          operation: 'inspect',
          windowHandle: input.windowHandle,
          maxDepth: 0,
          maxElements: 1
        }),
        { timeoutMs: 30_000 }
      );

      await fs.mkdir(config.observationsDirectory, { recursive: true });
      const outputPath = path.join(config.observationsDirectory, `${Date.now()}-${randomUUID()}-window.png`);
      const observation = await captureWindow({
        scriptPath: config.windowCaptureScript,
        windowHandle: input.windowHandle,
        outputPath
      });
      const vision = await analyzeImageWithLmStudio({
        baseUrl: config.lmStudioBaseUrl,
        model: config.lmStudioModel,
        imagePath: observation.outputPath,
        prompt: analysisPrompt
      });

      return sendJson(response, 200, {
        mode: 'read-only-analysis',
        actionsPerformed: false,
        window: inspected.window,
        observation,
        vision
      });
    }

    if (request.method === 'POST' && url.pathname === '/telegram/audit-preview') {
      const input = await readJson(request);
      if (!Number.isInteger(input.windowHandle) || input.windowHandle <= 0) {
        return sendJson(response, 400, { error: 'invalid_window', message: 'windowHandle must be a positive integer.' });
      }

      const inspected = await runUiAutomation(
        config.uiaScript,
        boundedUiRequest({ operation: 'inspect', windowHandle: input.windowHandle, maxDepth: 0, maxElements: 1 }),
        { timeoutMs: 30_000 }
      );
      if (inspected.window?.processName !== 'Telegram') {
        return sendJson(response, 400, { error: 'not_telegram', message: 'The selected window is not Telegram.' });
      }
      if (inspected.window.bounds?.x < -10_000) {
        return sendJson(response, 409, { error: 'window_minimized', message: 'Restore Telegram on the AI display first.' });
      }

      await fs.mkdir(config.observationsDirectory, { recursive: true });
      const outputPath = path.join(config.observationsDirectory, `${Date.now()}-${randomUUID()}-telegram-preview.png`);
      const observation = await captureWindow({
        scriptPath: config.windowCaptureScript,
        windowHandle: input.windowHandle,
        outputPath
      });
      const detection = await detectTelegramBadges({
        scriptPath: config.telegramBadgeScript,
        imagePath: observation.outputPath
      });
      return sendJson(response, 200, {
        mode: 'read-only-preview',
        actionsPerformed: false,
        readReceiptsSent: false,
        window: inspected.window,
        observation,
        candidates: detection.badges,
        candidateCount: detection.count,
        nextStepRequiresConfirmation: detection.count > 0,
        warning: detection.count > 0
          ? 'Opening these chats may send Telegram read receipts.'
          : null
      });
    }

    if (request.method === 'GET' && url.pathname === '/uia/windows') {
      const result = await runUiAutomation(
        config.uiaScript,
        boundedUiRequest({ operation: 'listWindows' })
      );
      return sendJson(response, 200, {
        ...result,
        display: uiAutomationCapability()
      });
    }

    if (request.method === 'POST' && url.pathname === '/uia/inspect') {
      const input = await readJson(request);
      if (!Number.isInteger(input.windowHandle) || input.windowHandle <= 0) {
        return sendJson(response, 400, { error: 'invalid_window', message: 'windowHandle must be a positive integer.' });
      }
      const result = await runUiAutomation(
        config.uiaScript,
        boundedUiRequest({
          operation: 'inspect',
          windowHandle: input.windowHandle,
          maxDepth: input.maxDepth ?? 5,
          maxElements: input.maxElements ?? 500
        }),
        { timeoutMs: 30_000 }
      );
      const point = centerOfBounds(result.window?.bounds);
      if (point && config.pointerOverlayEnabled) {
        await moveVirtualPointer(config.pointerStatePath, point);
      }
      return sendJson(response, 200, result);
    }

    if (request.method === 'POST' && url.pathname === '/uia/actions') {
      if (rejectWhenPaused(response)) return;
      let input;
      try {
        input = validateActionRequest(await readJson(request));
      } catch (error) {
        return sendJson(response, 400, { error: 'invalid_uia_action', message: error.message });
      }
      await audit('action.confirmed', {
        channel: 'uia', action: input.action, windowHandle: input.windowHandle,
        target: input.selector?.automationId || input.selector?.name || input.selector?.controlType || null
      });
      if (rejectWhenPaused(response)) return;
      let result;
      try {
        result = await runUiAutomation(
          config.uiaScript,
          boundedUiRequest({ operation: 'action', ...input })
        );
      } catch (error) {
        await audit('action.failed', {
          channel: 'uia', action: input.action, windowHandle: input.windowHandle,
          error: String(error.message || error).slice(0, 400)
        });
        throw error;
      }
      const point = centerOfBounds(result.targetAfter?.bounds ?? result.targetBefore?.bounds);
      if (point && config.pointerOverlayEnabled) {
        await moveVirtualPointer(config.pointerStatePath, point);
      }
      await audit('action.executed', {
        channel: 'uia', action: input.action, windowHandle: input.windowHandle,
        processName: result.window?.processName || null
      });
      return sendJson(response, 200, result);
    }

    if (request.method === 'POST' && url.pathname === '/pointer/actions') {
      if (rejectWhenPaused(response)) return;
      let action;
      try {
        action = normalizePointerAction(await readJson(request));
      } catch (error) {
        return sendJson(response, 400, { error: 'invalid_pointer_action', message: error.message });
      }
      const recordInTeaching = teachingSession?.window?.nativeWindowHandle === action.windowHandle;
      const inspected = await runUiAutomation(
        config.uiaScript,
        boundedUiRequest({
          operation: 'inspect',
          windowHandle: action.windowHandle,
          maxDepth: recordInTeaching ? 8 : 0,
          maxElements: recordInTeaching ? 1000 : 1
        })
      );
      const display = resolveUiAutomationDisplay(diagnostics, config.assignedDisplay);
      const bridgeRequest = createBoundedPointerRequest({
        action,
        allowedBounds: display.bounds,
        forbiddenProcessNames: ['ChatGPT', 'Codex', 'cmd', 'conhost', 'OpenConsole', 'powershell', 'pwsh', 'WindowsTerminal']
      });
      const pointerPoint = action.action === 'drag' ? action.to : action.point;
      await audit('action.confirmed', {
        channel: 'direct-window', action: action.action, key: action.key || null,
        windowHandle: action.windowHandle, processName: inspected.window?.processName || null
      });
      if (rejectWhenPaused(response)) return;
      if (pointerPoint && config.pointerOverlayEnabled) await moveVirtualPointer(config.pointerStatePath, pointerPoint);
      let result;
      try {
        result = await runPointerAction(config.pointerBridgeScript, bridgeRequest, { timeoutMs: 10_000 });
      } catch (error) {
        await audit('action.failed', {
          channel: 'direct-window', action: action.action, key: action.key || null,
          windowHandle: action.windowHandle, processName: inspected.window?.processName || null,
          error: String(error.message || error).slice(0, 400)
        });
        throw error;
      }
      await audit('action.executed', {
        channel: 'direct-window', action: action.action, key: action.key || null,
        windowHandle: action.windowHandle, processName: result.processName || null,
        transport: result.transport
      });
      if (recordInTeaching && teachingSession) {
        const event = pointerActionToTeachingEvent({
          action,
          elements: inspected.elements,
          atMs: Date.now() - teachingSession.startedAtMs
        });
        if (event) teachingSession.injectedEvents.push(event);
      }
      return sendJson(response, 200, {
        mode: 'independent-window-input',
        actionsPerformed: true,
        window: inspected.window,
        pointer: pointerPoint,
        result
      });
    }

    if (request.method === 'POST' && url.pathname === '/missions') {
      pruneMissions();
      if (teachingSession) {
        return sendJson(response, 409, { error: 'teaching_active', message: 'Finish or cancel the demonstration before starting a mission.' });
      }
      const input = await readJson(request);
      if (!Number.isInteger(input.windowHandle) || input.windowHandle <= 0) {
        return sendJson(response, 400, { error: 'invalid_window', message: 'windowHandle must be a positive integer.' });
      }
      let instruction;
      try {
        instruction = normalizeAgentInstruction(input.instruction);
      } catch (error) {
        return sendJson(response, 400, { error: 'invalid_instruction', message: error.message });
      }
      const inspected = await runUiAutomation(
        config.uiaScript,
        boundedUiRequest({ operation: 'inspect', windowHandle: input.windowHandle, maxDepth: 0, maxElements: 1 }),
        { timeoutMs: 30_000 }
      );
      const missionId = randomUUID();
      const now = Date.now();
      const mission = {
        missionId,
        instruction,
        windowHandle: input.windowHandle,
        processId: inspected.window.processId,
        window: inspected.window,
        stepCount: 0,
        maxSteps: Math.min(Math.max(Math.round(Number(input.maxSteps) || 20), 2), 50),
        status: 'active',
        history: [],
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + missionTtlMs).toISOString(),
        expiresAtMs: now + missionTtlMs
      };
      missions.set(missionId, mission);
      await audit('mission.started', {
        missionId, windowHandle: mission.windowHandle, processName: mission.window.processName,
        maxSteps: mission.maxSteps
      });
      return sendJson(response, 201, { mission: publicMission(mission), actionsPerformed: false });
    }

    if (request.method === 'GET' && url.pathname === '/missions/status') {
      pruneMissions();
      const mission = missions.get(url.searchParams.get('missionId'));
      if (!mission) return sendJson(response, 404, { error: 'mission_not_found', message: 'Mission expired or does not exist.' });
      return sendJson(response, 200, { mission: publicMission(mission) });
    }

    if (request.method === 'POST' && url.pathname === '/missions/plan-next') {
      pruneMissions();
      pruneActionPlans();
      const input = await readJson(request);
      const mission = typeof input.missionId === 'string' ? missions.get(input.missionId) : null;
      if (!mission) return sendJson(response, 404, { error: 'mission_not_found', message: 'Mission expired or does not exist.' });
      if (!['active', 'needs_review'].includes(mission.status)) {
        return sendJson(response, 409, { error: 'mission_not_active', message: `Mission status is ${mission.status}.` });
      }
      if (mission.stepCount >= mission.maxSteps) {
        mission.status = 'limit_reached';
        await audit('mission.limit_reached', { missionId: mission.missionId, stepCount: mission.stepCount });
        return sendJson(response, 409, {
          error: 'mission_step_limit',
          message: 'Mission step limit was reached. Review the result and start a new mission if needed.',
          mission: publicMission(mission)
        });
      }
      try {
        const { plan, vision } = await createWindowActionPlan({
          windowHandle: mission.windowHandle,
          instruction: mission.instruction,
          mission
        });
        if (plan.proposal.action.type === 'done') {
          mission.status = 'complete';
          mission.completedAt = new Date().toISOString();
          mission.history.push({
            step: mission.stepCount,
            action: { type: 'done' },
            expectedResult: plan.proposal.expectedResult,
            validation: { success: true, evidence: plan.proposal.observation }
          });
          await audit('mission.completed', { missionId: mission.missionId, stepCount: mission.stepCount });
        }
        return sendJson(response, 201, { ...publicActionPlan(plan, vision), mission: publicMission(mission) });
      } catch (error) {
        if (error.code === 'invalid_local_plan') {
          return sendJson(response, 422, {
            error: 'invalid_local_plan', message: error.message, rawLocalModelOutput: error.rawLocalModelOutput,
            abortReason: error.abortReason, plannedProposal: error.plannedProposal,
            visualRefinement: error.visualRefinement,
            mission: publicMission(mission)
          });
        }
        if (error.code === 'stale_mission') {
          mission.status = 'needs_review';
          return sendJson(response, 409, { error: 'stale_mission', message: error.message, mission: publicMission(mission) });
        }
        throw error;
      }
    }

    if (request.method === 'POST' && url.pathname === '/missions/cancel') {
      const input = await readJson(request);
      const mission = typeof input.missionId === 'string' ? missions.get(input.missionId) : null;
      if (!mission) return sendJson(response, 404, { error: 'mission_not_found', message: 'Mission does not exist.' });
      mission.status = 'cancelled';
      await audit('mission.cancelled', { missionId: mission.missionId, stepCount: mission.stepCount });
      missions.delete(mission.missionId);
      return sendJson(response, 200, { missionId: mission.missionId, status: 'cancelled' });
    }

    if (request.method === 'POST' && url.pathname === '/agent/plan-window') {
      pruneActionPlans();
      const input = await readJson(request);
      if (!Number.isInteger(input.windowHandle) || input.windowHandle <= 0) {
        return sendJson(response, 400, { error: 'invalid_window', message: 'windowHandle must be a positive integer.' });
      }
      let instruction;
      try {
        instruction = normalizeAgentInstruction(input.instruction);
      } catch (error) {
        return sendJson(response, 400, { error: 'invalid_instruction', message: error.message });
      }

      try {
        const { plan, vision } = await createWindowActionPlan({
          windowHandle: input.windowHandle,
          instruction
        });
        return sendJson(response, 201, publicActionPlan(plan, vision));
      } catch (error) {
        if (error.code !== 'invalid_local_plan') throw error;
        return sendJson(response, 422, {
          error: 'invalid_local_plan',
          message: error.message,
          rawLocalModelOutput: error.rawLocalModelOutput,
          abortReason: error.abortReason,
          plannedProposal: error.plannedProposal,
          visualRefinement: error.visualRefinement
        });
      }
    }

    if (request.method === 'POST' && url.pathname === '/agent/execute-plan') {
      if (rejectWhenPaused(response)) return;
      pruneActionPlans();
      const input = await readJson(request);
      if (typeof input.planId !== 'string' || !input.planId) {
        return sendJson(response, 400, { error: 'invalid_plan_id', message: 'planId is required.' });
      }
      const plan = actionPlans.get(input.planId);
      if (!plan) return sendJson(response, 404, { error: 'plan_not_found', message: 'Plan expired or does not exist.' });
      if (plan.status !== 'planned') return sendJson(response, 409, { error: 'plan_already_used', message: 'Plan was already executed.' });
      if (!plan.policy.allowExecution) {
        const mission = plan.missionId ? missions.get(plan.missionId) : null;
        if (mission) mission.status = 'needs_review';
        await audit('plan.blocked', {
          planId: plan.planId, missionId: plan.missionId, action: plan.proposal.action.type,
          reason: plan.policy.reason
        });
        return sendJson(response, 409, {
          error: 'plan_blocked_by_policy',
          message: plan.policy.reason,
          policy: plan.policy,
          mission: publicMission(mission)
        });
      }
      if (plan.policy.requiresConfirmation && input.confirmed !== true) {
        return sendJson(response, 409, {
          error: 'confirmation_required',
          message: 'confirmed=true is required before this action.',
          risk: { level: plan.policy.effectiveRisk, reason: plan.policy.reason }
        });
      }
      if (plan.proposal.action.type === 'done') {
        plan.status = 'executed';
        await audit('plan.completed', { planId: plan.planId, action: 'done', actionsPerformed: false });
        return sendJson(response, 200, { planId: plan.planId, actionsPerformed: false, done: true, proposal: plan.proposal });
      }

      const inspected = await runUiAutomation(
        config.uiaScript,
        boundedUiRequest({ operation: 'inspect', windowHandle: plan.window.nativeWindowHandle, maxDepth: 0, maxElements: 1 }),
        { timeoutMs: 30_000 }
      );
      if (!sameWindowContext(inspected.window, plan.window) || !sameBounds(inspected.window.bounds, plan.window.bounds)) {
        return sendJson(response, 409, {
          error: 'stale_plan',
          message: 'The target window, active document, position, size, or process changed after planning. Create a new plan.'
        });
      }

      await audit('action.confirmed', {
        channel: 'local-agent', planId: plan.planId, action: plan.proposal.action.type,
        windowHandle: plan.window.nativeWindowHandle, processName: plan.window.processName,
        riskLevel: plan.proposal.risk?.level || null
      });
      if (rejectWhenPaused(response)) return;

      let actionResult = null;
      let pointerPoint = null;
      try {
        if (plan.proposal.action.type === 'wait') {
          await new Promise((resolve) => setTimeout(resolve, plan.proposal.action.durationMs));
        } else {
          const display = resolveUiAutomationDisplay(diagnostics, config.assignedDisplay);
          const bridgeRequest = createBoundedPointerRequest({
            action: plan.pointerAction,
            allowedBounds: display.bounds,
            forbiddenProcessNames: ['ChatGPT', 'Codex', 'cmd', 'conhost', 'OpenConsole', 'powershell', 'pwsh', 'WindowsTerminal']
          });
          pointerPoint = bridgeRequest.action === 'drag' ? bridgeRequest.to : bridgeRequest.point;
          actionResult = await executeGroundedAction({
            action: plan.proposal.action,
            grounding: plan.grounding,
            execute: async () => {
              if (pointerPoint && config.pointerOverlayEnabled) {
                await moveVirtualPointer(config.pointerStatePath, pointerPoint);
              }
              return runPointerAction(config.pointerBridgeScript, bridgeRequest, { timeoutMs: 10_000 });
            }
          });
        }
      } catch (error) {
        const mission = plan.missionId ? missions.get(plan.missionId) : null;
        if (mission) mission.status = 'needs_review';
        await audit('action.failed', {
          channel: 'local-agent', planId: plan.planId, action: plan.proposal.action.type,
          windowHandle: plan.window.nativeWindowHandle, processName: plan.window.processName,
          error: String(error.message || error).slice(0, 400)
        });
        throw error;
      }

      const { observation: afterObservation, settling } = await captureWindowAfterSettling({
        windowHandle: plan.window.nativeWindowHandle,
        beforeObservation: plan.observation,
        label: 'agent-after'
      });
      const validationVision = await analyzeImageWithLmStudio({
        baseUrl: config.lmStudioBaseUrl,
        model: config.lmStudioModel,
        imagePath: afterObservation.outputPath,
        systemPrompt: VALIDATOR_SYSTEM_PROMPT,
        prompt: `Задача: ${plan.instruction}\nВыполненное действие: ${JSON.stringify(plan.proposal.action)}\nОжидаемый видимый результат: ${plan.proposal.expectedResult}`,
        maxOutputTokens: 700
      });
      let validation;
      try {
        validation = normalizeValidatorOutput(validationVision.analysis);
      } catch (error) {
        validation = { success: false, evidence: '', confidence: 0, nextStep: '', limitations: [error.message] };
      }
      let validationSource = 'full-window';
      let focusedValidation = null;
      if (!validation.success && ['click', 'doubleClick'].includes(plan.proposal.action.type)) {
        const focusedCrop = await cropImageRegion({
          scriptPath: config.imageRegionScript,
          inputPath: afterObservation.outputPath,
          outputPath: path.join(config.observationsDirectory, `${Date.now()}-${randomUUID()}-validator-crop.png`),
          centerX: plan.proposal.action.point.x * Math.max(0, afterObservation.bounds.width - 1),
          centerY: plan.proposal.action.point.y * Math.max(0, afterObservation.bounds.height - 1),
          width: 220,
          height: 220,
          scale: 3
        });
        try {
          const focusedVision = await analyzeImageWithLmStudio({
            baseUrl: config.lmStudioBaseUrl,
            model: config.lmStudioModel,
            imagePath: focusedCrop.outputPath,
            systemPrompt: FOCUSED_VALIDATOR_SYSTEM_PROMPT,
            prompt: `Выполненное действие: ${JSON.stringify(plan.proposal.action)}\nОжидаемый локальный результат: ${plan.proposal.expectedResult}\nПроверь только прямое видимое состояние элемента в увеличенной области клика.`,
            maxOutputTokens: 500
          });
          const focused = normalizeValidatorOutput(focusedVision.analysis);
          const merged = mergeFocusedValidation(validation, focused);
          validation = merged.validation;
          validationSource = merged.source;
          focusedValidation = {
            ...focused,
            screenshot: focusedCrop.outputPath,
            stats: focusedVision.stats
          };
        } catch (error) {
          focusedValidation = {
            success: false,
            evidence: '',
            confidence: 0,
            nextStep: '',
            limitations: [String(error.message || error)],
            screenshot: focusedCrop.outputPath
          };
        }
      }

      plan.status = 'executed';
      plan.executedAt = new Date().toISOString();
      plan.validation = {
        success: validation.success,
        evidence: validation.evidence,
        confidence: validation.confidence,
        limitations: validation.limitations,
        source: validationSource
      };
      plan.afterScreenshot = afterObservation.outputPath;
      const mission = plan.missionId ? missions.get(plan.missionId) : null;
      if (mission) {
        mission.stepCount += 1;
        mission.history.push({
          step: mission.stepCount,
          action: plan.proposal.action,
          expectedResult: plan.proposal.expectedResult,
          validation: {
            success: validation.success,
            evidence: validation.evidence,
            confidence: validation.confidence,
            limitations: validation.limitations,
            source: validationSource
          }
        });
        mission.status = validation.success ? 'active' : 'needs_review';
        if (mission.stepCount >= mission.maxSteps) mission.status = 'limit_reached';
        mission.expiresAtMs = Date.now() + missionTtlMs;
        mission.expiresAt = new Date(mission.expiresAtMs).toISOString();
      }
      await audit('action.executed', {
        channel: 'local-agent', planId: plan.planId, action: plan.proposal.action.type,
        windowHandle: plan.window.nativeWindowHandle, processName: plan.window.processName,
        validationSuccess: validation.success === true,
        validationSource,
        transport: actionResult?.transport || null,
        settlingReason: settling.reason,
        settlingElapsedMs: settling.elapsedMs
      });
      return sendJson(response, 200, {
        planId: plan.planId,
        status: plan.status,
        executedAt: plan.executedAt,
        actionsPerformed: plan.proposal.action.type !== 'wait',
        instruction: plan.instruction,
        proposal: plan.proposal,
        pointer: pointerPoint,
        actionResult,
        validation,
        validationSource,
        focusedValidation,
        settling,
        afterScreenshot: afterObservation.outputPath,
        stats: validationVision.stats,
        mission: publicMission(mission)
      });
    }

    if (request.method === 'POST' && ['/feedback/rate', '/feedback/like'].includes(url.pathname)) {
      const input = await readJson(request);
      const rating = url.pathname === '/feedback/like' ? 'positive' : input.rating;
      if (!['positive', 'negative'].includes(rating)) {
        return sendJson(response, 400, { error: 'invalid_rating', message: 'rating must be positive or negative.' });
      }

      let record;
      let mission = null;
      let run = null;
      if (typeof input.planId === 'string' && input.planId) {
        const plan = actionPlans.get(input.planId);
        if (!plan) {
          return sendJson(response, 404, { error: 'plan_not_found', message: 'The completed step expired or does not exist.' });
        }
        if (plan.status !== 'executed') {
          return sendJson(response, 409, { error: 'step_not_executed', message: 'Only a completed step can be rated.' });
        }
        record = buildPlanFeedback({ plan, rating, feedbackId: randomUUID() });
        mission = plan.missionId ? missions.get(plan.missionId) : null;
        if (mission?.history.length) {
          mission.history[mission.history.length - 1].humanFeedback = rating;
          if (mission.status !== 'limit_reached') mission.status = rating === 'positive' ? 'active' : 'needs_review';
        }
      } else if (typeof input.runId === 'string' && input.runId) {
        pruneSkillRuns();
        run = skillRuns.get(input.runId);
        if (!run) return sendJson(response, 404, { error: 'skill_run_not_found', message: 'Skill run expired or does not exist.' });
        if (!run.lastExecution || Number(input.executedStepIndex) !== run.lastExecution.executedStepIndex) {
          return sendJson(response, 409, { error: 'skill_step_not_executed', message: 'Only the latest executed skill step can be rated.' });
        }
        const execution = run.lastExecution;
        record = buildStepFeedback({
          feedbackId: randomUUID(),
          rating,
          runId: run.runId,
          skillId: run.skill.skillId,
          stepIndex: execution.executedStepIndex,
          instruction: run.skill.instruction,
          application: execution.window || run.skill.application,
          action: publicLearnedStep(execution.step),
          reason: `Demonstrated step ${execution.executedStepIndex + 1}`,
          automatedValidation: execution.validation
        });
        run.lastExecution.humanFeedback = rating;
      } else {
        return sendJson(response, 400, { error: 'invalid_feedback_target', message: 'planId or runId is required.' });
      }

      const saved = await appendStepFeedback(config.feedbackLogPath, record);
      await audit('feedback.step_rated', {
        feedbackId: saved.record.feedbackId,
        rating,
        planId: saved.record.planId,
        missionId: saved.record.missionId,
        runId: saved.record.runId,
        skillId: saved.record.skillId,
        stepIndex: saved.record.stepIndex,
        processName: saved.record.application?.processName || null,
        created: saved.created
      });
      return sendJson(response, saved.created ? 201 : 200, {
        learned: true,
        rating,
        created: saved.created,
        feedback: saved.record,
        mission: publicMission(mission),
        skillRun: run ? { runId: run.runId, status: run.status, stepIndex: run.stepIndex } : null,
        message: rating === 'positive'
          ? 'The successful step will be reused as compact experience.'
          : 'The failed step will be avoided or changed in future plans.'
      });
    }

    if (request.method === 'GET' && url.pathname === '/teach/status') {
      const preview = teachingSession ? await readTeachingPreview(teachingSession) : null;
      return sendJson(response, 200, {
        active: Boolean(teachingSession),
        session: teachingSession ? {
          sessionId: teachingSession.sessionId,
          name: teachingSession.name,
          instruction: teachingSession.instruction,
          startedAt: teachingSession.startedAt,
          expiresAt: teachingSession.expiresAt,
          window: teachingSession.window,
          recorderProcessId: teachingSession.recorder.processId,
          preview
        } : null
      });
    }

    if (request.method === 'POST' && url.pathname === '/teach/start') {
      if (teachingSession) {
        return sendJson(response, 409, { error: 'teaching_already_active', message: 'Finish or cancel the current demonstration first.' });
      }
      pruneMissions();
      if ([...missions.values()].some((mission) => ['active', 'needs_review'].includes(mission.status))) {
        return sendJson(response, 409, { error: 'mission_active', message: 'Stop the active AI mission before recording a demonstration.' });
      }
      const input = await readJson(request);
      if (!Number.isInteger(input.windowHandle) || input.windowHandle <= 0) {
        return sendJson(response, 400, { error: 'invalid_window', message: 'windowHandle must be a positive integer.' });
      }
      let name;
      let instruction;
      try {
        instruction = normalizeTeachingText(input.instruction, 'instruction', 4_000);
        name = normalizeTeachingText(input.name || instruction.slice(0, 96), 'name', 128);
      } catch (error) {
        return sendJson(response, 400, { error: 'invalid_teaching_request', message: error.message });
      }
      const maxDurationMs = Math.min(Math.max(Math.round(Number(input.maxDurationSeconds ?? 120) * 1_000), 10_000), 180_000);
      const inspected = await runUiAutomation(
        config.uiaScript,
        boundedUiRequest({ operation: 'inspect', windowHandle: input.windowHandle, maxDepth: 7, maxElements: 1_000 }),
        { timeoutMs: 30_000 }
      );
      const sessionId = randomUUID();
      const sessionDirectory = path.join(config.teachingDirectory, sessionId);
      await fs.mkdir(sessionDirectory, { recursive: true });
      const beforePath = path.join(sessionDirectory, 'before.png');
      const beforeObservation = await captureWindow({
        scriptPath: config.windowCaptureScript,
        windowHandle: input.windowHandle,
        outputPath: beforePath
      });
      const outputPath = path.join(sessionDirectory, 'events.json');
      const livePath = path.join(sessionDirectory, 'live.json');
      const readyPath = path.join(sessionDirectory, 'ready');
      const stopPath = path.join(sessionDirectory, 'stop');
      const display = resolveUiAutomationDisplay(diagnostics, config.assignedDisplay);
      const recorder = await startTeachingRecorder({
        scriptPath: config.teachingRecorderScript,
        recorderConfig: {
          targetWindowHandle: input.windowHandle,
          allowedBounds: display.bounds,
          outputPath,
          livePath,
          readyPath,
          stopPath,
          maxDurationMs
        }
      });
      if (!await waitForFile(readyPath, 12_000)) {
        await fs.writeFile(stopPath, 'startup timeout', 'utf8');
        return sendJson(response, 500, { error: 'recorder_start_failed', message: 'The demonstration recorder did not become ready.' });
      }
      const now = Date.now();
      teachingSession = {
        sessionId,
        name,
        instruction,
        startedAt: new Date(now).toISOString(),
        startedAtMs: now,
        expiresAt: new Date(now + maxDurationMs).toISOString(),
        sessionDirectory,
        outputPath,
        livePath,
        readyPath,
        stopPath,
        beforeObservation,
        beforeElements: inspected.elements,
        window: inspected.window,
        recorder,
        injectedEvents: []
      };
      await audit('teaching.started', {
        sessionId, windowHandle: input.windowHandle, processName: inspected.window?.processName || null,
        maxDurationMs, passwordValuesRecorded: false
      });
      return sendJson(response, 201, {
        active: true,
        sessionId,
        name,
        instruction,
        startedAt: teachingSession.startedAt,
        expiresAt: teachingSession.expiresAt,
        window: inspected.window,
        scope: { display: display.deviceName, bounds: display.bounds, targetWindowOnly: true },
        privacy: { passwordValuesRecorded: false, primaryDisplayRecorded: false },
        message: 'Demonstration recording is active only inside the selected window.'
      });
    }

    if (request.method === 'POST' && url.pathname === '/teach/stop') {
      const input = await readJson(request);
      if (!teachingSession || input.sessionId !== teachingSession.sessionId) {
        return sendJson(response, 404, { error: 'teaching_session_not_found', message: 'No matching demonstration is active.' });
      }
      const session = teachingSession;
      await fs.writeFile(session.stopPath, new Date().toISOString(), 'utf8');
      if (!await waitForFile(session.outputPath, 12_000)) {
        teachingSession = null;
        return sendJson(response, 500, { error: 'recorder_stop_failed', message: 'The demonstration recorder did not produce an event file.' });
      }
      const recording = JSON.parse(await fs.readFile(session.outputPath, 'utf8'));
      recording.events = [...(recording.events ?? []), ...(session.injectedEvents ?? [])];
      const inspected = await runUiAutomation(
        config.uiaScript,
        boundedUiRequest({ operation: 'inspect', windowHandle: session.window.nativeWindowHandle, maxDepth: 7, maxElements: 1_000 }),
        { timeoutMs: 30_000 }
      );
      const afterPath = path.join(session.sessionDirectory, 'after.png');
      const afterObservation = await captureWindow({
        scriptPath: config.windowCaptureScript,
        windowHandle: session.window.nativeWindowHandle,
        outputPath: afterPath
      });
      const skillId = randomUUID();
      let skill;
      try {
        skill = buildSkillFromRecording({
          skillId,
          name: session.name,
          instruction: session.instruction,
          window: inspected.window,
          recording,
          elements: inspected.elements
        });
      } catch (error) {
        teachingSession = null;
        return sendJson(response, 422, {
          error: 'empty_demonstration',
          message: error.message,
          recording: { eventCount: recording.events?.length ?? 0, warnings: recording.warnings ?? [] }
        });
      }
      await fs.mkdir(config.skillsDirectory, { recursive: true });
      const skillPath = path.join(config.skillsDirectory, `${skillId}.json`);
      await fs.writeFile(skillPath, JSON.stringify(skill, null, 2), 'utf8');
      teachingSession = null;
      await audit('teaching.saved', {
        sessionId: session.sessionId, skillId, processName: skill.application.processName,
        stepCount: skill.steps.length, passwordValuesStored: false
      });
      return sendJson(response, 201, {
        active: false,
        sessionId: session.sessionId,
        skill,
        skillPath,
        evidence: {
          eventCount: recording.events?.length ?? 0,
          beforeScreenshot: session.beforeObservation.outputPath,
          afterScreenshot: afterObservation.outputPath
        }
      });
    }

    if (request.method === 'POST' && url.pathname === '/teach/cancel') {
      const input = await readJson(request);
      if (!teachingSession || input.sessionId !== teachingSession.sessionId) {
        return sendJson(response, 404, { error: 'teaching_session_not_found', message: 'No matching demonstration is active.' });
      }
      await fs.writeFile(teachingSession.stopPath, 'cancelled', 'utf8');
      await audit('teaching.cancelled', { sessionId: teachingSession.sessionId });
      teachingSession = null;
      return sendJson(response, 200, { active: false, cancelled: true });
    }

    if (request.method === 'POST' && url.pathname === '/skills/recommend') {
      const input = await readJson(request);
      if (!Number.isInteger(input.windowHandle) || input.windowHandle <= 0) {
        return sendJson(response, 400, { error: 'invalid_window', message: 'windowHandle must be a positive integer.' });
      }
      let instruction;
      try {
        instruction = normalizeAgentInstruction(input.instruction);
      } catch (error) {
        return sendJson(response, 400, { error: 'invalid_instruction', message: error.message });
      }
      const inspected = await runUiAutomation(
        config.uiaScript,
        boundedUiRequest({ operation: 'inspect', windowHandle: input.windowHandle, maxDepth: 0, maxElements: 1 }),
        { timeoutMs: 30_000 }
      );
      const allSkills = await loadAllSkills();
      const candidates = allSkills.filter((skill) =>
        String(skill.application?.processName || '').toLowerCase() === String(inspected.window.processName || '').toLowerCase()
      );
      if (!candidates.length) {
        return sendJson(response, 200, {
          actionsPerformed: false,
          window: inspected.window,
          candidateCount: 0,
          recommendation: { skillId: null, confidence: 0, reason: 'Для этой программы ещё нет выученных навыков.' },
          skill: null
        });
      }
      const publicCandidates = candidates.map(publicSkillCandidate);
      const selection = await analyzeTextWithLmStudio({
        baseUrl: config.lmStudioBaseUrl,
        model: config.lmStudioModel,
        systemPrompt: SKILL_ROUTER_SYSTEM_PROMPT,
        prompt: `Текущая программа: ${inspected.window.processName}\nЗадача пользователя: ${instruction}\nКандидаты: ${JSON.stringify(publicCandidates)}`,
        maxOutputTokens: 500
      });
      let recommendation;
      try {
        recommendation = normalizeSkillRecommendation(selection.analysis, candidates);
      } catch (error) {
        return sendJson(response, 422, {
          error: 'invalid_skill_recommendation', message: error.message, rawLocalModelOutput: selection.raw
        });
      }
      const skill = recommendation.skillId
        ? candidates.find((candidate) => candidate.skillId === recommendation.skillId) ?? null
        : null;
      await audit('skill.recommended', {
        skillId: skill?.skillId || null,
        processName: inspected.window.processName,
        candidateCount: candidates.length,
        confidence: recommendation.confidence
      });
      return sendJson(response, 200, {
        actionsPerformed: false,
        window: inspected.window,
        candidateCount: candidates.length,
        recommendation,
        skill,
        localModel: selection.model,
        stats: selection.stats
      });
    }

    if (request.method === 'GET' && url.pathname === '/skills') {
      const skills = await loadAllSkills();
      return sendJson(response, 200, { count: skills.length, skills });
    }

    if (request.method === 'POST' && url.pathname === '/skills/prepare') {
      pruneSkillRuns();
      if (teachingSession) {
        return sendJson(response, 409, { error: 'teaching_active', message: 'Finish or cancel the demonstration before preparing a skill.' });
      }
      pruneMissions();
      if ([...missions.values()].some((mission) => ['active', 'needs_review'].includes(mission.status))) {
        return sendJson(response, 409, { error: 'mission_active', message: 'Stop the active mission before preparing a learned skill.' });
      }
      const input = await readJson(request);
      if (!Number.isInteger(input.windowHandle) || input.windowHandle <= 0) {
        return sendJson(response, 400, { error: 'invalid_window', message: 'windowHandle must be a positive integer.' });
      }
      let loaded;
      try {
        loaded = await loadSkill(input.skillId);
      } catch (error) {
        return sendJson(response, error.code === 'ENOENT' ? 404 : 400, { error: 'skill_not_found', message: error.message });
      }
      const inspected = await runUiAutomation(
        config.uiaScript,
        boundedUiRequest({ operation: 'inspect', windowHandle: input.windowHandle, maxDepth: 0, maxElements: 1 }),
        { timeoutMs: 30_000 }
      );
      try {
        validateSkillForWindow(loaded.skill, inspected.window);
      } catch (error) {
        return sendJson(response, 409, { error: 'skill_app_mismatch', message: error.message });
      }
      const runId = randomUUID();
      const now = Date.now();
      const run = {
        runId,
        skill: loaded.skill,
        skillPath: loaded.skillPath,
        windowHandle: input.windowHandle,
        processId: inspected.window.processId,
        stepIndex: 0,
        status: 'ready',
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 10 * 60 * 1000).toISOString(),
        expiresAtMs: now + 10 * 60 * 1000
      };
      skillRuns.set(runId, run);
      return sendJson(response, 201, {
        runId,
        status: run.status,
        createdAt: run.createdAt,
        expiresAt: run.expiresAt,
        skill: { skillId: run.skill.skillId, name: run.skill.name, instruction: run.skill.instruction, stepCount: run.skill.steps.length },
        window: inspected.window,
        currentStep: publicLearnedStepForProcess(run.skill.steps[0], inspected.window.processName),
        actionsPerformed: false
      });
    }

    if (request.method === 'POST' && url.pathname === '/skills/execute-step') {
      if (rejectWhenPaused(response)) return;
      pruneSkillRuns();
      const input = await readJson(request);
      const run = typeof input.runId === 'string' ? skillRuns.get(input.runId) : null;
      if (!run) return sendJson(response, 404, { error: 'skill_run_not_found', message: 'Skill run expired or does not exist.' });
      if (run.status === 'complete') return sendJson(response, 409, { error: 'skill_run_complete', message: 'All learned steps were already executed.' });
      if (input.confirmed !== true) {
        return sendJson(response, 409, { error: 'confirmation_required', message: 'confirmed=true is required for every learned step.' });
      }
      const step = run.skill.steps[run.stepIndex];
      const inspected = await runUiAutomation(
        config.uiaScript,
        boundedUiRequest({
          operation: 'inspect',
          windowHandle: run.windowHandle,
          maxDepth: step.target ? 8 : 0,
          maxElements: step.target ? 1000 : 1
        }),
        { timeoutMs: 30_000 }
      );
      try {
        validateSkillForWindow(run.skill, inspected.window);
      } catch (error) {
        return sendJson(response, 409, { error: 'skill_app_mismatch', message: error.message });
      }
      if (inspected.window.processId !== run.processId) {
        return sendJson(response, 409, { error: 'stale_skill_run', message: 'The target application was restarted. Prepare the skill again.' });
      }

      const grounding = groundLearnedStepToElements(step, inspected.elements, inspected.window.bounds);
      const pointerAction = learnedStepToPointerAction(grounding.step, inspected.window.bounds, run.windowHandle);
      const pointerPoint = pointerAction.action === 'drag' ? pointerAction.to : (pointerAction.point ?? null);
      const stepPolicy = evaluateLearnedStepPolicy({ step, processName: inspected.window.processName });
      await fs.mkdir(config.observationsDirectory, { recursive: true });
      const beforeObservation = await captureWindow({
        scriptPath: config.windowCaptureScript,
        windowHandle: run.windowHandle,
        outputPath: path.join(config.observationsDirectory, `${Date.now()}-${randomUUID()}-learned-before.png`)
      });
      await audit('action.confirmed', {
        channel: 'learned-skill', runId: run.runId, skillId: run.skill.skillId,
        stepIndex: run.stepIndex, action: step.type, key: step.type === 'pressKey' ? step.key : null,
        windowHandle: run.windowHandle, processName: inspected.window.processName,
        riskLevel: stepPolicy.effectiveRisk, externalEnvironment: stepPolicy.externalEnvironment
      });
      if (rejectWhenPaused(response)) return;
      if (pointerPoint && config.pointerOverlayEnabled) await moveVirtualPointer(config.pointerStatePath, pointerPoint);
      let actionResult;
      let transport = 'direct-window';
      try {
        if (step.target && step.type === 'click' && step.button !== 'right') {
          try {
            actionResult = await runUiAutomation(
              config.uiaScript,
              boundedUiRequest({ operation: 'action', windowHandle: run.windowHandle, selector: step.target, action: 'invoke', confirmed: true })
            );
            transport = 'uia-selector';
          } catch { }
        } else if (step.target && step.type === 'typeText') {
          try {
            actionResult = await runUiAutomation(
              config.uiaScript,
              boundedUiRequest({ operation: 'action', windowHandle: run.windowHandle, selector: step.target, action: 'setValue', value: step.text, confirmed: true })
            );
            transport = 'uia-selector';
          } catch { }
        }
        if (!actionResult) {
          const display = resolveUiAutomationDisplay(diagnostics, config.assignedDisplay);
          const bridgeRequest = createBoundedPointerRequest({
            action: pointerAction,
            allowedBounds: display.bounds,
            forbiddenProcessNames: ['ChatGPT', 'Codex', 'cmd', 'conhost', 'OpenConsole', 'powershell', 'pwsh', 'WindowsTerminal']
          });
          actionResult = await runPointerAction(config.pointerBridgeScript, bridgeRequest, { timeoutMs: 10_000 });
        }
      } catch (error) {
        await audit('action.failed', {
          channel: 'learned-skill', runId: run.runId, skillId: run.skill.skillId,
          stepIndex: run.stepIndex, action: step.type, windowHandle: run.windowHandle,
          processName: inspected.window.processName,
          error: String(error.message || error).slice(0, 400)
        });
        throw error;
      }

      const { observation: afterObservation, settling } = await captureWindowAfterSettling({
        windowHandle: run.windowHandle,
        beforeObservation,
        label: 'learned-step'
      });
      const validationVision = await analyzeImageWithLmStudio({
        baseUrl: config.lmStudioBaseUrl,
        model: config.lmStudioModel,
        imagePath: afterObservation.outputPath,
        systemPrompt: VALIDATOR_SYSTEM_PROMPT,
        prompt: `Выученный навык: ${run.skill.instruction}\nВыполнен шаг: ${JSON.stringify(publicLearnedStep(step))}\nПроверь, что интерфейс не показывает явную ошибку и шаг визуально применился.`,
        maxOutputTokens: 700
      });
      let validation;
      try {
        validation = normalizeValidatorOutput(validationVision.analysis);
      } catch (error) {
        validation = { success: false, evidence: '', confidence: 0, nextStep: '', limitations: [error.message] };
      }

      const executedStepIndex = run.stepIndex;
      run.stepIndex += 1;
      run.status = run.stepIndex >= run.skill.steps.length ? 'complete' : 'ready';
      run.lastExecution = {
        executedStepIndex,
        step,
        validation,
        window: inspected.window
      };
      await audit('action.executed', {
        channel: 'learned-skill', runId: run.runId, skillId: run.skill.skillId,
        stepIndex: executedStepIndex, action: step.type, key: step.type === 'pressKey' ? step.key : null,
        windowHandle: run.windowHandle, processName: inspected.window.processName,
        validationSuccess: validation.success === true,
        transport: actionResult?.transport || transport,
        riskLevel: stepPolicy.effectiveRisk, externalEnvironment: stepPolicy.externalEnvironment,
        settlingReason: settling.reason,
        settlingElapsedMs: settling.elapsedMs
      });
      return sendJson(response, 200, {
        runId: run.runId,
        status: run.status,
        actionsPerformed: true,
        executedStep: publicLearnedStepForProcess(step, inspected.window.processName),
        executedStepIndex,
        transport,
        pointer: pointerPoint,
        grounding,
        actionResult,
        validation,
        settling,
        afterScreenshot: afterObservation.outputPath,
        nextStep: run.status === 'ready'
          ? publicLearnedStepForProcess(run.skill.steps[run.stepIndex], inspected.window.processName)
          : null
      });
    }

    if (request.method === 'POST' && url.pathname === '/skills/cancel-run') {
      const input = await readJson(request);
      const run = typeof input.runId === 'string' ? skillRuns.get(input.runId) : null;
      if (!run) return sendJson(response, 404, { error: 'skill_run_not_found', message: 'Skill run does not exist.' });
      run.status = 'cancelled';
      skillRuns.delete(run.runId);
      return sendJson(response, 200, { runId: run.runId, status: 'cancelled' });
    }

    if (request.method === 'POST' && url.pathname === '/tasks') {
      let task;
      try {
        task = normalizeTask(await readJson(request));
      } catch (error) {
        return sendJson(response, 400, { error: 'invalid_task', message: error.message });
      }

      if (task.mode === 'execute') {
        return sendJson(response, 409, {
          error: 'confirmation_workflow_required',
          message: 'Use a selected-window mission or learned skill so every state-changing step can be confirmed.'
        });
      }

      return sendJson(response, 202, {
        taskId: randomUUID(),
        state: task.mode === 'inspect' ? 'inspected' : 'planned',
        mode: task.mode,
        prompt: task.prompt,
        sessionId: diagnostics?.session?.sessionId ?? null,
        plan: [
          'Observe only the selected window on the assigned AI display.',
          'Generate one bounded UI action and a validation check.',
          'Show the action and risk before execution.',
          'Execute only after explicit confirmation.'
        ]
      });
    }

    return sendJson(response, 404, { error: 'not_found' });
  } catch (error) {
    return sendJson(response, error.statusCode || 500, {
      error: 'worker_error',
      message: error.message
    });
  }
});

server.listen(config.workerPort, config.host, () => {
  console.log(`AI Workstation worker listening on http://${config.host}:${config.workerPort}`);
  console.log(`Windows session: ${diagnostics?.session?.sessionId ?? 'unknown'}`);
  console.log('Window-local AI control is ready; unconfirmed autonomous execution remains disabled.');
});
