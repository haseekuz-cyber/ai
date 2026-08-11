const $ = (selector) => document.querySelector(selector);

const statusDot = $('#status-dot');
const statusText = $('#status-text');
const safetyToggle = $('#safety-toggle');
const windowSelect = $('#window-select');
const taskInput = $('#task-input');
const taskButton = $('#task-button');
const taskStatus = $('#task-status');
const stepCard = $('#step-card');
const stepNumber = $('#step-number');
const stepReason = $('#step-reason');
const stepAction = $('#step-action');
const stepResult = $('#step-result');
const executeButton = $('#execute-button');
const feedbackCard = $('#feedback-card');
const feedbackTitle = $('#feedback-title');
const feedbackDetail = $('#feedback-detail');
const positiveButton = $('#positive-button');
const negativeButton = $('#negative-button');
const demoButton = $('#demo-button');
const demoRunButton = $('#demo-run-button');
const demoTitle = $('#demo-title');
const demoStatus = $('#demo-status');
const demoLive = $('#demo-live');
const traceCanvas = $('#trace-canvas');
const eventCount = $('#event-count');
const keys = $('#keys');

let selectedWindowHandle = null;
let currentMission = null;
let currentPlan = null;
let completedStep = null;
let currentSkillRun = null;
let latestDemonstratedSkillId = localStorage.getItem('ai-latest-skill-id') || null;
let windowCatalog = [];
let teachingSession = null;
let teachingTimer = null;
let paused = false;
let busy = false;

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
}

function resetFeedbackView() {
  completedStep = null;
  feedbackCard.hidden = true;
  positiveButton.disabled = false;
  negativeButton.disabled = false;
  positiveButton.textContent = '👍';
  negativeButton.textContent = '👎';
}

function updateControls() {
  const hasInput = Boolean(selectedWindowHandle && taskInput.value.trim());
  taskButton.disabled = busy || paused || Boolean(teachingSession) || Boolean(currentSkillRun) || !hasInput || Boolean(currentPlan) || Boolean(completedStep);
  demoButton.disabled = busy || !hasInput;
  demoRunButton.disabled = busy || paused || !selectedWindowHandle || !latestDemonstratedSkillId || Boolean(teachingSession) || Boolean(currentPlan) || Boolean(completedStep) || Boolean(currentSkillRun);
  windowSelect.disabled = busy || Boolean(teachingSession) || Boolean(currentSkillRun);
  taskInput.disabled = busy || Boolean(teachingSession) || Boolean(currentSkillRun);
  executeButton.disabled = busy || paused || (!currentPlan && !currentSkillRun?.currentStep);
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
  if (!selected) {
    latestDemonstratedSkillId = null;
    demoRunButton.hidden = true;
    return;
  }
  try {
    const body = await api('/api/skills');
    const skill = (body.skills || []).find((item) => item.application?.processName === selected.processName);
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
  } catch { }
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
    await refreshLatestDemonstration();
  } catch (error) {
    windowSelect.replaceChildren(new Option('Не удалось получить список программ', ''));
    setStatus(error.message, { error: true });
  }
  updateControls();
}

async function refreshSystemStatus() {
  try {
    const body = await api('/api/status');
    paused = body.worker?.safety?.paused === true;
    const ready = body.independentControl?.ready === true;
    statusDot.className = `status-dot ${ready ? 'ready' : 'error'}`;
    statusText.textContent = paused ? 'Действия приостановлены' : ready ? 'Локальная модель готова' : 'Управление пока не готово';
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
  currentPlan = body;
  stepNumber.textContent = `Шаг ${(body.mission?.stepCount || 0) + 1}`;
  stepReason.textContent = body.proposal?.reason || 'Следующее действие';
  stepAction.textContent = actionLabel(body.proposal?.action);
  stepResult.textContent = body.proposal?.expectedResult ? `Ожидаемый результат: ${body.proposal.expectedResult}` : '';
  stepCard.hidden = false;
  setStatus('Модель предложила один шаг. Нажатие кнопки ниже — его подтверждение.');
  updateControls();
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

async function planNextStep(retriedAfterRestart = false) {
  const instruction = taskInput.value.trim();
  if (!selectedWindowHandle || !instruction || busy) return;
  busy = true;
  resetStepView();
  setStatus('Модель изучает свежий интерфейс и готовит один шаг…');
  updateControls();
  try {
    if (!currentMission?.missionId || currentMission.instruction !== instruction) {
      await cancelMission();
      const started = await api('/api/missions', {
        method: 'POST',
        body: JSON.stringify({ windowHandle: selectedWindowHandle, instruction, maxSteps: 30 })
      });
      currentMission = started.mission;
    }
    const body = await api('/api/missions/plan-next', {
      method: 'POST',
      body: JSON.stringify({ missionId: currentMission.missionId })
    });
    currentMission = body.mission;
    if (body.proposal?.action?.type === 'done' || body.mission?.status === 'complete') {
      currentMission = null;
      taskButton.textContent = 'Начать новую задачу';
      setStatus('Задача завершена. Проверьте итог в программе.');
    } else if (body.policy?.allowExecution === false) {
      setStatus(`Шаг остановлен безопасностью: ${body.policy.reason}`, { error: true });
    } else {
      showPlan(body);
    }
  } catch (error) {
    if (error.body?.error === 'mission_not_found' && !retriedAfterRestart) {
      currentMission = null;
      busy = false;
      updateControls();
      return await planNextStep(true);
    }
    const suggestion = error.body?.abortReason === 'visual_target_not_verified'
      ? ' Модель не уверена — нажмите «Демонстрация» и покажите правильный способ.'
      : '';
    setStatus(`${error.message}${suggestion}`, { error: true });
  } finally {
    busy = false;
    updateControls();
  }
}

async function executeStep() {
  if (currentSkillRun?.currentStep) return executeLearnedStep();
  if (!currentPlan?.planId || busy) return;
  busy = true;
  executeButton.disabled = true;
  setStatus('Выполняю один шаг и проверяю результат…');
  updateControls();
  try {
    const body = await api('/api/agent/execute-plan', {
      method: 'POST',
      body: JSON.stringify({ planId: currentPlan.planId, confirmed: true })
    });
    currentMission = body.mission || currentMission;
    resetFeedbackView();
    completedStep = body;
    resetStepView();
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
      setStatus('Окно изменило размер или позицию. Запрашиваю новый план для того же окна…');
      // One request produces one fresh proposal; execution still requires confirmation.
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
    setStatus(`Шаг не выполнен: ${error.message}`, { error: true });
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
    const body = await api('/api/skills/execute-step', {
      method: 'POST',
      body: JSON.stringify({ runId: currentSkillRun.runId, confirmed: true })
    });
    currentSkillRun.status = body.status;
    currentSkillRun.stepIndex = body.executedStepIndex + 1;
    currentSkillRun.currentStep = null;
    resetFeedbackView();
    completedStep = { ...body, source: 'skill' };
    resetStepView();
    feedbackCard.hidden = false;
    feedbackTitle.textContent = body.validation?.success ? 'Шаг по показу выполнен' : 'Проверьте шаг по показу';
    feedbackDetail.textContent = body.validation?.evidence || 'Отметьте только итог: правильно или неправильно.';
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
  try {
    const body = await api('/api/feedback/rate', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    completedStep = null;
    feedbackCard.hidden = true;
    if (ratedStep.source === 'skill') {
      if (ratedStep.nextStep && ratedStep.status === 'ready') {
        showLearnedStep(ratedStep.nextStep);
      } else {
        currentSkillRun = null;
        demoRunButton.hidden = false;
        setStatus('Выполнение по демонстрации завершено. Последняя оценка сохранена.');
      }
    } else {
      currentMission = body.mission || currentMission;
      continueMission = Boolean(currentMission && currentMission.status !== 'limit_reached');
      setStatus(rating === 'positive'
        ? 'Правильный результат сохранён. Готовлю следующий шаг…'
        : 'Ошибка сохранена. Готовлю другой или исправляющий следующий шаг…');
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

async function toggleTeaching() {
  if (busy) return;
  busy = true;
  updateControls();
  try {
    if (!teachingSession) {
      await cancelMission();
      await cancelSkillRun();
      resetFeedbackView();
      demoRunButton.hidden = true;
      const instruction = taskInput.value.trim();
      const body = await api('/api/teach/start', {
        method: 'POST',
        body: JSON.stringify({
          windowHandle: selectedWindowHandle,
          instruction,
          name: instruction.slice(0, 96),
          maxDurationSeconds: 180
        })
      });
      teachingSession = body;
      demoButton.textContent = 'Завершить показ';
      demoButton.classList.add('recording');
      demoTitle.textContent = 'Демонстрация записывается';
      demoStatus.textContent = 'Работайте в выбранной программе. Здесь видны траектория и клавиши.';
      demoLive.hidden = false;
      renderTeachingPreview();
      startTeachingPoll();
      setStatus('Покажите правильное выполнение в выбранной программе.');
    } else {
      stopTeachingPoll();
      demoButton.disabled = true;
      demoStatus.textContent = 'Собираю логический навык из траектории, элементов и клавиш…';
      const body = await api('/api/teach/stop', {
        method: 'POST',
        body: JSON.stringify({ sessionId: teachingSession.sessionId })
      });
      teachingSession = null;
      latestDemonstratedSkillId = body.skill?.skillId || null;
      if (latestDemonstratedSkillId) localStorage.setItem('ai-latest-skill-id', latestDemonstratedSkillId);
      demoButton.textContent = 'Демонстрация';
      demoButton.classList.remove('recording');
      demoTitle.textContent = 'Показ сохранён';
      demoStatus.textContent = `Сохранено ${body.skill?.steps?.length || 0} действий. Верните программу к состоянию до показа и запустите выполнение ниже.`;
      demoRunButton.hidden = !latestDemonstratedSkillId;
      setStatus('Показ сохранён. Когда программа снова будет в исходном состоянии, нажмите «Выполнить с учётом показа».');
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
    demoButton.textContent = 'Демонстрация';
    demoButton.classList.remove('recording');
    demoTitle.textContent = 'Показ не сохранён';
    demoStatus.textContent = error.message;
    setStatus(error.message, { error: true });
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
    const body = await api('/api/skills/prepare', {
      method: 'POST',
      body: JSON.stringify({
        windowHandle: selectedWindowHandle,
        skillId: latestDemonstratedSkillId
      })
    });
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
  await cancelMission();
  await cancelSkillRun();
  resetFeedbackView();
  selectedWindowHandle = Number(windowSelect.value) || null;
  if (selectedWindowHandle) localStorage.setItem('ai-window-handle', String(selectedWindowHandle));
  await refreshLatestDemonstration();
  updateControls();
});

taskInput.addEventListener('input', () => {
  if (currentMission && taskInput.value.trim() !== currentMission.instruction) cancelMission();
  resetFeedbackView();
  taskButton.textContent = currentMission ? 'Следующий шаг' : 'Подготовить первый шаг';
  updateControls();
});

taskInput.addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.key === 'Enter') planNextStep();
});

taskButton.addEventListener('click', () => planNextStep());
executeButton.addEventListener('click', executeStep);
positiveButton.addEventListener('click', () => rateStep('positive'));
negativeButton.addEventListener('click', () => rateStep('negative'));
demoButton.addEventListener('click', toggleTeaching);
demoRunButton.addEventListener('click', runDemonstratedSkill);

safetyToggle.addEventListener('click', async () => {
  safetyToggle.disabled = true;
  try {
    if (paused) {
      await api('/api/safety/resume', { method: 'POST', body: JSON.stringify({ confirmed: true }) });
    } else {
      await api('/api/safety/pause', { method: 'POST', body: JSON.stringify({ reason: 'Остановлено пользователем из простого интерфейса' }) });
    }
    await refreshSystemStatus();
  } catch (error) {
    setStatus(error.message, { error: true });
  } finally {
    safetyToggle.disabled = false;
  }
});

window.addEventListener('resize', () => {
  if (!demoLive.hidden) pollTeaching();
});

await Promise.all([refreshSystemStatus(), scanWindows()]);
try {
  const teaching = await api('/api/teach/status');
  if (teaching.active) {
    teachingSession = teaching.session;
    demoButton.textContent = 'Завершить показ';
    demoButton.classList.add('recording');
    demoTitle.textContent = 'Демонстрация записывается';
    demoLive.hidden = false;
    renderTeachingPreview(teaching.session?.preview);
    startTeachingPoll();
  }
} catch { }
demoRunButton.hidden = !latestDemonstratedSkillId;
updateControls();
