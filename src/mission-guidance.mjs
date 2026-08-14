export function addMissionGuidance(mission, correction, createdAt = new Date().toISOString()) {
  if (!mission || !Array.isArray(mission.guidance)) throw new TypeError('Mission guidance is unavailable.');
  const afterStep = mission.stepCount;
  const previous = mission.guidance.at(-1);
  if (previous?.correction === correction && previous?.afterStep === afterStep) {
    return { saved: false, duplicate: true, entry: previous };
  }
  const entry = { correction, createdAt, afterStep };
  mission.guidance.push(entry);
  mission.guidance = mission.guidance.slice(-12);
  return { saved: true, duplicate: false, entry };
}
