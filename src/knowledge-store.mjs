import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function clean(value, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export const CORE_PRINCIPLES = Object.freeze([
  {
    principleId: 'core:fresh-semantic-screen',
    signature: 'core:fresh-semantic-screen',
    name: 'Свежий экран и смысл цели',
    description: 'Перед каждым действием заново наблюдать выбранное окно и находить цель по её роли, виду и контексту. Не воспроизводить абсолютные координаты вслепую.'
  },
  {
    principleId: 'core:goal-before-action',
    signature: 'core:goal-before-action',
    name: 'Результат важнее повторения',
    description: 'Если ожидаемое состояние уже достигнуто и подтверждено, не повторять действие. Переходить к следующему недостигнутому результату исходной задачи.'
  },
  {
    principleId: 'core:visible-verification',
    signature: 'core:visible-verification',
    name: 'Проверять каждый результат',
    description: 'После физического действия обязательно проверить свежий экран. Тайм-аут, отсутствие изменения или сомнение не считать успехом; самостоятельно исследовать причину и перепланировать.'
  },
  {
    principleId: 'core:preconditions-first',
    signature: 'core:preconditions-first',
    name: 'Сначала подготовить объект',
    description: 'Перед изменением объекта проверить обязательные условия: объект существует, видим и выделен, нужный инструмент или режим активен. Если действие вызвало предупреждение или окно ошибки, закрыть препятствие, восстановить условия и только затем повторять цель другим способом.'
  },
  {
    principleId: 'core:learn-through-recovery',
    signature: 'core:learn-through-recovery',
    name: 'Учиться через восстановление',
    description: 'Ошибка не завершает автономное обучение. Сохранить наблюдаемую причину, переснять экран, изучить встроенную подсказку или публичную документацию, сформулировать новую гипотезу и проверить другой способ.'
  },
  {
    principleId: 'core:causal-input',
    signature: 'core:causal-input',
    name: 'Причинно важные движения и клавиши',
    description: 'Сохранять и адаптировать траекторию, длительность и Ctrl, Shift или Alt только когда они влияют на результат. Случайный путь к кнопке не превращать в навык.'
  },
  {
    principleId: 'core:generalize-learning',
    signature: 'core:generalize-learning',
    name: 'Обобщать опыт',
    description: 'Запоминать переносимый приём, условие его применения, видимый критерий успеха и личное предпочтение. Не сохранять как принцип конкретную задачу, размер, введённую фразу, имя документа или координату.'
  },
  {
    principleId: 'core:safe-autonomy',
    signature: 'core:safe-autonomy',
    name: 'Самостоятельность с границами',
    description: 'JARVIS сам исследует, отвечает планировщику и исправляет шаги. Внешние отправки, удаления, публикации, покупки и опасные настройки требуют явного разрешения человека.'
  }
]);

function actionSignature(record) {
  const action = record?.step?.action || {};
  const modifiers = Array.isArray(action.modifiers) ? [...action.modifiers].sort().join('+') : '';
  const trajectoryMode = clean(action.trajectoryMode, 40);
  return [clean(action.type, 40) || 'unknown', modifiers, trajectoryMode].join('|');
}

function principleStatement(record) {
  const action = record?.step?.action || {};
  const modifiers = Array.isArray(action.modifiers) ? action.modifiers : [];
  if (action.type === 'drag' && modifiers.length) {
    return `При drag удерживай ${modifiers.join('+')} на всей траектории только когда это явно требуется задачей или проверенным показом; точки заново привязывай к свежему экрану.`;
  }
  if (action.type === 'drag') {
    return 'Перед drag заново находи объект и допустимую область по свежему экрану; траекторию адаптируй к геометрии, не повторяй абсолютные координаты вслепую.';
  }
  if (['click', 'doubleClick'].includes(action.type)) {
    return 'Используй click только для дискретной видимой цели; перед действием заново проверь элемент и его положение на свежем экране.';
  }
  if (action.type === 'typeText') {
    return 'Перед вводом текста заново проверь назначение и границы редактируемого поля; желаемое новое значение не считай текущей подписью поля.';
  }
  if (action.type === 'pressKey') {
    return 'Клавишу или сочетание применяй только при подтверждённом фокусе нужного окна и проверяй видимый результат после нажатия.';
  }
  return `Действие ${clean(action.type, 40) || 'UI'} выполняй только после свежего наблюдения и сохраняй человеческую оценку результата.`;
}

function principleName(record) {
  const action = record?.step?.action || {};
  const modifiers = Array.isArray(action.modifiers) ? action.modifiers : [];
  if (action.type === 'drag' && modifiers.length) return `Перетаскивание с ${modifiers.join('+')}`;
  if (action.type === 'drag') return 'Адаптивное перетаскивание';
  if (action.type === 'click') return 'Безопасный клик';
  if (action.type === 'doubleClick') return 'Безопасный двойной клик';
  if (action.type === 'typeText') return 'Проверенный ввод текста';
  if (action.type === 'pressKey') return 'Клавиши в правильном окне';
  return `Проверенное действие ${clean(action.type, 40) || 'UI'}`;
}

function principleNameFromSignature(signature) {
  const [type, modifiers] = clean(signature, 160).split('|');
  if (type === 'drag' && modifiers) return `Перетаскивание с ${modifiers}`;
  if (type === 'drag') return 'Адаптивное перетаскивание';
  if (type === 'click') return 'Безопасный клик';
  if (type === 'doubleClick') return 'Безопасный двойной клик';
  if (type === 'typeText') return 'Проверенный ввод текста';
  if (type === 'pressKey') return 'Клавиши в правильном окне';
  if (type === 'wait') return 'Ожидание только видимой загрузки';
  return type ? `Проверенное действие ${type}` : 'Принцип интерфейса';
}

function normalizedPrinciple(principle) {
  const fallbackName = principleNameFromSignature(principle.signature);
  return {
    ...principle,
    name: clean(principle.name, 120) || fallbackName,
    description: clean(principle.description, 1_200) || clean(principle.statement, 1_200),
    statement: clean(principle.description, 1_200) || clean(principle.statement, 1_200)
  };
}

async function readJson(filePath, fallback) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function applyFeedback(store, record) {
  const signature = actionSignature(record);
  let principle = store.principles.find((item) => item.signature === signature);
  if (!principle) {
    principle = {
      principleId: `ui:${signature}`,
      signature,
      name: principleName(record),
      description: principleStatement(record),
      statement: principleStatement(record),
      positive: 0,
      negative: 0,
      applications: [],
      createdAt: record.createdAt || new Date().toISOString(),
      updatedAt: record.createdAt || new Date().toISOString()
    };
    store.principles.push(principle);
  }
  if (record.rating === 'positive') principle.positive += 1;
  else if (record.rating === 'negative') principle.negative += 1;
  const processName = clean(record.application?.processName, 128);
  if (processName && !principle.applications.includes(processName)) principle.applications.push(processName);
  principle.applications = principle.applications.slice(-20);
  principle.updatedAt = record.createdAt || new Date().toISOString();
  return principle;
}

async function writeStore(filePath, store) {
  store.updatedAt = new Date().toISOString();
  store.principles = store.principles.slice(-100);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(store, null, 2), 'utf8');
  await fs.rename(temporary, filePath);
}

function coreStore() {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    updatedAt: now,
    principles: CORE_PRINCIPLES.map((item) => ({
      ...item,
      statement: item.description,
      positive: 0,
      negative: 0,
      applications: [],
      source: 'jarvis_core',
      protected: true,
      createdAt: now,
      updatedAt: now
    }))
  };
}

export async function resetPrinciplesToCore(filePath, { backupDirectory = null } = {}) {
  let backupPath = null;
  if (backupDirectory) {
    try {
      await fs.access(filePath);
      await fs.mkdir(backupDirectory, { recursive: true });
      backupPath = path.join(backupDirectory, `principles-${Date.now()}.json`);
      await fs.copyFile(filePath, backupPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const store = coreStore();
  await writeStore(filePath, store);
  return { ...store, backupPath };
}

export async function ensureCorePrinciples(filePath) {
  const store = await readJson(filePath, { schemaVersion: 2, updatedAt: null, principles: [] });
  const existingCoreIds = new Set((store.principles || []).filter((item) => item.source === 'jarvis_core').map((item) => item.principleId));
  if (CORE_PRINCIPLES.every((item) => existingCoreIds.has(item.principleId))) return store;
  return resetPrinciplesToCore(filePath);
}

export async function createPrinciple(filePath, { name, description, applications = [], source = 'user' }) {
  const cleanName = clean(name, 120);
  const cleanDescription = clean(description, 1_200);
  if (!cleanName || !cleanDescription) throw new TypeError('name and description are required.');
  const store = await readJson(filePath, { schemaVersion: 1, updatedAt: null, principles: [] });
  const signature = `manual:${cleanName.toLowerCase()}`;
  const existing = store.principles.find((item) => item.signature === signature);
  if (existing) {
    existing.description = cleanDescription;
    existing.statement = cleanDescription;
    existing.updatedAt = new Date().toISOString();
    existing.source = source;
    existing.applications = [...new Set([...(existing.applications || []), ...applications.map((item) => clean(item, 128)).filter(Boolean)])].slice(-20);
    await writeStore(filePath, store);
    return { store, principle: normalizedPrinciple(existing), created: false };
  }
  const principle = {
    principleId: `teacher:${randomUUID()}`,
    signature,
    name: cleanName,
    description: cleanDescription,
    statement: cleanDescription,
    positive: 0,
    negative: 0,
    applications: applications.map((item) => clean(item, 128)).filter(Boolean).slice(-20),
    source,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  store.principles.push(principle);
  await writeStore(filePath, store);
  return { store, principle: normalizedPrinciple(principle), created: true };
}

export async function updatePrinciple(filePath, { principleId, name, description }) {
  const store = await readJson(filePath, { schemaVersion: 1, updatedAt: null, principles: [] });
  const principle = store.principles.find((item) => item.principleId === principleId);
  if (!principle) {
    const error = new Error('Principle was not found.');
    error.code = 'principle_not_found';
    throw error;
  }
  if (principle.protected) {
    const error = new Error('Core JARVIS principles are protected. Personal preferences belong in learned experience.');
    error.code = 'protected_principle';
    throw error;
  }
  const cleanName = clean(name, 120);
  const cleanDescription = clean(description, 1_200);
  if (!cleanName || !cleanDescription) throw new TypeError('name and description are required.');
  principle.name = cleanName;
  principle.description = cleanDescription;
  principle.statement = cleanDescription;
  principle.updatedAt = new Date().toISOString();
  principle.editedByUser = true;
  await writeStore(filePath, store);
  return { store, principle: normalizedPrinciple(principle) };
}

export async function deletePrinciple(filePath, principleId) {
  const store = await readJson(filePath, { schemaVersion: 1, updatedAt: null, principles: [] });
  const index = store.principles.findIndex((item) => item.principleId === principleId);
  if (index < 0) {
    const error = new Error('Principle was not found.');
    error.code = 'principle_not_found';
    throw error;
  }
  if (store.principles[index].protected) {
    const error = new Error('Core JARVIS principles cannot be deleted individually.');
    error.code = 'protected_principle';
    throw error;
  }
  const [deleted] = store.principles.splice(index, 1);
  await writeStore(filePath, store);
  return { store, deleted: normalizedPrinciple(deleted) };
}

export async function updatePrinciplesFromFeedback(filePath, record) {
  const store = await readJson(filePath, { schemaVersion: 1, updatedAt: null, principles: [] });
  const principle = applyFeedback(store, record);
  await writeStore(filePath, store);
  return { store, principle };
}

export async function ensurePrinciplesFromEpisodes(filePath, episodesPath) {
  const existing = await readJson(filePath, { schemaVersion: 1, updatedAt: null, principles: [] });
  if (existing.principles.length) return { store: existing, imported: 0 };
  let contents = '';
  try { contents = await fs.readFile(episodesPath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { store: existing, imported: 0 };
    throw error;
  }
  const records = contents.split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter((record) => record?.step?.action?.type && ['positive', 'negative'].includes(record.rating));
  for (const record of records) applyFeedback(existing, record);
  if (records.length) await writeStore(filePath, existing);
  return { store: existing, imported: records.length };
}

export async function readPrinciples(filePath, { limit = 8 } = {}) {
  const store = await readJson(filePath, { schemaVersion: 1, updatedAt: null, principles: [] });
  return {
    ...store,
    principles: (store.principles || [])
      .map(normalizedPrinciple)
      .slice()
      .sort((left, right) => (right.positive + right.negative) - (left.positive + left.negative))
      .slice(0, Math.max(1, Math.min(Number(limit) || 8, 100)))
  };
}

export function principlesForPrompt(principles, maxChars = 1_200) {
  if (!Array.isArray(principles) || principles.length === 0) return '';
  const items = [];
  const prefix = '\nДолговременные универсальные принципы, накопленные независимо от текущей модели: ';
  const suffix = '\nЭто правила выбора и проверки действия, а не сохранённые экранные координаты.';
  for (const principle of principles) {
    const candidate = {
      name: principle.name,
      description: principle.description || principle.statement,
      positive: principle.positive,
      negative: principle.negative,
      applicationCount: principle.applications?.length || 0
    };
    if (prefix.length + JSON.stringify([...items, candidate]).length + suffix.length > maxChars) break;
    items.push(candidate);
  }
  return items.length ? `${prefix}${JSON.stringify(items)}${suffix}` : '';
}
