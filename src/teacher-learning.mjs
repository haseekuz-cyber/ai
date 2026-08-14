import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function clean(value, max = 1_000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export const JARVIS_EXPERIENCE_SYSTEM_PROMPT = `You are JARVIS compiling one completed Windows UI step into reusable knowledge.
Return JSON only:
{
  "learn":true,
  "update":{"type":"technique|preference|lesson","name":"general title","description":"portable knowledge","trigger":"general condition","expectedResult":"general visible check","scope":"universal|selected_application"},
  "reason":"short Russian reason"
}
Set learn=false and update=null when the step demonstrates no new portable technique or human preference.
Never copy the concrete task. Remove literal sizes, entered phrases, document names, object names and coordinates. Describe why the action worked or failed, which modifier or trajectory mattered, and how the result can be verified in other tasks.`;

export function buildJarvisExperiencePrompt({ instruction, action, expectedResult, validation, application }) {
  return JSON.stringify({
    concreteTaskForAnalysisOnly: clean(instruction, 1_200),
    completedAction: action,
    expectedVisibleResult: clean(expectedResult, 600),
    observedValidation: {
      success: validation?.success === true,
      evidence: clean(validation?.evidence, 600),
      confidence: Number(validation?.confidence) || 0
    },
    application: clean(application?.processName, 128)
  });
}

export function normalizeJarvisExperienceResponse(value) {
  if (!value || typeof value !== 'object' || value.learn !== true || !value.update) return null;
  return value.update;
}

export function normalizeTeacherUpdate(value, { application = null, sources = [] } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowedTypes = new Set(['technique', 'preference', 'lesson']);
  const type = allowedTypes.has(value.type) ? value.type : value.type === 'experience' ? 'lesson' : null;
  const name = clean(value.name, 120);
  const description = clean(value.description, 1_200);
  if (!type || !name || !description) return null;
  const scope = value.scope === 'selected_application' && clean(application?.processName, 128)
    ? 'selected_application'
    : 'universal';
  return {
    updateId: randomUUID(),
    type,
    name,
    description,
    trigger: clean(value.trigger, 600),
    expectedResult: clean(value.expectedResult, 600),
    scope,
    application: scope === 'selected_application' ? {
      processName: clean(application?.processName, 128),
      windowName: clean(application?.name, 240)
    } : null,
    sources: Array.isArray(sources) ? sources.slice(0, 6).map((source) => ({
      title: clean(source?.title, 180),
      url: clean(source?.url, 1_000)
    })).filter((source) => source.url) : [],
    createdAt: new Date().toISOString(),
    createdBy: 'jarvis',
    verifiedByUser: false
  };
}

function words(value) {
  const stop = new Set(['когда', 'если', 'тогда', 'чтобы', 'этот', 'эта', 'это', 'нужно', 'надо', 'пользователь', 'должен', 'должна', 'сделать', 'создать', 'через', 'после', 'перед']);
  return new Set(clean(value, 4_000).toLowerCase().match(/[a-zа-яё]{4,}/gi)?.filter((word) => !stop.has(word)) || []);
}

export function isGeneralizedTeacherUpdate(update, { userMessage = '', currentTask = '' } = {}) {
  if (!update || !['technique', 'preference', 'lesson'].includes(update.type)) return false;
  const candidateText = `${update.name} ${update.description} ${update.trigger} ${update.expectedResult}`.toLowerCase();
  const taskText = `${userMessage} ${currentTask}`.toLowerCase();
  if (candidateText.length < 24) return false;
  const taskSpecific = [
    ...(taskText.match(/\d+(?:[.,]\d+)?\s*(?:мм|см|м|px|пиксел(?:ь|я|ей)?|%)/gi) || []),
    ...(taskText.match(/[«“\"]([^»”\"]{3,})[»”\"]/g) || [])
  ];
  if (taskSpecific.some((fragment) => candidateText.includes(fragment.toLowerCase()))) return false;
  const taskWords = words(taskText);
  const candidateWords = words(candidateText);
  if (taskWords.size >= 3) {
    const overlap = [...candidateWords].filter((word) => taskWords.has(word)).length;
    if (overlap / Math.max(1, Math.min(taskWords.size, candidateWords.size)) > 0.72) return false;
  }
  return true;
}

export async function appendTeacherExperience(filePath, experience) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    const recent = (await fs.readFile(filePath, 'utf8')).split(/\r?\n/).filter(Boolean).slice(-200).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    const key = `${experience.type}|${experience.scope}|${experience.name.toLowerCase()}|${experience.description.toLowerCase()}`;
    const duplicate = recent.find((item) =>
      `${item.type}|${item.scope}|${String(item.name || '').toLowerCase()}|${String(item.description || '').toLowerCase()}` === key);
    if (duplicate) return duplicate;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.appendFile(filePath, `${JSON.stringify(experience)}\n`, 'utf8');
  return experience;
}

export async function resetTeacherExperiences(filePath, { backupDirectory = null } = {}) {
  let backupPath = null;
  try {
    await fs.access(filePath);
    if (backupDirectory) {
      await fs.mkdir(backupDirectory, { recursive: true });
      backupPath = path.join(backupDirectory, `teacher-experiences-${Date.now()}.jsonl`);
      await fs.copyFile(filePath, backupPath);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, '', 'utf8');
  return { reset: true, backupPath };
}

export async function readTeacherExperiences(filePath, { processName = '', limit = 20 } = {}) {
  try {
    const records = (await fs.readFile(filePath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    return records.filter((item) => item.scope === 'universal' ||
      (processName && item.application?.processName?.toLowerCase() === processName.toLowerCase()))
      .slice(-Math.max(1, Math.min(Number(limit) || 20, 100)));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function teacherExperiencesForPrompt(experiences, maxChars = 1_500) {
  if (!Array.isArray(experiences) || experiences.length === 0) return '';
  const prefix = '\nОбобщённые приёмы и предпочтения, накопленные JARVIS: ';
  const suffix = '\nИспользуй их как условия и критерии, но сверяй каждый шаг со свежим экраном. Они не являются сохранёнными координатами.';
  const compact = [];
  for (const item of experiences) {
    const candidate = {
      type: item.type,
      name: item.name,
      description: item.description,
      trigger: item.trigger,
      expectedResult: item.expectedResult,
      scope: item.scope
    };
    if (prefix.length + JSON.stringify([...compact, candidate]).length + suffix.length > maxChars) break;
    compact.push(candidate);
  }
  return compact.length ? `${prefix}${JSON.stringify(compact)}${suffix}` : '';
}
