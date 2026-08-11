export const SKILL_ROUTER_SYSTEM_PROMPT = `You are the private local skill router for a Windows AI employee.
Choose at most one learned skill that clearly matches the user's requested task and the current application.
Use only a skillId from the supplied candidates. Never propose UI actions and never invent a skill.
Return JSON only:
{"skillId":"candidate UUID or null","confidence":0.0,"reason":"short Russian reason"}`;

export function publicSkillCandidate(skill) {
  return {
    skillId: skill.skillId,
    name: skill.name,
    instruction: skill.instruction,
    application: skill.application?.processName || null,
    stepTypes: Array.isArray(skill.steps) ? skill.steps.map((step) => step.type) : []
  };
}

export function normalizeSkillRecommendation(value, candidates) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Skill recommendation must be an object.');
  const allowed = new Set(candidates.map((skill) => skill.skillId));
  const skillId = typeof value.skillId === 'string' && allowed.has(value.skillId) ? value.skillId : null;
  const confidence = Math.min(Math.max(Number(value.confidence) || 0, 0), 1);
  return {
    skillId: confidence >= 0.55 ? skillId : null,
    confidence,
    reason: typeof value.reason === 'string' ? value.reason.slice(0, 500) : '',
    rejectedUnknownSkill: typeof value.skillId === 'string' && value.skillId.length > 0 && !allowed.has(value.skillId)
  };
}
