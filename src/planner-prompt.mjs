export const MAX_LOCAL_PROMPT_CHARS = 3_900;

export function buildBoundedPlannerPrompt({ instruction, directive, contextParts = [], maxChars = MAX_LOCAL_PROMPT_CHARS }) {
  const prefix = `Задача пользователя: ${String(instruction || '').trim()}`;
  const suffix = `\n${String(directive || '').trim()}\nYou may include up to two guarded nextActions only when they target currently visible, unique semantic UI controls and remain valid after the preceding step. Omit nextActions at any visual checkpoint or uncertainty.`;
  if (prefix.length + suffix.length > maxChars) {
    throw new TypeError('The task and required planning instruction exceed the local prompt budget.');
  }
  let prompt = prefix;
  const contextBudget = maxChars - suffix.length;
  for (const part of contextParts) {
    if (typeof part !== 'string' || !part) continue;
    if (prompt.length + part.length <= contextBudget) prompt += part;
  }
  return prompt + suffix;
}
