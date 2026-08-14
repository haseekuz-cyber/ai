import { executeSavedSkillStepRequest, prepareSavedSkillRequest } from './skill-flow.js';
import {
  createAnarchyRecoveryState,
  decideAnarchyRecovery,
  resetAnarchyRecoveryState
} from './anarchy-recovery.js';
import {
  canRepeatSemanticObservation,
  findLatestSemanticObservation,
  semanticObservationGoal,
  summarizeSemanticObservation
} from './observation-flow.js';

const $ = (selector) => document.querySelector(selector);

const statusDot = $('#status-dot');
const statusText = $('#status-text');
const safetyToggle = $('#safety-toggle');
const fullShutdownButton = $('#full-shutdown-button');
const anarchyButton = $('#anarchy-button');
const programmerButton = $('#programmer-button');
const windowSelect = $('#window-select');
const taskInput = $('#task-input');
const taskButton = $('#task-button');
const taskStatus = $('#task-status');
const jarvisActivity = $('#jarvis-activity');
const stepCard = $('#step-card');
const stepNumber = $('#step-number');
const stepReason = $('#step-reason');
const stepAction = $('#step-action');
const stepResult = $('#step-result');
const stepTeacher = $('#step-teacher');
const executeButton = $('#execute-button');
const teachStepButton = $('#teach-step-button');
const feedbackCard = $('#feedback-card');
const feedbackTitle = $('#feedback-title');
const feedbackDetail = $('#feedback-detail');
const positiveButton = $('#positive-button');
const negativeButton = $('#negative-button');
const correctionCard = $('#correction-card');
const correctionTitle = $('#correction-title');
const correctionDetail = $('#correction-detail');
const correctionInput = $('#correction-input');
const correctionSubmit = $('#correction-submit');
const correctionDemo = $('#correction-demo');
const correctionSkip = $('#correction-skip');
const demoButton = $('#demo-button');
const demoRunButton = $('#demo-run-button');
const observationReview = $('#observation-review');
const observationUnderstoodButton = $('#observation-understood-button');
const observationRepeatButton = $('#observation-repeat-button');
const observationUnderstanding = $('#observation-understanding');
const demoTitle = $('#demo-title');
const demoStatus = $('#demo-status');
const demoLive = $('#demo-live');
const traceCanvas = $('#trace-canvas');
const eventCount = $('#event-count');
const keys = $('#keys');
const principlesCount = $('#principles-count');
const principlesList = $('#principles-list');
const teacherName = $('#teacher-name');
const teacherMission = $('#teacher-mission');
const teacherValues = $('#teacher-values');
const teacherSave = $('#teacher-save');
const teacherStatus = $('#teacher-status');
const teacherMessages = $('#teacher-messages');
const teacherMessage = $('#teacher-message');
const teacherScreenshot = $('#teacher-screenshot');
const teacherAttachment = $('#teacher-attachment');
const teacherSend = $('#teacher-send');
const teacherFixLast = $('#teacher-fix-last');
const teacherProposal = $('#teacher-proposal');
const teacherProposalSummary = $('#teacher-proposal-summary');
const teacherProposalFiles = $('#teacher-proposal-files');
const teacherProposalTests = $('#teacher-proposal-tests');
const teacherApply = $('#teacher-apply');
const teacherRollback = $('#teacher-rollback');
const teacherTask = $('#teacher-task');
const teacherTaskText = $('#teacher-task-text');
const teacherTaskCriteria = $('#teacher-task-criteria');
const teacherTaskRun = $('#teacher-task-run');

let selectedWindowHandle = null;
let currentAgentSessionId = null;
let currentAgentSessionMode = null;
let currentAgentSessionGoal = null;
let currentAgentAwaitingUser = false;
let currentMission = null;
let currentPlan = null;
let completedStep = null;
let currentSkillRun = null;
let latestDemonstratedSkillId = localStorage.getItem('ai-latest-skill-id') || null;
let latestObservedSkill = null;
let windowCatalog = [];
let teachingSession = null;
let teachingTimer = null;
let teachingRequested = false;
let paused = false;
let busy = false;
let pendingCorrection = null;
let stepTeachingContext = null;
let correctionResume = null;
let anarchyMode = false;
let anarchyResumeGoal = null;
let semanticReplayMode = false;
let anarchyRunId = 0;
let anarchyStepCount = 0;
let anarchyTimer = null;
let anarchyAwaitingCorrection = false;
let anarchyRecoveryState = createAnarchyRecoveryState();
let teacherProfileLoaded = false;
let teacherBusy = false;
let currentTeacherProposal = null;
let currentTeacherTask = null;
let fullShutdownActive = false;

const ANARCHY_INSTRUCTION = 'Автономная учебная сессия JARVIS: забудь текущую и предыдущую пользовательскую задачу. JARVIS сам выбирает небольшую обратимую гипотезу о свежем интерфейсе, даёт рабочему агенту действия, проверяет результат и сохраняет только переносимый опыт. Не отправляй сообщения и формы, не публикуй, не удаляй, не покупай и не меняй настройки системы или аккаунта. Если безопасной проверяемой гипотезы нет — заверши сессию.';

function clearAnarchyTimer() {
  if (anarchyTimer) clearTimeout(anarchyTimer);
  anarchyTimer = null;
}

function stopAnarchyLoop() {
  clearAnarchyTimer();
  anarchyRunId += 1;
  anarchyMode = false;
  anarchyResumeGoal = null;
  semanticReplayMode = false;
  anarchyAwaitingCorrection = false;
  anarchyRecoveryState = createAnarchyRecoveryState();
}

function reportJarvis(kind, message) {
  if (!jarvisActivity) return;
  const line = document.createElement('p');
  const label = document.createElement('strong');
  label.textContent = `${kind}: `;
  line.append(label, document.createTextNode(String(message || '').replace(/\s+/g, ' ').trim()));
  jarvisActivity.prepend(line);
  while (jarvisActivity.children.length > 4) jarvisActivity.lastElementChild.remove();
  jarvisActivity.hidden = false;
}

function scheduleAnarchyContinuation(operation, delayMs = 350) {
  if (!anarchyMode || paused || anarchyAwaitingCorrection) return;
  clearAnarchyTimer();
  const runId = anarchyRunId;
  anarchyTimer = setTimeout(async () => {
    anarchyTimer = null;
    if (!anarchyMode || paused || runId !== anarchyRunId) return;
    if (operation === 'execute') await executeStep({ autonomous: true, runId });
    else await planNextStep(false, runId);
  }, delayMs);
}

function finishAnarchySession(message, { error = false } = {}) {
  stopAnarchyLoop();
  currentMission = null;
  currentPlan = null;
  resetFeedbackView();
  resetStepView();
  setStatus(message, { error });
  updateControls();
}

async function recoverAnarchy(message, detail = '', errorInfo = {}) {
  if (!anarchyMode) return;
  currentPlan = null;
  resetStepView();
  resetFeedbackView();
  const missionId = currentMission?.missionId || null;
  const decision = decideAnarchyRecovery(anarchyRecoveryState, {
    missionId,
    errorCode: errorInfo.errorCode,
    abortReason: errorInfo.abortReason,
    message: detail || message
  });
  anarchyRecoveryState = decision.state;
  setStatus(`${message}. ${decision.report}`);
  reportJarvis('Восстановление', `${detail || message}. ${decision.report}`);
  if (missionId && decision.shouldRecordCorrection) {
    try {
      const corrected = await api('/api/missions/correct-step', {
        method: 'POST',
        body: JSON.stringify({
          missionId: currentMission.missionId,
          correction: `${detail || message}. Не останавливай локальное обучение и не повторяй тот же способ вслепую. Пересними экран, проверь обязательные условия, закрой безопасным способом мешающее окно, если оно появилось, используй накопленный опыт и публичную документацию, затем проверь другую гипотезу.`
        })
      });
      currentMission = corrected.mission || currentMission;
    } catch (error) {
      if (error.body?.error === 'mission_not_found' || error.body?.error === 'mission_step_limit') currentMission = null;
    }
  }
  if (decision.action === 'new_mission') {
    await cancelMission();
    anarchyResumeGoal = null;
  }
  if (decision.action === 'infrastructure_error') {
    clearAnarchyTimer();
    await cancelMission();
    anarchyMode = false;
    anarchyAwaitingCorrection = false;
    setStatus(`${message}. ${decision.report}`, { error: true });
    updateControls();
    return;
  }
  if (decision.action === 'needs_user') {
    clearAnarchyTimer();
    anarchyAwaitingCorrection = true;
    showCorrection({
      source: 'mission',
      missionId,
      planningFailure: true,
      proposal: errorInfo.proposal || null
    }, decision.report);
    updateControls();
    return;
  }
  scheduleAnarchyContinuation('plan', decision.delayMs);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: 'no-store',
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.message || body.error || `HTTP ${response.status}`);
    error.body = body;
    throw error;
  }
  return body;
}

function setStatus(message, { error = false } = {}) {
  taskStatus.textContent = message;
  taskStatus.classList.toggle('error', error);
}

function actionLabel(action = {}) {
  const labels = {
    click: 'Нажать', doubleClick: 'Двойное нажатие', drag: 'Перетащить',
    scroll: 'Прокрутить', typeText: 'Ввести текст', pressKey: 'Нажать клавишу',
    wait: 'Подождать', done: 'Завершить'
  };
  const target = action.targetHint?.visibleText || action.targetHint?.name || action.targetHint?.automationId ||
    action.target?.name || action.target?.automationId;
  const detail = action.type === 'typeText' ? `: «${String(action.text || '').slice(0, 80)}»`
    : action.type === 'pressKey' ? `: ${action.key}`
    : target ? `: ${target}` : '';
  return `${labels[action.type] || action.type || 'Действие'}${detail}`;
}

function resetStepView() {
  currentPlan = null;
  stepCard.hidden = true;
  executeButton.disabled = false;
  stepTeacher.textContent = '';
}

function renderTeacherProfile(body) {
  if (!body?.profile || teacherProfileLoaded) return;
  teacherName.value = body.profile.name || '';
  teacherMission.value = body.profile.mission || '';
  teacherValues.value = body.profile.values || '';
  teacherStatus.textContent = `JARVIS активен на базе ${body.model || 'локальной модели'}. Он сам проверяет свежий экран, исследует и исправляет план.`;
  teacherProfileLoaded = true;
}

function appendTeacherMessage(role, text, { screenshot = false } = {}) {
  const item = document.createElement('article');
  item.className = `teacher-message ${role === 'user' ? 'user' : 'assistant'}`;
  const author = document.createElement('strong');
  author.textContent = role === 'user' ? 'Вы' : 'JARVIS';
  const content = document.createElement('p');
  content.textContent = text;
  item.append(author, content);
  if (screenshot) {
    const badge = document.createElement('span');
    badge.className = 'screenshot-badge';
    badge.textContent = '📷 скриншот';
    item.append(badge);
  }
  teacherMessages.append(item);
  teacherMessages.scrollTop = teacherMessages.scrollHeight;
}

async function refreshTeacherChat() {
  try {
    const body = await api('/api/teacher/chat');
    teacherMessages.replaceChildren();
    for (const message of body.history || []) {
      appendTeacherMessage(message.role, message.text, { screenshot: Boolean(message.screenshotPath) });
    }
    if (!(body.history || []).length) {
      appendTeacherMessage('assistant', 'Я JARVIS — программист этой системы. Опишите изменение рабочего ИИ, моей логики или админ-панели. Я найду нужный код, подготовлю минимальную правку, проверю её в отдельной копии и установлю только после успешных тестов.');
    }
  } catch (error) {
    appendTeacherMessage('assistant', `Чат пока недоступен: ${error.message}`);
  }
}

async function screenshotToPngDataUrl(file) {
  if (!file) return '';
  if (file.size > 8 * 1024 * 1024) throw new Error('Скриншот должен быть меньше 8 МБ.');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/png');
}

function showTeacherProposal(proposal) {
  currentTeacherProposal = proposal;
  teacherProposalSummary.textContent = proposal.summary || 'Небольшое изменение проекта.';
  teacherProposalFiles.replaceChildren();
  for (const file of proposal.files || []) {
    const item = document.createElement('li');
    item.textContent = `${file.operation === 'create' ? 'Создать' : 'Изменить'} ${file.path}${file.reason ? ` — ${file.reason}` : ''}`;
    teacherProposalFiles.append(item);
  }
  const baseline = proposal.evaluation?.baseline;
  const candidate = proposal.evaluation?.candidate;
  teacherProposalTests.textContent = proposal.evaluation?.acceptable
    ? `Исходная версия: ${baseline?.pass ?? '?'} тестов прошло. Кандидат: ${candidate?.pass ?? '?'} прошло, ${candidate?.fail ?? 0} ошибок. Регрессий не найдено; рабочий код ещё не изменён.`
    : `Кандидат заблокирован: ${(proposal.evaluation?.reasons || ['тесты не пройдены']).join(', ')}.${proposal.sandbox?.output ? ` ${proposal.sandbox.output.slice(-500)}` : ''}`;
  teacherApply.disabled = !proposal.canApply;
  teacherApply.hidden = false;
  teacherRollback.hidden = true;
  teacherProposal.hidden = false;
}

function showTeacherTask(task) {
  currentTeacherTask = task;
  teacherTaskText.textContent = task.instruction;
  teacherTaskCriteria.textContent = task.successCriteria
    ? `Критерий успеха: ${task.successCriteria}`
    : 'Результат будет проверен по свежему экрану.';
  teacherTaskRun.disabled = !task.windowHandle;
  teacherTask.hidden = false;
}

async function sendTeacherMessage() {
  const message = teacherMessage.value.trim();
  const file = teacherScreenshot.files?.[0] || null;
  if ((!message && !file) || teacherBusy) return;
  teacherBusy = true;
  teacherSend.disabled = true;
  teacherSend.textContent = 'JARVIS работает…';
  teacherProposal.hidden = true;
  teacherTask.hidden = true;
  currentTeacherProposal = null;
  currentTeacherTask = null;
  try {
    const screenshotDataUrl = await screenshotToPngDataUrl(file);
    appendTeacherMessage('user', message || 'Проанализируй этот скриншот.', { screenshot: Boolean(file) });
    teacherMessage.value = '';
    if (!file) {
      await sendUnifiedProgrammerMessage(message);
      return;
    }
    const body = await api('/api/teacher/chat', {
      method: 'POST',
      body: JSON.stringify({
        message,
        screenshotDataUrl,
        mode: 'code',
        useInternet: false,
        windowHandle: selectedWindowHandle,
        currentTask: taskInput.value.trim()
      })
    });
    appendTeacherMessage('assistant', body.reply);
    if (body.learningUpdates?.length) {
      appendTeacherMessage('assistant', `JARVIS сохранил обобщённый опыт: ${body.learningUpdates.map((item) => item.name).join(', ')}.`);
      await refreshSystemStatus();
    }
    if (body.rejectedLearning?.length) {
      appendTeacherMessage('assistant', 'Конкретное задание не записано в долговременную память: JARVIS не нашёл в нём достаточно обобщённого приёма или предпочтения.');
    }
    if (body.research?.sources?.length) {
      appendTeacherMessage('assistant', `Использованы публичные источники:\n${body.research.sources.map((source) => `${source.title || 'Источник'} — ${source.url}`).join('\n')}`);
    } else if (body.research?.enabled && body.research?.error) {
      appendTeacherMessage('assistant', `Интернет-поиск не сработал: ${body.research.error}. Ответ построен без него.`);
    }
    if (body.learningMaterials?.length) {
      const saved = body.learningMaterials.filter((item) => item.saved);
      const withoutTranscript = body.learningMaterials.filter((item) => item.sourceType === 'youtube' && item.transcriptAvailable === false);
      if (saved.length) appendTeacherMessage('assistant', `Материал сохранён в библиотеку JARVIS: ${saved.map((item) => item.title || item.url).join(', ')}.`);
      if (withoutTranscript.length) appendTeacherMessage('assistant', 'У этого YouTube-видео не удалось получить субтитры. Ссылка сохранена, но для точного обучения добавьте в сообщение конспект или текст субтитров.');
    }
    if (body.codeApplied?.applied) appendTeacherMessage('assistant', 'Проверенная правка кода установлена с резервной копией и полным тестированием.');
    if (body.agentTask) showTeacherTask(body.agentTask);
    if (body.codeProposal) showTeacherProposal(body.codeProposal);
    if (body.proposalError) appendTeacherMessage('assistant', `Изменение кода не принято системой безопасности: ${body.proposalError}`);
    teacherScreenshot.value = '';
    teacherAttachment.textContent = 'Файл не выбран';
  } catch (error) {
    appendTeacherMessage('assistant', `Не удалось ответить: ${error.message}`);
  } finally {
    teacherBusy = false;
    teacherSend.disabled = false;
    teacherSend.textContent = 'Перепрограммировать';
  }
}

function latestErrorPrompt(packet) {
  const error = packet?.error || {};
  const parts = [
    'Исправь последнюю зафиксированную ошибку Worker как программист системы.',
    `Категория: ${packet?.category || 'не определена'}.`,
    `Этап: ${packet?.phase || 'не определён'}.`,
    `Код: ${error.code || 'worker_error'}.`,
    `Сообщение: ${error.message || 'нет сообщения'}.`
  ];
  if (packet?.expectedResult) parts.push(`Ожидалось: ${packet.expectedResult}.`);
  if (packet?.actualResult) parts.push(`Получилось: ${packet.actualResult}.`);
  parts.push('Сначала найди первопричину по коду, журналу и актуальной документации. Затем подготовь минимальный патч в отдельной копии, добавь тест воспроизведения и покажи сравнение исходной и исправленной версии. Не меняй рабочую версию до моего нажатия «Применить проверенное изменение».');
  return parts.join('\n');
}

async function fixLatestWorkerError() {
  if (teacherBusy) return;
  teacherFixLast.disabled = true;
  teacherFixLast.textContent = 'Читаю журнал…';
  try {
    const body = await api('/api/self-improvement/errors?limit=1');
    const packet = body.packets?.[0];
    if (!packet) {
      appendTeacherMessage('assistant', 'В журнале пока нет зафиксированных ошибок Worker. Опишите проблему текстом или приложите скриншот.');
      return;
    }
    teacherMessage.value = latestErrorPrompt(packet);
    teacherMessage.focus();
    await sendTeacherMessage();
  } catch (error) {
    appendTeacherMessage('assistant', `Не удалось получить последнюю ошибку: ${error.message}`);
  } finally {
    teacherFixLast.disabled = false;
    teacherFixLast.textContent = 'Исправить последнюю ошибку';
  }
}

async function runTeacherTask() {
  if (!currentTeacherTask?.instruction || !currentTeacherTask.windowHandle || busy) return;
  await cancelMission();
  resetFeedbackView();
  hideCorrection();
  selectedWindowHandle = Number(currentTeacherTask.windowHandle);
  windowSelect.value = String(selectedWindowHandle);
  localStorage.setItem('ai-window-handle', String(selectedWindowHandle));
  taskInput.value = currentTeacherTask.instruction;
  anarchyMode = false;
  teacherTask.hidden = true;
  currentTeacherTask = null;
  updateControls();
  await planNextStep();
}

async function applyTeacherCodeProposal() {
  if (!currentTeacherProposal?.proposalId || teacherBusy) return;
  teacherBusy = true;
  teacherApply.disabled = true;
  try {
    const body = await api('/api/teacher/code/apply', {
      method: 'POST',
      body: JSON.stringify({ proposalId: currentTeacherProposal.proposalId, confirmed: true })
    });
    appendTeacherMessage('assistant', body.applied
      ? `Изменение применено, полный набор тестов прошёл. Изменены файлы: ${body.files.join(', ')}. Для серверного кода перезапустите приложение.`
      : 'Изменение не прошло тесты и было автоматически отменено.');
    if (body.applied) {
      teacherApply.hidden = true;
      teacherRollback.hidden = false;
      teacherProposalTests.textContent = 'Изменение установлено. Резервная копия сохранена; при проблеме нажмите «Откатить изменение».';
    }
  } catch (error) {
    appendTeacherMessage('assistant', `Изменение не применено: ${error.message}`);
    teacherApply.disabled = false;
  } finally {
    teacherBusy = false;
  }
}

async function rollbackTeacherCodeProposal() {
  if (!currentTeacherProposal?.proposalId || teacherBusy) return;
  teacherBusy = true;
  teacherRollback.disabled = true;
  try {
    const body = await api('/api/teacher/code/rollback', {
      method: 'POST',
      body: JSON.stringify({ proposalId: currentTeacherProposal.proposalId, confirmed: true })
    });
    appendTeacherMessage('assistant', `Изменение откатано, восстановлены файлы: ${body.files.join(', ')}. Тесты после отката ${body.tests?.passed ? 'прошли' : 'требуют проверки'}.`);
    teacherProposal.hidden = true;
    currentTeacherProposal = null;
  } catch (error) {
    appendTeacherMessage('assistant', `Откат не завершён: ${error.message}`);
    teacherRollback.disabled = false;
  } finally {
    teacherBusy = false;
  }
}

function resetFeedbackView() {
  completedStep = null;
  feedbackCard.hidden = true;
  positiveButton.disabled = false;
  negativeButton.disabled = false;
  positiveButton.textContent = '👍';
  negativeButton.textContent = '👎';
}

function renderPrinciples(principles = [], experiences = []) {
  principlesCount.textContent = String(principles.length + experiences.length);
  principlesList.replaceChildren();
  if (!principles.length) {
    const empty = document.createElement('p');
    empty.className = 'principles-empty';
    empty.textContent = 'Принципы появятся после ваших оценок 👍 и 👎.';
    principlesList.append(empty);
    return;
  }
  for (const principle of principles) {
    const item = document.createElement('article');
    item.className = 'principle-item';
    const name = document.createElement('input');
    name.value = principle.name || 'Принцип интерфейса';
    name.maxLength = 120;
    name.setAttribute('aria-label', 'Название принципа');
    const description = document.createElement('textarea');
    description.value = principle.description || principle.statement || '';
    description.maxLength = 1200;
    description.setAttribute('aria-label', 'Описание принципа');
    if (principle.protected) {
      name.readOnly = true;
      description.readOnly = true;
      item.classList.add('core-principle');
    }
    const meta = document.createElement('span');
    meta.className = 'principle-meta';
    meta.textContent = `👍 ${principle.positive || 0} · 👎 ${principle.negative || 0} · программ: ${principle.applications?.length || 0}`;
    const actions = document.createElement('div');
    actions.className = 'principle-actions';
    const save = document.createElement('button');
    save.className = 'primary compact';
    save.type = 'button';
    save.textContent = 'Сохранить';
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await api('/api/knowledge/principles/update', {
          method: 'POST',
          body: JSON.stringify({
            principleId: principle.principleId,
            name: name.value.trim(),
            description: description.value.trim()
          })
        });
        setStatus(`Принцип «${name.value.trim()}» обновлён.`);
        await refreshSystemStatus();
      } catch (error) {
        setStatus(`Не удалось обновить принцип: ${error.message}`, { error: true });
      } finally {
        save.disabled = false;
      }
    });
    const remove = document.createElement('button');
    remove.className = 'quiet principle-delete';
    remove.type = 'button';
    remove.textContent = 'Удалить';
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Удалить принцип «${name.value.trim()}» из долговременной памяти?`)) return;
      remove.disabled = true;
      try {
        await api('/api/knowledge/principles/delete', {
          method: 'POST',
          body: JSON.stringify({ principleId: principle.principleId })
        });
        setStatus(`Принцип «${name.value.trim()}» удалён.`);
        await refreshSystemStatus();
      } catch (error) {
        setStatus(`Не удалось удалить принцип: ${error.message}`, { error: true });
        remove.disabled = false;
      }
    });
    if (!principle.protected) actions.append(save, remove);
    meta.textContent = principle.protected
      ? 'Основной защищённый принцип JARVIS'
      : meta.textContent;
    item.append(name, description, meta);
    if (!principle.protected) item.append(actions);
    principlesList.append(item);
  }
  if (experiences.length) {
    const heading = document.createElement('strong');
    heading.className = 'knowledge-heading';
    heading.textContent = 'Обобщённый опыт и предпочтения';
    principlesList.append(heading);
    for (const experience of experiences) {
      const item = document.createElement('article');
      item.className = 'principle-item learned-experience';
      const name = document.createElement('strong');
      name.textContent = experience.name;
      const description = document.createElement('p');
      description.textContent = experience.description;
      const meta = document.createElement('span');
      meta.className = 'principle-meta';
      const typeLabels = { technique: 'Приём', preference: 'Ваше предпочтение', lesson: 'Урок' };
      meta.textContent = `${typeLabels[experience.type] || 'Опыт'} · ${experience.scope === 'selected_application' ? experience.application?.processName || 'выбранная программа' : 'универсально'}`;
      item.append(name, description, meta);
      principlesList.append(item);
    }
  }
}

function hideCorrection() {
  pendingCorrection = null;
  correctionCard.hidden = true;
  correctionInput.value = '';
}

function showCorrection(context, detail = '') {
  pendingCorrection = context;
  correctionTitle.textContent = context?.planningFailure
    ? 'Модель просит показать или уточнить этот шаг'
    : 'Исправить именно этот шаг';
  correctionDetail.textContent = detail || 'Описание необязательно: можно написать короткую подсказку, показать только этот шаг или попросить модель попробовать иначе.';
  correctionCard.hidden = false;
  correctionInput.focus();
}

function observationMatchesSelectedWindow() {
  const selected = windowCatalog.find((item) => Number(item.nativeWindowHandle) === selectedWindowHandle);
  return Boolean(selected && latestObservedSkill &&
    String(selected.processName || '').toLowerCase() === String(latestObservedSkill.application?.processName || '').toLowerCase());
}

function updateControls() {
  if (fullShutdownActive) {
    document.querySelectorAll('button, textarea, select, input').forEach((element) => {
      element.disabled = true;
    });
    return;
  }
  const hasInput = Boolean(selectedWindowHandle && taskInput.value.trim());
  taskButton.disabled = busy || paused || anarchyMode || Boolean(teachingSession) || Boolean(currentSkillRun) || !hasInput || Boolean(currentPlan) || Boolean(completedStep);
  // Passive learning is observation-only, so it remains available while execution is paused.
  demoButton.disabled = teachingRequested || (busy && !teachingSession) || Boolean(currentSkillRun);
  demoRunButton.disabled = busy || paused || !selectedWindowHandle || !latestDemonstratedSkillId || Boolean(teachingSession) || Boolean(currentPlan) || Boolean(completedStep) || Boolean(currentSkillRun);
  observationUnderstoodButton.disabled = busy || !latestObservedSkill || Boolean(teachingSession);
  observationRepeatButton.disabled = busy || paused || !observationMatchesSelectedWindow() || !canRepeatSemanticObservation(latestObservedSkill) || Boolean(teachingSession) || Boolean(currentPlan) || Boolean(completedStep) || Boolean(currentSkillRun);
  windowSelect.disabled = busy || anarchyMode || Boolean(teachingSession) || Boolean(currentSkillRun);
  taskInput.disabled = busy || anarchyMode || Boolean(teachingSession) || Boolean(currentSkillRun);
  executeButton.disabled = busy || paused || (!currentPlan && !currentSkillRun?.currentStep);
  teachStepButton.disabled = busy || (!currentPlan && !currentSkillRun?.currentStep);
  correctionSubmit.disabled = busy || !pendingCorrection || !correctionInput.value.trim();
  correctionDemo.disabled = busy || !pendingCorrection || !selectedWindowHandle;
  correctionSkip.disabled = busy || !pendingCorrection;
  anarchyButton.disabled = anarchyMode
    ? false
    : busy || paused || !selectedWindowHandle || Boolean(teachingSession) || Boolean(currentSkillRun);
  anarchyButton.classList.toggle('active', anarchyMode);
  anarchyButton.textContent = anarchyAwaitingCorrection
    ? 'Продолжить свободу'
    : semanticReplayMode ? 'Остановить повтор' : anarchyMode ? 'Остановить автономный режим' : 'Автономный режим';
  if (teachingRequested && !busy && !teachingSession) {
    teachingRequested = false;
    setTimeout(() => toggleTeaching(), 0);
  }
}

async function cancelMission() {
  if (!currentMission?.missionId) return;
  try {
    await api('/api/missions/cancel', {
      method: 'POST',
      body: JSON.stringify({ missionId: currentMission.missionId })
    });
  } catch { }
  currentMission = null;
  resetStepView();
}

async function cancelSkillRun() {
  if (!currentSkillRun?.runId) return;
  try {
    await api('/api/skills/cancel-run', {
      method: 'POST',
      body: JSON.stringify({ runId: currentSkillRun.runId })
    });
  } catch { }
  currentSkillRun = null;
  resetStepView();
}

async function refreshLatestDemonstration() {
  const selected = windowCatalog.find((item) => Number(item.nativeWindowHandle) === selectedWindowHandle);
  try {
    const body = await api('/api/skills');
    const skills = body.skills || [];
    const skill = selected
      ? skills.find((item) =>
          item.executionPolicy?.replayable !== false && item.application?.processName === selected.processName)
      : null;
    latestObservedSkill = (selected ? findLatestSemanticObservation(skills, selected.processName) : null) ||
      findLatestSemanticObservation(skills);
    latestDemonstratedSkillId = skill?.skillId || null;
    if (latestDemonstratedSkillId) {
      localStorage.setItem('ai-latest-skill-id', latestDemonstratedSkillId);
      demoRunButton.hidden = false;
      if (demoTitle.textContent === 'Модель не поняла?') {
        demoStatus.textContent = `Есть сохранённый показ «${skill.instruction}». Его можно выполнить кнопкой ниже.`;
      }
    } else {
      demoRunButton.hidden = true;
    }
    observationReview.hidden = !latestObservedSkill;
    if (latestObservedSkill) {
      localStorage.setItem('ai-latest-observation-id', latestObservedSkill.skillId);
      if (demoTitle.textContent === 'Модель не поняла?') {
        demoStatus.textContent = canRepeatSemanticObservation(latestObservedSkill) && observationMatchesSelectedWindow()
          ? 'Последнее наблюдение разобрано. Можно спросить, что понято, или попросить модель повторить смысл на свежем экране.'
          : canRepeatSemanticObservation(latestObservedSkill)
            ? `Последнее наблюдение относится к программе ${latestObservedSkill.application?.processName || 'неизвестно'}. Сначала проверьте «Что ты понял?», затем выберите эту программу для повтора.`
          : 'Последнее наблюдение сохранено, но смысл недостаточно ясен для самостоятельного повтора. Нажмите «Что ты понял?», чтобы увидеть причину.';
      }
    }
  } catch { }
}

async function stopCurrentAgentSession(reason = 'user_stop') {
  const sessionId = currentAgentSessionId;
  currentAgentSessionId = null;
  currentAgentSessionMode = null;
  currentAgentSessionGoal = null;
  currentAgentAwaitingUser = false;
  if (!sessionId) return;
  try {
    await api('/api/agent/sessions/stop', {
      method: 'POST',
      body: JSON.stringify({ sessionId, reason })
    });
  } catch { }
}

async function ensureAgentSession({ goal, mode, windowHandle = null }) {
  if (currentAgentSessionId && currentAgentSessionGoal === goal && currentAgentSessionMode === mode) {
    return currentAgentSessionId;
  }
  await stopCurrentAgentSession('session_replaced');
  const body = await api('/api/agent/sessions', {
    method: 'POST',
    body: JSON.stringify({ goal, mode, windowHandle })
  });
  currentAgentSessionId = body.sessionId;
  currentAgentSessionMode = mode;
  currentAgentSessionGoal = goal;
  currentAgentAwaitingUser = false;
  return currentAgentSessionId;
}

function summarizeUnifiedTurn(turn) {
  if (turn.kind === 'final') return turn.decision?.summary || 'Задача завершена.';
  if (turn.kind === 'user_question') return turn.decision?.question || 'JARVIS просит уточнение.';
  if (turn.kind === 'tool_result') {
    const result = turn.results?.[0];
    return result?.status === 'completed'
      ? `Выполнен инструмент ${result.tool}. Результат записан; следующий шаг будет принят по свежему состоянию.`
      : `Инструмент ${result?.tool || turn.decision?.tool || 'неизвестен'} не выполнен: ${result?.error?.message || 'нет результата'}`;
  }
  return turn.state?.status || 'JARVIS обновил состояние задачи.';
}

async function runUnifiedAgentTurn({ autonomous = false } = {}) {
  const inputText = taskInput.value.trim();
  const goal = autonomous ? ANARCHY_INSTRUCTION : inputText;
  if (!selectedWindowHandle || !goal || busy) return;
  busy = true;
  setStatus(autonomous ? 'Автономный режим анализирует свежий экран…' : 'JARVIS принимает следующее решение…');
  updateControls();
  try {
    let turn;
    if (currentAgentAwaitingUser && currentAgentSessionId) {
      turn = await api('/api/agent/sessions/message', {
        method: 'POST',
        body: JSON.stringify({ sessionId: currentAgentSessionId, message: inputText })
      });
      currentAgentAwaitingUser = false;
    } else {
      const sessionOptions = autonomous
        ? { goal, mode: 'autonomous', windowHandle: selectedWindowHandle }
        : { goal, mode: 'guided', windowHandle: selectedWindowHandle };
      const sessionId = await ensureAgentSession(sessionOptions);
      turn = await api('/api/agent/sessions/next', {
        method: 'POST',
        body: JSON.stringify({ sessionId })
      });
    }
    const report = summarizeUnifiedTurn(turn);
    reportJarvis(turn.kind === 'tool_result' ? 'Действие' : 'Решение', report);
    setStatus(report, { error: turn.results?.[0]?.status === 'failed' || turn.state?.status === 'failed' });
    if (['final', 'terminal', 'cancelled'].includes(turn.kind)) {
      currentAgentSessionId = null;
      currentAgentSessionMode = null;
      currentAgentSessionGoal = null;
      currentAgentAwaitingUser = false;
      if (autonomous && anarchyMode) stopAnarchyLoop();
    } else if (turn.kind === 'user_question') {
      taskInput.value = '';
      taskInput.placeholder = turn.decision?.question || 'Ответьте JARVIS…';
      taskButton.textContent = 'Ответить JARVIS';
      currentAgentAwaitingUser = true;
      if (autonomous) anarchyAwaitingCorrection = true;
    } else if (autonomous && anarchyMode) {
      clearAnarchyTimer();
      const runId = anarchyRunId;
      anarchyTimer = setTimeout(() => {
        if (anarchyMode && runId === anarchyRunId) runUnifiedAgentTurn({ autonomous: true });
      }, 350);
    }
  } catch (error) {
    setStatus(`JARVIS не смог продолжить: ${error.message}`, { error: true });
    reportJarvis('Ошибка', error.message);
    if (autonomous) anarchyAwaitingCorrection = true;
  } finally {
    busy = false;
    updateControls();
  }
}

async function sendUnifiedProgrammerMessage(message) {
  const sessionId = currentAgentAwaitingUser && currentAgentSessionMode === 'programmer'
    ? currentAgentSessionId
    : await ensureAgentSession({ goal: message, mode: 'programmer' });
  let turn;
  for (let index = 0; index < 10; index += 1) {
    turn = currentAgentAwaitingUser
      ? await api('/api/agent/sessions/message', {
        method: 'POST', body: JSON.stringify({ sessionId, message })
      })
      : await api('/api/agent/sessions/next', {
        method: 'POST', body: JSON.stringify({ sessionId })
      });
    currentAgentAwaitingUser = false;
    if (turn.kind !== 'tool_result') break;
  }
  appendTeacherMessage('assistant', summarizeUnifiedTurn(turn));
  if (turn?.kind === 'user_question') currentAgentAwaitingUser = true;
  if (['final', 'terminal', 'cancelled'].includes(turn?.kind)) {
    currentAgentSessionId = null;
    currentAgentSessionMode = null;
    currentAgentSessionGoal = null;
    currentAgentAwaitingUser = false;
  }
  return turn;
}

async function watchSelectedWindow() {
  if (!selectedWindowHandle) return null;
  try {
    return await api('/api/observation/watch', {
      method: 'POST',
      body: JSON.stringify({ windowHandle: selectedWindowHandle })
    });
  } catch (error) {
    console.warn('Event observer could not watch the selected window:', error);
    return null;
  }
}

async function scanWindows() {
  const previous = String(selectedWindowHandle || localStorage.getItem('ai-window-handle') || '');
  try {
    const body = await api('/api/uia/windows');
    const windows = (body.windows || [])
      .filter((item) => item.name && !['ChatGPT', 'Codex'].includes(item.processName))
      .sort((left, right) => left.name.localeCompare(right.name, 'ru'));
    windowCatalog = windows;
    windowSelect.replaceChildren();
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = windows.length ? 'Выберите открытую программу' : 'Открытые программы не найдены';
    windowSelect.append(empty);
    for (const item of windows) {
      const option = document.createElement('option');
      option.value = String(item.nativeWindowHandle);
      option.textContent = `${item.name} · ${item.processName}`;
      windowSelect.append(option);
    }
    if ([...windowSelect.options].some((option) => option.value === previous)) {
      windowSelect.value = previous;
    } else if (windows.length === 1) {
      windowSelect.value = String(windows[0].nativeWindowHandle);
    }
    selectedWindowHandle = Number(windowSelect.value) || null;
    await watchSelectedWindow();
    await refreshLatestDemonstration();
  } catch (error) {
    windowSelect.replaceChildren(new Option('Не удалось получить список программ', ''));
    setStatus(error.message, { error: true });
  }
  updateControls();
}

async function refreshSystemStatus() {
  if (fullShutdownActive) return;
  try {
    const [body, knowledge, teacher] = await Promise.all([
      api('/api/status'),
      api('/api/knowledge/status').catch(() => ({ principleCount: 0 })),
      api('/api/teacher/profile').catch(() => null)
    ]);
    paused = body.worker?.safety?.paused === true;
    const ready = body.independentControl?.ready === true;
    const eventStream = body.worker?.observation?.eventStream;
    const interfaceMap = body.worker?.observation?.interfaceMap;
    const observationLabel = eventStream?.status === 'observing'
      ? `наблюдение ${eventStream.intervalMs} мс · кадров памяти: ${eventStream.temporalKeyframes || 0} · элементов: ${interfaceMap?.elementCount || 0}`
      : 'наблюдение ожидает окно';
    statusDot.className = `status-dot ${ready ? 'ready' : 'error'}`;
    statusText.textContent = paused
      ? 'Действия приостановлены'
      : ready
        ? `JARVIS готов · ${observationLabel} · принципы: ${knowledge.principleCount || 0} · опыт: ${knowledge.teacherExperienceCount || 0}`
        : 'Управление пока не готово';
    renderPrinciples(knowledge.principles || [], knowledge.teacherExperiences || []);
    renderTeacherProfile(teacher);
    safetyToggle.textContent = paused ? 'Продолжить' : 'Стоп';
    safetyToggle.classList.toggle('resume', paused);
  } catch (error) {
    statusDot.className = 'status-dot error';
    statusText.textContent = 'Локальный исполнитель недоступен';
    setStatus(error.message, { error: true });
  }
  updateControls();
}

function showPlan(body) {
  hideCorrection();
  currentPlan = body;
  const autonomousGoal = body.mission?.autonomousGoal || null;
  stepNumber.textContent = anarchyMode
    ? `Свободный режим · шаг ${(body.mission?.stepCount || 0) + 1}`
    : `Шаг ${(body.mission?.stepCount || 0) + 1}`;
  stepReason.textContent = body.proposal?.reason || 'Следующее действие';
  stepAction.textContent = actionLabel(body.proposal?.action);
  stepResult.textContent = body.proposal?.expectedResult ? `Ожидаемый результат: ${body.proposal.expectedResult}` : '';
  const miniPlan = body.mission?.miniPlan;
  if (body.miniPlanStep) {
    stepTeacher.textContent = `Мини-план ${body.miniPlanStep.index + 1}/${body.miniPlanStep.total}: цель заново найдена на свежем экране, новый вызов Planner не потребовался.`;
  } else if (miniPlan?.remaining) {
    stepTeacher.textContent = `Подготовлен защищённый мини-план: ещё ${miniPlan.remaining} действия. Перед каждым Worker заново проверит экран и цель.`;
  } else {
    stepTeacher.textContent = body.teacherRevisionCount
      ? `JARVIS самостоятельно исправил план и одобрил этот вариант: ${body.teacherReview?.reason || 'шаг соответствует цели.'}`
      : `JARVIS проверил и одобрил: ${body.teacherReview?.reason || 'это следующий полезный шаг.'}`;
  }
  stepCard.hidden = false;
  executeButton.hidden = anarchyMode;
  teachStepButton.hidden = anarchyMode;
  setStatus(anarchyMode
    ? `JARVIS проверяет гипотезу: ${autonomousGoal?.goal || 'небольшой обратимый опыт'}. Подтверждение не требуется: после свежего снимка результат будет проверен автоматически.`
    : 'Модель предложила один шаг. Нажатие кнопки ниже — его подтверждение.');
  if (anarchyMode) {
    reportJarvis('План', `${autonomousGoal?.goal || 'Локальный опыт'}. Действие: ${actionLabel(body.proposal?.action)}.`);
  }
  updateControls();
  if (anarchyMode) scheduleAnarchyContinuation('execute');
}

function showLearnedStep(step) {
  if (!currentSkillRun || !step) return;
  currentPlan = null;
  currentSkillRun.currentStep = step;
  stepNumber.textContent = `Шаг ${Number(step.index ?? currentSkillRun.stepIndex ?? 0) + 1} из ${currentSkillRun.skill?.stepCount || '?'}`;
  stepReason.textContent = 'Шаг по вашей демонстрации';
  stepAction.textContent = actionLabel(step);
  stepResult.textContent = 'После выполнения оцените только результат: 👍 или 👎.';
  stepCard.hidden = false;
  setStatus('Навык подготовил следующий шаг по сохранённому показу. Подтвердите его выполнение.');
  updateControls();
}

async function planNextStep(retriedAfterRestart = false, expectedAnarchyRunId = null) {
  const instruction = anarchyMode ? ANARCHY_INSTRUCTION : taskInput.value.trim();
  if (!selectedWindowHandle || !instruction || busy) return;
  const planningAnarchyRunId = anarchyMode ? (expectedAnarchyRunId ?? anarchyRunId) : null;
  busy = true;
  resetStepView();
  setStatus(semanticReplayMode
    ? 'JARVIS заново смотрит на экран и готовит повтор понятого результата…'
    : anarchyMode
    ? 'Свободный режим изучает свежий экран и придумывает новую локальную цель…'
    : 'Модель изучает свежий интерфейс и готовит один шаг…');
  updateControls();
  try {
    if (!currentMission?.missionId || currentMission.instruction !== instruction) {
      await cancelMission();
      const started = await api('/api/missions', {
        method: 'POST',
        body: JSON.stringify({
          windowHandle: selectedWindowHandle,
          instruction,
          maxSteps: anarchyMode ? 6 : 30,
          mode: anarchyMode ? 'anarchy' : 'guided',
          autonomousGoal: anarchyMode ? anarchyResumeGoal : null
        })
      });
      if (planningAnarchyRunId !== null && (!anarchyMode || planningAnarchyRunId !== anarchyRunId)) return;
      currentMission = started.mission;
      anarchyResumeGoal = null;
    }
    const body = await api('/api/missions/plan-next', {
      method: 'POST',
      body: JSON.stringify({ missionId: currentMission.missionId })
    });
    if (planningAnarchyRunId !== null && (!anarchyMode || planningAnarchyRunId !== anarchyRunId)) return;
    currentMission = body.mission;
    if (anarchyMode) anarchyRecoveryState = resetAnarchyRecoveryState(currentMission?.missionId || null);
    if (body.proposal?.action?.type === 'done' || body.mission?.status === 'complete') {
      currentMission = null;
      if (anarchyMode) {
        if (semanticReplayMode) {
          finishAnarchySession('Повтор понятого завершён. JARVIS выполнил цель по свежему экрану, а не воспроизвёл старые координаты. Проверьте итог в программе.');
        } else {
          anarchyResumeGoal = null;
          setStatus('Гипотеза проверена. JARVIS выбирает следующий безопасный опыт по свежему экрану…');
          scheduleAnarchyContinuation('plan');
        }
      } else {
        taskButton.textContent = 'Начать новую задачу';
        setStatus('Задача завершена. Проверьте итог в программе.');
      }
    } else if (body.policy?.allowExecution === false) {
      if (anarchyMode) await recoverAnarchy('Предложенный способ отклонён', body.policy.reason, { errorCode: 'policy_rejected' });
      else setStatus(`Шаг остановлен безопасностью: ${body.policy.reason}`, { error: true });
    } else {
      showPlan(body);
    }
  } catch (error) {
    if (error.body?.error === 'mission_not_found' && !retriedAfterRestart) {
      currentMission = null;
      busy = false;
      updateControls();
      return await planNextStep(true, planningAnarchyRunId);
    }
    if (anarchyMode && error.body?.error === 'mission_step_limit') {
      currentMission = null;
      anarchyResumeGoal = null;
      if (semanticReplayMode) {
        finishAnarchySession('Повтор понятого остановлен после лимита шагов: результат ещё не подтверждён. Можно показать более короткий пример.', { error: true });
      } else {
        setStatus('Лимит одной гипотезы достигнут. JARVIS начинает другой безопасный опыт…');
        scheduleAnarchyContinuation('plan');
      }
      return;
    }
    const suggestion = error.body?.abortReason === 'visual_target_not_verified'
      ? ' Модель не уверена: уточните или покажите только этот шаг ниже.'
      : '';
    if (error.body?.abortReason === 'autonomous_goal_not_grounded') {
      currentMission = error.body?.mission || currentMission;
      await recoverAnarchy('Первая гипотеза оказалась недостаточно ясной', error.message, {
        errorCode: error.body?.error,
        abortReason: error.body?.abortReason
      });
      return;
    }
    if (['visual_target_not_verified', 'successful_action_repeated'].includes(error.body?.abortReason)) {
      currentMission = error.body?.mission || currentMission;
      showCorrection({
        source: 'mission',
        missionId: currentMission?.missionId || null,
        planningFailure: true,
        proposal: error.body?.plannedProposal || null
      }, error.body?.abortReason === 'successful_action_repeated'
        ? 'JARVIS остановил повтор уже успешного действия и самостоятельно ищет следующий недостигнутый результат.'
        : 'Нужный объект не удалось безопасно подтвердить. Можно дать одну короткую подсказку или показать только этот шаг.');
      if (anarchyMode) {
        await recoverAnarchy('Проверка цели не прошла', error.message, {
          errorCode: error.body?.error,
          abortReason: error.body?.abortReason
        });
        return;
      }
    }
    if (error.body?.abortReason === 'jarvis_stopped_safely') {
      currentMission = error.body?.mission || currentMission;
      await recoverAnarchy('JARVIS исчерпал очевидные варианты', error.message, {
        errorCode: error.body?.error,
        abortReason: error.body?.abortReason
      });
      return;
    }
    if (anarchyMode) {
      currentMission = error.body?.mission || currentMission;
      await recoverAnarchy('План не удалось уверенно привязать к свежему экрану', error.message, {
        errorCode: error.body?.error,
        abortReason: error.body?.abortReason
      });
      return;
    }
    setStatus(`${error.message}${suggestion}`, { error: true });
  } finally {
    busy = false;
    updateControls();
  }
}

async function executeStep({ autonomous = false, runId = null } = {}) {
  if (currentSkillRun?.currentStep) return executeLearnedStep();
  if (!currentPlan?.planId || busy) return;
  busy = true;
  executeButton.disabled = true;
  setStatus('Выполняю один шаг и проверяю результат…');
  updateControls();
  try {
    const body = await api('/api/agent/execute-plan', {
      method: 'POST',
      body: JSON.stringify(autonomous
        ? { planId: currentPlan.planId, autonomous: true }
        : { planId: currentPlan.planId, confirmed: true })
    });
    if (autonomous && (!anarchyMode || runId !== anarchyRunId)) return;
    currentMission = body.mission || currentMission;
    resetFeedbackView();
    completedStep = autonomous ? null : body;
    resetStepView();
    if (autonomous) {
      anarchyStepCount += 1;
      const learned = body.jarvisLearning?.name ? ` Сохранён опыт: ${body.jarvisLearning.name}.` : '';
      const evidence = body.validation?.evidence || 'Видимый результат проверен.';
      setStatus(body.validation?.success
        ? `Гипотеза подтверждена: ${evidence}${learned} JARVIS готовит следующий шаг…`
        : `Гипотеза не подтвердилась: ${evidence} JARVIS учитывает ошибку и меняет способ…`);
      reportJarvis(body.validation?.success ? 'Результат' : 'Ошибка', body.validation?.success
        ? `${evidence}${learned} Далее: проверить следующий недостигнутый результат.`
        : `${evidence} Далее: свежий снимок и другой способ.`);
      anarchyRecoveryState = resetAnarchyRecoveryState(currentMission?.missionId || null);
      if (currentMission?.status === 'limit_reached') currentMission = null;
      scheduleAnarchyContinuation('plan');
      return;
    }
    feedbackCard.hidden = false;
    feedbackTitle.textContent = body.validation?.success ? 'Шаг выполнен и проверен' : 'Шаг выполнен — проверьте глазами';
    feedbackDetail.textContent = body.validation?.evidence || 'Отметьте только итог: правильно или неправильно.';
    taskButton.textContent = 'Следующий шаг';
    setStatus('Оцените результат шага: 👍 правильно, 👎 неправильно. После оценки модель сама подготовит следующий шаг.');
  } catch (error) {
    // Handle needs_replan: automatically request a new plan for the same mission/window
    if (error.body?.error === 'needs_replan') {
      currentPlan = null; // Invalidate old plan
      resetStepView();
      setStatus('Окно или его содержимое изменилось после планирования. Запрашиваю новый план по свежему снимку…');
      if (autonomous) {
        setStatus('Экран изменился. JARVIS отменил устаревшую точку и пересчитывает действие по свежему снимку…');
        scheduleAnarchyContinuation('plan');
        return;
      }
      // One request produces one fresh proposal; guided execution still requires confirmation.
      try {
        const replanBody = await api('/api/missions/plan-next', {
          method: 'POST',
          body: JSON.stringify({ missionId: currentMission?.missionId })
        });
        currentMission = replanBody.mission;
        if (replanBody.proposal?.action?.type === 'done' || replanBody.mission?.status === 'complete') {
          currentMission = null;
          taskButton.textContent = 'Начать новую задачу';
          setStatus('Задача завершена. Проверьте итог в программе.');
        } else if (replanBody.policy?.allowExecution === false) {
          setStatus(`Шаг остановлен безопасностью: ${replanBody.policy.reason}`, { error: true });
        } else {
          showPlan(replanBody);
          setStatus('Новый план готов. Окно обновлено, подтвердите выполнение нового шага.');
        }
      } catch (replanError) {
        setStatus(`Не удалось создать новый план: ${replanError.message}`, { error: true });
      }
      return; // Do not mark as executed - user must confirm new plan
    }
    resetStepView();
    if (autonomous) await recoverAnarchy('Автономный шаг не сработал', error.message);
    else setStatus(`Шаг не выполнен: ${error.message}`, { error: true });
  } finally {
    busy = false;
    updateControls();
  }
}

async function executeLearnedStep() {
  if (!currentSkillRun?.runId || !currentSkillRun.currentStep || busy) return;
  busy = true;
  executeButton.disabled = true;
  setStatus('Выполняю один шаг из вашей демонстрации и проверяю результат…');
  updateControls();
  try {
    const request = executeSavedSkillStepRequest({ runId: currentSkillRun.runId });
    const body = await api(request.path, request.options);
    currentSkillRun.status = body.status;
    currentSkillRun.stepIndex = body.executedStepIndex + 1;
    currentSkillRun.currentStep = null;
    resetFeedbackView();
    completedStep = { ...body, source: 'skill' };
    resetStepView();
    feedbackCard.hidden = false;
    feedbackTitle.textContent = body.validation?.success ? 'Шаг по показу выполнен' : 'Проверьте шаг по показу';
    const referenceText = body.referenceValidation
      ? body.referenceValidation.status === 'matched'
        ? ' Финальный результат совпал с вашим визуальным референсом.'
        : ` Сверка с референсом требует проверки: ${body.referenceValidation.evidence || body.referenceValidation.reason || 'нет уверенного совпадения'}`
      : '';
    feedbackDetail.textContent = `${body.validation?.evidence || 'Отметьте только итог: правильно или неправильно.'}${referenceText}`;
    setStatus('Оцените этот шаг: 👍 или 👎. Затем появится следующий шаг демонстрации.');
  } catch (error) {
    setStatus(`Шаг демонстрации не выполнен: ${error.message}`, { error: true });
  } finally {
    busy = false;
    updateControls();
  }
}

async function rateStep(rating) {
  if (!completedStep || busy) return;
  const ratedStep = completedStep;
  const payload = ratedStep.source === 'skill'
    ? { runId: ratedStep.runId, executedStepIndex: ratedStep.executedStepIndex, rating }
    : { planId: ratedStep.planId, rating };
  if ((!payload.planId && !payload.runId) || !['positive', 'negative'].includes(rating)) return;
  busy = true;
  positiveButton.disabled = true;
  negativeButton.disabled = true;
  if (rating === 'positive') positiveButton.textContent = '⏳';
  else negativeButton.textContent = '⏳';
  updateControls();
  let continueMission = false;
  let resumeCorrectedTask = false;
  try {
    const body = await api('/api/feedback/rate', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    completedStep = null;
    feedbackCard.hidden = true;
    if (ratedStep.source === 'skill') {
      if (rating === 'negative') {
        correctionResume = {
          kind: 'skill',
          skillId: currentSkillRun?.skill?.skillId || ratedStep.skillId || null,
          failedStepIndex: Number(ratedStep.executedStepIndex),
          nextStepIndex: Number(ratedStep.executedStepIndex) + 1,
          stepCount: currentSkillRun?.skill?.stepCount || 0,
          instruction: currentSkillRun?.skill?.instruction || taskInput.value.trim(),
          windowHandle: selectedWindowHandle,
          anarchyMode: false,
          autonomousGoal: null,
          missionId: null
        };
        showCorrection({ source: 'skill', ratedStep }, 'Шаг по показу оказался неверным. Можно показать правильный вариант только этого шага; описание не обязательно.');
        setStatus('Ошибка сохранена. Исправьте этот шаг текстом, мини‑демонстрацией или попросите другой способ.');
      } else if (body.skillRun?.currentStep && body.skillRun.status === 'ready') {
        currentSkillRun.status = body.skillRun.status;
        currentSkillRun.stepIndex = body.skillRun.stepIndex;
        showLearnedStep(body.skillRun.currentStep);
      } else {
        currentSkillRun = null;
        demoRunButton.hidden = false;
        if (correctionResume) {
          taskInput.value = correctionResume.instruction;
          anarchyMode = correctionResume.anarchyMode === true;
          anarchyAwaitingCorrection = false;
          anarchyResumeGoal = correctionResume.autonomousGoal || null;
          selectedWindowHandle = correctionResume.windowHandle || selectedWindowHandle;
          correctionResume = null;
          resumeCorrectedTask = true;
          setStatus('Исправленный шаг принят. Возвращаюсь к исходной задаче и продолжаю со свежего экрана…');
        } else {
          setStatus('Выполнение по демонстрации завершено. Последняя оценка сохранена.');
        }
      }
    } else {
      currentMission = body.mission || currentMission;
      if (rating === 'negative') {
        showCorrection({ source: 'mission', missionId: currentMission?.missionId || null, ratedStep }, 'Ошибка уже сохранена. Описание необязательно — можно сразу показать правильный шаг или попросить другой способ.');
        setStatus('Ошибка сохранена. Выберите способ коррекции этого шага.');
      } else {
        if (correctionResume?.kind === 'skill') {
          correctionResume.planId = ratedStep.planId;
          resumeCorrectedTask = true;
          setStatus('Исправление подтверждено. Возвращаюсь к следующему шагу того же причинного навыка…');
        } else {
          continueMission = Boolean(currentMission && currentMission.status !== 'limit_reached');
          setStatus('Правильный результат сохранён. Готовлю следующий шаг…');
        }
      }
    }
  } catch (error) {
    setStatus(`Не удалось сохранить оценку: ${error.message}`, { error: true });
    positiveButton.disabled = false;
    negativeButton.disabled = false;
    positiveButton.textContent = '👍';
    negativeButton.textContent = '👎';
  } finally {
    busy = false;
    updateControls();
  }
  if (continueMission) await planNextStep();
  else if (resumeCorrectedTask) await resumeCausalSkillAfterCorrection();
}

async function resumeCausalSkillAfterCorrection() {
  const resume = correctionResume;
  if (resume?.kind !== 'skill') return;
  await cancelMission();
  if (resume.planId && resume.correctionApplied !== true) {
    const applied = await api('/api/skills/apply-plan-correction', {
      method: 'POST',
      body: JSON.stringify({
        originalSkillId: resume.skillId,
        failedStepIndex: resume.failedStepIndex,
        planId: resume.planId
      })
    });
    resume.nextStepIndex = applied.resumeStepIndex;
    resume.stepCount = applied.stepCount;
    resume.correctionApplied = true;
  }
  if (!resume.skillId || resume.nextStepIndex >= resume.stepCount) {
    currentSkillRun = null;
    correctionResume = null;
    setStatus('Исправленный финальный шаг принят. Причинный навык завершён.');
    return;
  }
  const request = prepareSavedSkillRequest({
    skillId: resume.skillId,
    windowHandle: resume.windowHandle || selectedWindowHandle,
    startStepIndex: resume.nextStepIndex
  });
  const body = await api(request.path, request.options);
  selectedWindowHandle = resume.windowHandle || selectedWindowHandle;
  currentSkillRun = {
    ...body,
    stepIndex: body.startStepIndex,
    currentStep: body.currentStep,
    source: 'causal-correction-resume'
  };
  correctionResume = null;
  showLearnedStep(body.currentStep);
  setStatus('Исправление принято. Продолжаю тот же навык со следующего невыполненного причинного шага.');
}

function teachCurrentStep() {
  if (currentPlan?.planId) {
    showCorrection({
      source: 'mission',
      missionId: currentMission?.missionId || currentPlan.missionId || null,
      proposal: currentPlan.proposal || null
    }, 'Передайте JARVIS наблюдение об ошибке. Он сам переснимет экран, сформулирует переносимый урок и подготовит другой шаг.');
    return;
  }
  if (currentSkillRun?.currentStep) {
    showCorrection({
      source: 'skill',
      proposal: { action: currentSkillRun.currentStep }
    }, 'Исправьте этот сохранённый шаг текстом либо покажите правильное действие. После показа модель продолжит исходную задачу со свежего экрана.');
  }
}

function correctionInstruction(context) {
  const proposal = context?.proposal || context?.ratedStep?.proposal || null;
  const executed = context?.ratedStep?.executedStep || null;
  const reason = proposal?.reason || executed?.reason || actionLabel(executed || proposal?.action || {});
  const expected = proposal?.expectedResult || '';
  return `Покажите правильное выполнение только этого шага: ${reason}${expected ? `. Ожидаемый результат: ${expected}` : ''}`;
}

async function submitCorrection({ tryAnother = false } = {}) {
  if (!pendingCorrection || busy) return;
  const context = pendingCorrection;
  const correction = tryAnother
    ? 'Предыдущий способ неверен. Выбери другой безопасный видимый способ и не повторяй то же действие.'
    : correctionInput.value.trim();
  if (!correction) return;
  busy = true;
  updateControls();
  try {
    if (context.missionId) {
      const body = await api('/api/missions/correct-step', {
        method: 'POST',
        body: JSON.stringify({ missionId: context.missionId, correction })
      });
      currentMission = body.mission || currentMission;
    } else {
      const resume = correctionResume || {
        instruction: taskInput.value.trim() || currentSkillRun?.skill?.instruction || '',
        windowHandle: selectedWindowHandle,
        anarchyMode: false,
        autonomousGoal: null
      };
      await cancelSkillRun();
      const correctionTask = resume.kind === 'skill'
        ? `Исправь только один ошибочный шаг причинного навыка «${resume.instruction}»: ${correction}. После видимого результата остановись; следующие шаги навыка не выполняй.`
        : resume.instruction;
      taskInput.value = correctionTask;
      selectedWindowHandle = resume.windowHandle || selectedWindowHandle;
      anarchyMode = resume.anarchyMode === true;
      anarchyAwaitingCorrection = false;
      const started = await api('/api/missions', {
        method: 'POST',
        body: JSON.stringify({
          windowHandle: selectedWindowHandle,
          instruction: anarchyMode ? ANARCHY_INSTRUCTION : taskInput.value.trim(),
          maxSteps: anarchyMode ? 5 : 30,
          mode: anarchyMode ? 'anarchy' : 'guided',
          autonomousGoal: anarchyMode ? resume.autonomousGoal || anarchyResumeGoal : null
        })
      });
      currentMission = started.mission;
      anarchyResumeGoal = null;
      const corrected = await api('/api/missions/correct-step', {
        method: 'POST',
        body: JSON.stringify({ missionId: currentMission.missionId, correction })
      });
      currentMission = corrected.mission || currentMission;
      if (resume.kind !== 'skill') correctionResume = null;
    }
    hideCorrection();
    anarchyAwaitingCorrection = false;
    setStatus('Коррекция сохранена. Модель заново смотрит на свежий экран…');
  } catch (error) {
    setStatus(`Не удалось сохранить коррекцию: ${error.message}`, { error: true });
    return;
  } finally {
    busy = false;
    updateControls();
  }
  await planNextStep();
}

async function demonstrateCorrectionStep() {
  if (!pendingCorrection || busy) return;
  const resumeInstruction = taskInput.value.trim() ||
    (anarchyMode ? '' : currentMission?.instruction || currentSkillRun?.skill?.instruction || '');
  const existingSkillResume = correctionResume?.kind === 'skill'
    ? correctionResume
    : pendingCorrection.source === 'skill' && currentSkillRun
      ? {
          kind: 'skill',
          skillId: currentSkillRun.skill?.skillId || null,
          failedStepIndex: Number(currentSkillRun.stepIndex || 0),
          nextStepIndex: Number(currentSkillRun.stepIndex || 0) + 1,
          stepCount: currentSkillRun.skill?.stepCount || 0
        }
      : {};
  correctionResume = {
    ...existingSkillResume,
    instruction: resumeInstruction,
    windowHandle: selectedWindowHandle,
    anarchyMode,
    autonomousGoal: currentMission?.autonomousGoal || anarchyResumeGoal || null,
    missionId: currentMission?.missionId || null
  };
  stepTeachingContext = {
    instruction: correctionInstruction(pendingCorrection),
    source: pendingCorrection.source
  };
  hideCorrection();
  await toggleTeaching();
}

function drawTrace(events = []) {
  const rect = traceCanvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * scale));
  const height = Math.max(1, Math.round(rect.height * scale));
  if (traceCanvas.width !== width || traceCanvas.height !== height) {
    traceCanvas.width = width;
    traceCanvas.height = height;
  }
  const context = traceCanvas.getContext('2d');
  context.clearRect(0, 0, width, height);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.lineWidth = 2.5 * scale;
  context.strokeStyle = '#7379ff';
  context.shadowColor = 'rgba(115,121,255,.6)';
  context.shadowBlur = 8 * scale;
  let previous = null;
  for (const event of events) {
    if (!event.point) continue;
    const point = { x: event.point.x * width, y: event.point.y * height };
    if (previous && event.type === 'pointerMove') {
      context.beginPath();
      context.moveTo(previous.x, previous.y);
      context.lineTo(point.x, point.y);
      context.stroke();
    }
    if (event.type === 'drag' && event.to) {
      context.beginPath();
      context.moveTo(point.x, point.y);
      context.lineTo(event.to.x * width, event.to.y * height);
      context.stroke();
      previous = { x: event.to.x * width, y: event.to.y * height };
    } else {
      previous = point;
    }
    if (['click', 'doubleClick', 'drag'].includes(event.type)) {
      context.save();
      context.shadowBlur = 0;
      context.fillStyle = event.button === 'right' ? '#ff8d9c' : '#72e6ad';
      context.beginPath();
      context.arc(point.x, point.y, 5 * scale, 0, Math.PI * 2);
      context.fill();
      context.restore();
    }
  }
}

function renderTeachingPreview(preview = { events: [], eventCount: 0 }) {
  const events = preview.events || [];
  drawTrace(events);
  eventCount.textContent = `${preview.eventCount || 0} событий`;
  const keyEvents = events.filter((event) => event.key || event.textChanged).slice(-18);
  keys.replaceChildren();
  if (!keyEvents.length) {
    const placeholder = document.createElement('span');
    placeholder.className = 'key-placeholder';
    placeholder.textContent = 'Нажатые клавиши появятся здесь';
    keys.append(placeholder);
    return;
  }
  for (const event of keyEvents) {
    const chip = document.createElement('span');
    chip.className = 'key';
    chip.textContent = event.key || 'Текст изменён';
    keys.append(chip);
  }
}

async function pollTeaching() {
  try {
    const body = await api('/api/teach/status');
    if (!body.active) return;
    teachingSession = body.session;
    renderTeachingPreview(body.session?.preview);
    if (body.session?.recorderStopped && !busy) {
      stopTeachingPoll();
      await toggleTeaching();
    }
  } catch { }
}

function startTeachingPoll() {
  clearInterval(teachingTimer);
  teachingTimer = setInterval(pollTeaching, 300);
}

function stopTeachingPoll() {
  clearInterval(teachingTimer);
  teachingTimer = null;
}

async function resumeAfterStepDemonstration(skillId) {
  if (!correctionResume) return;
  const resume = correctionResume;
  if (resume.kind === 'skill') {
    const applied = await api('/api/skills/apply-demonstrated-correction', {
      method: 'POST',
      body: JSON.stringify({
        originalSkillId: resume.skillId,
        failedStepIndex: resume.failedStepIndex,
        correctionSkillId: skillId
      })
    });
    resume.nextStepIndex = applied.resumeStepIndex;
    resume.stepCount = applied.stepCount;
    resume.correctionApplied = true;
    reportJarvis('Обучение', `Мини‑демонстрация ${skillId} заменила ошибочный шаг; продолжаю исходный причинный навык.`);
    await resumeCausalSkillAfterCorrection();
    return;
  }
  taskInput.value = resume.instruction;
  selectedWindowHandle = resume.windowHandle || selectedWindowHandle;
  anarchyMode = resume.anarchyMode === true;
  anarchyAwaitingCorrection = false;
  anarchyResumeGoal = resume.autonomousGoal || null;
  if (!resume.missionId || currentMission?.missionId !== resume.missionId) {
    const started = await api('/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        windowHandle: selectedWindowHandle,
        instruction: anarchyMode ? ANARCHY_INSTRUCTION : taskInput.value.trim(),
        maxSteps: anarchyMode ? 6 : 30,
        mode: anarchyMode ? 'anarchy' : 'guided',
        autonomousGoal: anarchyMode ? anarchyResumeGoal : null
      })
    });
    currentMission = started.mission;
  }
  anarchyResumeGoal = null;
  const corrected = await api('/api/missions/correct-step', {
    method: 'POST',
    body: JSON.stringify({
      missionId: currentMission.missionId,
      correction: `Пользователь только что показал правильное выполнение ошибочного шага. Результат уже находится на свежем экране; не повторяй этот шаг. Продолжи исходную задачу со следующего ещё не выполненного результата. Сохранённый пример: ${skillId}.`
    })
  });
  currentMission = corrected.mission || currentMission;
  correctionResume = null;
  setStatus('Исправленный шаг сохранён как опыт. Продолжаю исходную задачу со свежего результата…');
  await planNextStep(false, anarchyMode ? anarchyRunId : null);
}

async function toggleTeaching() {
  if (busy) {
    if (anarchyMode && !teachingSession) {
      teachingRequested = true;
      clearAnarchyTimer();
      anarchyRunId += 1;
      demoButton.textContent = 'Готовлю показ…';
      setStatus('Завершаю только текущее физическое действие и сразу передаю вам управление для показа. Миссия и обучение сохраняются.');
      updateControls();
    }
    return;
  }
  let resumeCorrectionSkillId = null;
  busy = true;
  updateControls();
  try {
    if (!teachingSession) {
      const passiveLearning = !stepTeachingContext;
      if (anarchyMode) {
        clearAnarchyTimer();
        anarchyRunId += 1;
        if (!correctionResume) {
          correctionResume = {
            instruction: '',
            windowHandle: selectedWindowHandle,
            anarchyMode: true,
            autonomousGoal: currentMission?.autonomousGoal || anarchyResumeGoal || null,
            missionId: currentMission?.missionId || null
          };
          stepTeachingContext = {
            instruction: `Покажите правильный способ для текущей гипотезы JARVIS: ${currentMission?.autonomousGoal?.goal || 'преодолеть текущее затруднение в видимом интерфейсе'}`,
            source: 'anarchy'
          };
        }
      }
      await cancelSkillRun();
      resetFeedbackView();
      demoRunButton.hidden = true;
      const instruction = passiveLearning
        ? 'Наблюдать за моей работой и сохранять переносимые приёмы'
        : stepTeachingContext?.instruction || taskInput.value.trim() || 'Показать правильный способ для текущего затруднения';
      if (passiveLearning) {
        demoButton.textContent = 'Через 3 секунды…';
        demoTitle.textContent = 'Подготовьте правый монитор';
        demoStatus.textContent = 'Откройте на правом мониторе любые программы и диалоги. Выбирать отдельное окно не нужно: агент увидит монитор целиком и только наблюдает.';
        setStatus('Через 3 секунды начнётся наблюдение всего правого монитора…');
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      const body = await api('/api/teach/start', {
        method: 'POST',
        body: JSON.stringify({
          ...(passiveLearning
            ? { captureDisplay: true, learningMode: 'passive' }
            : { windowHandle: selectedWindowHandle }),
          instruction,
          name: instruction.slice(0, 96),
          maxDurationSeconds: passiveLearning ? 1800 : 180
        })
      });
      teachingSession = body;
      demoButton.textContent = passiveLearning ? 'Завершить наблюдение' : 'Завершить показ';
      demoButton.classList.add('recording');
      demoTitle.textContent = passiveLearning ? 'Ассистент наблюдает и учится' : 'Демонстрация записывается';
      demoStatus.textContent = passiveLearning
        ? 'Записываются все окна, диалоги, мышь, клавиатура и траектории на правом мониторе. Завершите из любой программы: Ctrl+Alt+F10.'
        : `Записываются мышь, клавиатура и траектории в окне: ${body.window?.name || body.window?.processName || 'выбранная программа'}.`;
      demoLive.hidden = false;
      renderTeachingPreview();
      startTeachingPoll();
      setStatus(passiveLearning
        ? 'Работайте как обычно на правом мониторе. Важные действия и изменения интерфейса попадут в кадры. После результата подождите секунду и нажмите Ctrl+Alt+F10.'
        : 'Покажите правильное выполнение в выбранной программе.');
    } else {
      const wasStepCorrection = Boolean(stepTeachingContext);
      const wasPassiveLearning = teachingSession.learningMode === 'passive';
      stopTeachingPoll();
      demoButton.disabled = true;
      demoStatus.textContent = 'Собираю логический навык из траектории, элементов и клавиш…';
      const body = await api('/api/teach/stop', {
        method: 'POST',
        body: JSON.stringify({ sessionId: teachingSession.sessionId })
      });
      teachingSession = null;
      if (!wasPassiveLearning) {
        latestDemonstratedSkillId = body.skill?.skillId || null;
        if (latestDemonstratedSkillId) localStorage.setItem('ai-latest-skill-id', latestDemonstratedSkillId);
      }
      demoButton.textContent = 'Наблюдать и учиться';
      demoButton.classList.remove('recording');
      demoTitle.textContent = wasStepCorrection ? 'Исправленный шаг сохранён' : 'Показ сохранён';
      demoStatus.textContent = wasStepCorrection
        ? `Сохранено ${body.skill?.steps?.length || 0} действий и финальный визуальный референс. Результат показа уже принят как исправление.`
        : `Сохранено ${body.skill?.steps?.length || 0} действий и финальный визуальный референс. Верните программу к состоянию до показа и запустите выполнение ниже.`;
      demoRunButton.hidden = wasStepCorrection || wasPassiveLearning || !latestDemonstratedSkillId;
      setStatus(wasStepCorrection
        ? 'Мини‑демонстрация шага сохранена вместе с референсом. Продолжаю исходную задачу с уже достигнутого результата.'
        : 'Показ сохранён. Когда программа снова будет в исходном состоянии, нажмите «Выполнить с учётом показа».');
      if (wasPassiveLearning) {
        const semantic = body.semanticCompilation?.experience;
        latestObservedSkill = body.skill?.semanticExperience ? body.skill : null;
        observationReview.hidden = !latestObservedSkill;
        observationUnderstanding.hidden = true;
        demoTitle.textContent = semantic?.understood ? 'Опыт понят и сохранён' : 'Наблюдение сохранено для уточнения';
        demoStatus.textContent = semantic?.understood
          ? `Цель: ${semantic.sessionGoal || 'определена'}. Результат: ${semantic.comparison?.outcome || 'сравнён по кадрам до и после'}. Подсказок учителя: ${body.skill?.demonstration?.guidance?.length || 0}; причинных эпизодов: ${semantic.episodes?.length || 0}.`
          : `Сырые действия и кадры сохранены, но смысл пока не подтверждён. ${body.semanticCompilationError || semantic?.comparison?.outcome || 'Нужно более короткое наблюдение или уточнение.'}`;
        setStatus(semantic?.understood
          ? 'JARVIS сравнил начало и итог, выделил цель, причинные действия и переносимые приёмы.'
          : 'Наблюдение не потеряно, но не будет выдаваться за готовое знание без уверенного сравнения результата.');
      }
      if (wasStepCorrection) resumeCorrectionSkillId = latestDemonstratedSkillId;
      stepTeachingContext = null;
    }
  } catch (error) {
    stopTeachingPoll();
    if (teachingSession?.sessionId) {
      try {
        await api('/api/teach/cancel', {
          method: 'POST',
          body: JSON.stringify({ sessionId: teachingSession.sessionId })
        });
      } catch { }
    }
    teachingSession = null;
    demoButton.textContent = 'Наблюдать и учиться';
    demoButton.classList.remove('recording');
    demoTitle.textContent = 'Показ не сохранён';
    demoStatus.textContent = error.message;
    setStatus(error.message, { error: true });
  } finally {
    busy = false;
    updateControls();
  }
  if (resumeCorrectionSkillId) {
    try {
      await resumeAfterStepDemonstration(resumeCorrectionSkillId);
    } catch (error) {
      setStatus(`Показ сохранён, но продолжить исходную задачу не удалось: ${error.message}`, { error: true });
    }
  }
}

function explainLatestObservation() {
  if (!latestObservedSkill) return;
  const summary = summarizeSemanticObservation(latestObservedSkill);
  observationUnderstanding.textContent = summary;
  observationUnderstanding.hidden = false;
  demoStatus.textContent = canRepeatSemanticObservation(latestObservedSkill)
    ? 'Если описание верное, нажмите «Повтори понятое». Модель построит действия заново по свежему экрану.'
    : 'Смысл недостаточно подтверждён для повтора. Покажите более короткое законченное действие и завершите его Ctrl+Alt+F10.';
  reportJarvis('Наблюдение', summary);
  updateControls();
}

async function repeatLatestObservation() {
  if (!selectedWindowHandle || busy) return;
  const goal = semanticObservationGoal(latestObservedSkill);
  if (!goal) {
    explainLatestObservation();
    setStatus('JARVIS пока не понял наблюдение достаточно хорошо для смыслового повтора.', { error: true });
    return;
  }
  const selected = windowCatalog.find((item) => Number(item.nativeWindowHandle) === selectedWindowHandle);
  if (selected?.processName !== latestObservedSkill.application?.processName) {
    setStatus(`Выберите окно программы ${latestObservedSkill.application?.processName || 'из наблюдения'}, затем повторите попытку.`, { error: true });
    return;
  }
  busy = true;
  updateControls();
  try {
    stopAnarchyLoop();
    await cancelMission();
    await cancelSkillRun();
    hideCorrection();
    resetFeedbackView();
    taskInput.value = goal.goal;
    const request = prepareSavedSkillRequest({
      windowHandle: selectedWindowHandle,
      skillId: latestObservedSkill.skillId
    });
    const body = await api(request.path, request.options);
    currentSkillRun = {
      ...body,
      stepIndex: body.startStepIndex || 0,
      currentStep: body.currentStep,
      source: 'causal-observation'
    };
    showLearnedStep(body.currentStep);
    setStatus(`Причинный повтор готов: ${goal.goal}. Используются все ${body.skill?.stepCount || 0} сохранённых действий, свежая геометрия окна и референсы каждого шага.`);
    reportJarvis('Повтор', `Цель: ${goal.goal}. Критерий: ${goal.successCriteria}`);
  } catch (error) {
    setStatus(`Не удалось подготовить причинный повтор: ${error.message}`, { error: true });
  } finally {
    busy = false;
    updateControls();
  }
}

async function runDemonstratedSkill() {
  if (!latestDemonstratedSkillId || !selectedWindowHandle || busy) return;
  busy = true;
  updateControls();
  try {
    await cancelMission();
    resetFeedbackView();
    const request = prepareSavedSkillRequest({
      windowHandle: selectedWindowHandle,
      skillId: latestDemonstratedSkillId
    });
    const body = await api(request.path, request.options);
    currentSkillRun = {
      ...body,
      stepIndex: 0,
      currentStep: body.currentStep
    };
    demoRunButton.hidden = true;
    showLearnedStep(body.currentStep);
  } catch (error) {
    setStatus(`Не удалось подготовить показ: ${error.message}`, { error: true });
  } finally {
    busy = false;
    updateControls();
  }
}

windowSelect.addEventListener('focus', () => {
  if (!busy && !teachingSession) scanWindows();
});

windowSelect.addEventListener('change', async () => {
  await stopCurrentAgentSession('window_changed');
  await cancelMission();
  await cancelSkillRun();
  resetFeedbackView();
  selectedWindowHandle = Number(windowSelect.value) || null;
  if (selectedWindowHandle) localStorage.setItem('ai-window-handle', String(selectedWindowHandle));
  await watchSelectedWindow();
  await refreshLatestDemonstration();
  updateControls();
});

taskInput.addEventListener('input', () => {
  if (anarchyMode) anarchyMode = false;
  anarchyResumeGoal = null;
  if (currentMission && taskInput.value.trim() !== currentMission.instruction) cancelMission();
  if (currentAgentSessionId && !currentAgentAwaitingUser && taskInput.value.trim() !== currentAgentSessionGoal) {
    stopCurrentAgentSession('goal_changed');
  }
  resetFeedbackView();
  taskButton.textContent = currentAgentAwaitingUser
    ? 'Ответить JARVIS'
    : currentMission ? 'Следующий шаг' : 'Подготовить первый шаг';
  updateControls();
});

correctionInput.addEventListener('input', updateControls);

taskInput.addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.key === 'Enter') runUnifiedAgentTurn();
});

taskButton.addEventListener('click', () => runUnifiedAgentTurn());
executeButton.addEventListener('click', () => executeStep());
teachStepButton.addEventListener('click', teachCurrentStep);
positiveButton.addEventListener('click', () => rateStep('positive'));
negativeButton.addEventListener('click', () => rateStep('negative'));
correctionSubmit.addEventListener('click', () => submitCorrection());
correctionSkip.addEventListener('click', () => submitCorrection({ tryAnother: true }));
correctionDemo.addEventListener('click', demonstrateCorrectionStep);
demoButton.addEventListener('click', toggleTeaching);
demoRunButton.addEventListener('click', runDemonstratedSkill);
observationUnderstoodButton.addEventListener('click', explainLatestObservation);
observationRepeatButton.addEventListener('click', repeatLatestObservation);
teacherScreenshot.addEventListener('change', () => {
  teacherAttachment.textContent = teacherScreenshot.files?.[0]?.name || 'Файл не выбран';
});
teacherSend.addEventListener('click', sendTeacherMessage);
teacherFixLast.addEventListener('click', fixLatestWorkerError);
programmerButton.addEventListener('click', () => {
  document.querySelector('#teacher-chat')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  window.setTimeout(() => teacherMessage.focus(), 250);
});
teacherMessage.addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.key === 'Enter') sendTeacherMessage();
});
teacherApply.addEventListener('click', applyTeacherCodeProposal);
teacherRollback.addEventListener('click', rollbackTeacherCodeProposal);
teacherTaskRun.addEventListener('click', runTeacherTask);
teacherSave.addEventListener('click', async () => {
  teacherSave.disabled = true;
  try {
    const body = await api('/api/teacher/profile', {
      method: 'POST',
      body: JSON.stringify({
        name: teacherName.value.trim(),
        mission: teacherMission.value.trim(),
        values: teacherValues.value.trim()
      })
    });
    teacherProfileLoaded = false;
    renderTeacherProfile(body);
    setStatus('Цели и ценности JARVIS сохранены. Они применятся к следующему плану.');
  } catch (error) {
    setStatus(`Не удалось сохранить JARVIS: ${error.message}`, { error: true });
  } finally {
    teacherSave.disabled = false;
  }
});

anarchyButton.addEventListener('click', async () => {
  if (anarchyMode) {
    if (anarchyAwaitingCorrection) {
      anarchyAwaitingCorrection = false;
      anarchyRecoveryState = resetAnarchyRecoveryState();
      hideCorrection();
      setStatus('Автономный режим продолжен. JARVIS выбирает следующий шаг по свежему экрану…');
      updateControls();
      await runUnifiedAgentTurn({ autonomous: true });
      return;
    }
    stopAnarchyLoop();
    await stopCurrentAgentSession('autonomous_mode_stopped');
    await cancelMission();
    resetFeedbackView();
    setStatus('Автономная сессия остановлена. Обычная задача и ваши данные не изменены.');
    updateControls();
    return;
  }
  if (busy || !selectedWindowHandle) return;
  await stopCurrentAgentSession('autonomous_mode_started');
  await cancelMission();
  await cancelSkillRun();
  hideCorrection();
  resetFeedbackView();
  anarchyMode = true;
  semanticReplayMode = false;
  anarchyAwaitingCorrection = false;
  anarchyRunId += 1;
  anarchyStepCount = 0;
  anarchyResumeGoal = null;
  setStatus('JARVIS начал автономный режим в выбранной программе. Все решения идут через одну AgentSession и единый журнал событий; остановить можно этой кнопкой или «Стоп».' );
  updateControls();
  await runUnifiedAgentTurn({ autonomous: true });
});

safetyToggle.addEventListener('click', async () => {
  safetyToggle.disabled = true;
  try {
    if (paused) {
      setStatus('Запускаю LM Studio и загружаю локальную модель…');
      await api('/api/safety/resume', {
        method: 'POST',
        body: JSON.stringify({ confirmed: true, startModel: true })
      });
    } else {
      if (anarchyMode) stopAnarchyLoop();
      await stopCurrentAgentSession('safety_pause');
      setStatus('Останавливаю действия, наблюдение и LM Server…');
      await api('/api/safety/pause', {
        method: 'POST',
        body: JSON.stringify({
          reason: 'Остановлено пользователем из простого интерфейса',
          stopModel: true
        })
      });
    }
    await refreshSystemStatus();
  } catch (error) {
    setStatus(error.message, { error: true });
  } finally {
    safetyToggle.disabled = false;
  }
});

fullShutdownButton.addEventListener('click', async () => {
  if (fullShutdownActive) return;
  fullShutdownActive = true;
  if (anarchyMode) stopAnarchyLoop();
  await stopCurrentAgentSession('full_shutdown');
  clearAnarchyTimer();
  stopTeachingPoll();
  statusDot.className = 'status-dot pending';
  statusText.textContent = 'Полностью отключаю локальный ИИ…';
  taskStatus.textContent = 'Останавливаю задания, наблюдение, виртуальный курсор, Worker и LM Studio.';
  updateControls();
  try {
    await api('/api/system/shutdown', {
      method: 'POST',
      body: JSON.stringify({ confirmed: true })
    });
    statusDot.className = 'status-dot';
    statusText.textContent = 'Полностью отключено';
    taskStatus.textContent = 'Все локальные компоненты ИИ остановлены. Для нового запуска используйте start-all.ps1.';
  } catch (error) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    try {
      await api('/api/status');
      fullShutdownActive = false;
      statusDot.className = 'status-dot error';
      statusText.textContent = 'Не удалось полностью отключить';
      taskStatus.textContent = error.message;
      updateControls();
    } catch {
      // The expected final state is an unavailable controller.
      statusDot.className = 'status-dot';
      statusText.textContent = 'Полностью отключено';
      taskStatus.textContent = 'Локальный ИИ остановлен. Панель больше не подключена к контроллеру.';
    }
  }
});

window.addEventListener('resize', () => {
  if (!demoLive.hidden) pollTeaching();
});

await Promise.all([refreshSystemStatus(), scanWindows(), refreshTeacherChat()]);
try {
  const teaching = await api('/api/teach/status');
  if (teaching.active) {
    teachingSession = teaching.session;
    demoButton.textContent = teaching.session?.learningMode === 'passive' ? 'Завершить наблюдение' : 'Завершить показ';
    demoButton.classList.add('recording');
    demoTitle.textContent = teaching.session?.learningMode === 'passive' ? 'Ассистент наблюдает и учится' : 'Демонстрация записывается';
    demoLive.hidden = false;
    renderTeachingPreview(teaching.session?.preview);
    startTeachingPoll();
  }
} catch { }
demoRunButton.hidden = !latestDemonstratedSkillId;
updateControls();
