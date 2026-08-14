import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_TEACHER_PROFILE = Object.freeze({
  schemaVersion: 1,
  name: 'JARVIS',
  mission: 'Самостоятельно доводить универсального цифрового сотрудника до видимого результата: ставить ему следующие цели, проверять каждый шаг, исследовать неизвестные интерфейсы, исправлять план и накапливать переносимые знания.',
  values: 'Работать по свежему экрану и смыслу задачи. Не повторять достигнутый результат. Самостоятельно отвечать на технические вопросы по видимым данным, истории и публичной документации. При неуверенности исследовать, перепланировать или безопасно остановиться с диагнозом — не перекладывать решение на человека. Сохранять только обобщённые приёмы и личные предпочтения, никогда не превращать конкретную команду, размер, фразу или координату в вечный принцип. Проверять видимый результат каждого действия. Сохранять причинно важные модификаторы и траектории. Не выполнять внешние, необратимые или опасные действия без явного разрешения.',
  updatedAt: null
});

function clean(value, maxLength, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, maxLength) || fallback;
}

export function normalizeTeacherProfile(value = {}, current = DEFAULT_TEACHER_PROFILE) {
  const requestedName = clean(value.name, 120, current.name);
  return {
    schemaVersion: 1,
    name: /^qwen\b/i.test(requestedName) ? DEFAULT_TEACHER_PROFILE.name : requestedName,
    mission: clean(value.mission, 1_000, current.mission),
    values: clean(value.values, 2_500, current.values),
    updatedAt: new Date().toISOString()
  };
}

export async function readTeacherProfile(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    const legacy = /^qwen\b/i.test(parsed?.name || '');
    const profile = legacy
      ? normalizeTeacherProfile(DEFAULT_TEACHER_PROFILE, DEFAULT_TEACHER_PROFILE)
      : normalizeTeacherProfile(parsed, DEFAULT_TEACHER_PROFILE);
    profile.updatedAt = !legacy && typeof parsed.updatedAt === 'string' && parsed.updatedAt
      ? parsed.updatedAt
      : null;
    return profile;
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    return { ...DEFAULT_TEACHER_PROFILE };
  }
}

export async function ensureTeacherProfile(filePath) {
  const profile = await readTeacherProfile(filePath);
  return profile.updatedAt ? profile : writeTeacherProfile(filePath, profile);
}

export async function writeTeacherProfile(filePath, input) {
  const current = await readTeacherProfile(filePath);
  const profile = normalizeTeacherProfile(input, current);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(profile, null, 2), 'utf8');
  return profile;
}

export function teacherProfileForPrompt(profile) {
  return {
    name: clean(profile?.name, 120, DEFAULT_TEACHER_PROFILE.name),
    mission: clean(profile?.mission, 1_000, DEFAULT_TEACHER_PROFILE.mission),
    values: clean(profile?.values, 2_500, DEFAULT_TEACHER_PROFILE.values)
  };
}
