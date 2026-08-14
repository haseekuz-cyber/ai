import { observationExperienceSearchText } from './experience-compiler.mjs';

function taskTokens(text) {
  return new Set(String(text || '').toLowerCase().match(/[a-zа-яё0-9]{3,}/gi) || []);
}

export function selectRelevantDemonstrations(skills, { instruction = '', processName = '', limit = 1 } = {}) {
  const wanted = taskTokens(instruction);
  const minimumScore = wanted.size >= 4 ? 2 : 1;
  return (Array.isArray(skills) ? skills : [])
    .filter((skill) => String(skill.application?.processName || '').toLowerCase() === String(processName || '').toLowerCase())
    .map((skill) => {
      const known = taskTokens(`${skill.name} ${skill.instruction} ${observationExperienceSearchText(skill)}`);
      const score = [...wanted].filter((token) => known.has(token)).length;
      return { skill, score };
    })
    // A demonstration is evidence for a similar task, not a replacement task.
    // Never inject the newest skill merely because it belongs to the same app.
    .filter(({ score }) => score >= minimumScore)
    .sort((left, right) => right.score - left.score || String(right.skill.createdAt).localeCompare(String(left.skill.createdAt)))
    .slice(0, Math.max(1, Math.min(Number(limit) || 1, 5)))
    .map(({ skill }) => skill);
}
