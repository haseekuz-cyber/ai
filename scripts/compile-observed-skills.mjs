import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.mjs';
import { analyzeImagesWithLmStudio } from '../src/lmstudio-client.mjs';
import {
  buildObservationCompilerPrompt,
  extractSubmittedIntents,
  normalizeObservationExperience,
  OBSERVATION_COMPILER_SYSTEM_PROMPT,
  selectObservationKeyframes
} from '../src/experience-compiler.mjs';
import { appendTeacherExperience, normalizeTeacherUpdate } from '../src/teacher-learning.mjs';

async function existing(paths) {
  const result = [];
  for (const filePath of paths) {
    try {
      if ((await fs.stat(filePath)).isFile()) result.push(filePath);
    } catch { }
  }
  return result;
}

async function removePriorLearning(skillId) {
  try {
    const source = await fs.readFile(config.teacherExperiencesPath, 'utf8');
    const lines = source.split(/\r?\n/).filter(Boolean);
    const kept = lines.filter((line) => {
      try { return JSON.parse(line)?.sourceSkillId !== skillId; } catch { return true; }
    });
    if (kept.length === lines.length) return null;
    const backupPath = `${config.teacherExperiencesPath}.before-recompile-${Date.now()}.bak`;
    await fs.copyFile(config.teacherExperiencesPath, backupPath);
    await fs.writeFile(config.teacherExperiencesPath, kept.length ? `${kept.join('\n')}\n` : '', 'utf8');
    return backupPath;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function compileFile(skillPath) {
  const skill = JSON.parse(await fs.readFile(skillPath, 'utf8'));
  const submitted = extractSubmittedIntents(skill.steps);
  const lastSubmittedIndex = submitted.at(-1)?.stepIndex ?? skill.steps?.at(-1)?.index ?? 0;
  const beforePath = submitted[0]?.beforeImagePath || skill.steps?.[0]?.visualEvidence?.beforeImagePath;
  // Historical recordings were stopped by returning to the admin page. Use
  // the latest task evidence at or before the final submitted command and
  // explicitly mark that the actual post-command result is unavailable.
  const afterPath = [...(skill.steps || [])].reverse().find((step) =>
    Number(step.index) <= Number(lastSubmittedIndex) && step.visualEvidence?.afterImagePath)?.visualEvidence?.afterImagePath;
  const imagePaths = await existing(selectObservationKeyframes(skill, {
    beforePath, afterPath, maxImages: 4, resultFrameAfterFinalIntent: false
  }));
  if (imagePaths.length < 2) throw new Error(`Not enough visual evidence in ${skillPath}`);
  const beforeSha256 = '';
  const afterSha256 = '';
  const response = await analyzeImagesWithLmStudio({
    baseUrl: config.lmStudioBaseUrl,
    model: config.teacherModel,
    imagePaths,
    systemPrompt: OBSERVATION_COMPILER_SYSTEM_PROMPT,
    prompt: buildObservationCompilerPrompt({ skill, beforeSha256, afterSha256, resultFrameAfterFinalIntent: false }),
    maxOutputTokens: 2_600,
    timeoutMs: 300_000
  });
  const semanticExperience = normalizeObservationExperience(response.analysis, {
    skill, beforeSha256, afterSha256, resultFrameAfterFinalIntent: false
  });
  semanticExperience.model = response.model;
  semanticExperience.imagePaths = imagePaths;
  semanticExperience.stats = response.stats;
  skill.learningMode = 'passive';
  skill.executionPolicy = {
    replayable: false,
    reason: 'Passive observation must be compiled into causal knowledge; raw coordinates are evidence only.'
  };
  skill.compilationStatus = semanticExperience.understood ? 'compiled_observation' : 'needs_review';
  skill.semanticExperience = semanticExperience;

  const backupPath = `${skillPath}.before-semantic-${Date.now()}.bak`;
  await fs.copyFile(skillPath, backupPath);
  await fs.writeFile(skillPath, JSON.stringify(skill, null, 2), 'utf8');

  const learned = [];
  const learningBackupPath = await removePriorLearning(skill.skillId);
  if (semanticExperience.comparison.resultFrameAfterFinalIntent === true &&
      semanticExperience.understood && semanticExperience.confidence >= 0.55) {
    for (const item of semanticExperience.portableKnowledge) {
      const update = normalizeTeacherUpdate(item, { application: skill.application });
      if (!update) continue;
      update.sourceSkillId = skill.skillId;
      update.createdBy = 'passive-observation-compiler';
      learned.push(await appendTeacherExperience(config.teacherExperiencesPath, update));
    }
  }
  return {
    skillId: skill.skillId,
    skillPath: path.resolve(skillPath),
    backupPath,
    learningBackupPath,
    understood: semanticExperience.understood,
    confidence: semanticExperience.confidence,
    goal: semanticExperience.sessionGoal,
    outcome: semanticExperience.comparison.outcome,
    matchedIntent: semanticExperience.comparison.matchedIntent,
    episodes: semanticExperience.episodes.map((episode) => ({ title: episode.title, success: episode.success })),
    learned: learned.map((item) => item.name),
    model: response.model,
    stats: response.stats
  };
}

const repairOnly = process.argv[2] === '--repair-only';
const skillPaths = process.argv.slice(repairOnly ? 3 : 2);
if (!skillPaths.length) throw new Error('Pass one or more observed skill JSON paths.');
const results = [];
for (const skillPath of skillPaths) {
  if (!repairOnly) {
    results.push(await compileFile(path.resolve(skillPath)));
    continue;
  }
  const resolved = path.resolve(skillPath);
  const skill = JSON.parse(await fs.readFile(resolved, 'utf8'));
  if (skill.semanticExperience?.comparison?.resultFrameAfterFinalIntent === false) {
    skill.semanticExperience.comparison.matchedIntent = 'unclear';
    skill.semanticExperience.comparison.outcome = 'Итог после последней команды не был снят; результат нельзя подтвердить по этой записи.';
    skill.semanticExperience.comparison.evidence = ['Есть доказательства цели и действий, но нет кадра результата после последней отправленной команды.'];
    for (const episode of skill.semanticExperience.episodes || []) episode.success = 'unclear';
    await fs.writeFile(resolved, JSON.stringify(skill, null, 2), 'utf8');
  }
  results.push({ skillId: skill.skillId, repaired: true, outcome: skill.semanticExperience?.comparison?.outcome || null });
}
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
