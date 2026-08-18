const CODE_CATEGORIES = new Set(['infrastructure', 'model_protocol', 'executor', 'state_change']);

export function routeIntervention(packet, evidence = {}) {
  if (!packet?.category) throw new TypeError('A normalized ErrorPacket is required.');
  const occurrences = Math.max(1, Number(evidence.occurrences) || 1);
  const verifiedExamples = Math.max(0, Number(evidence.verifiedExamples) || 0);
  const distinctApplications = Math.max(1, Number(evidence.distinctApplications) || 1);
  const userCorrection = evidence.userCorrection === true;
  const missingProgramKnowledge = evidence.missingProgramKnowledge === true;

  if (evidence.explicitPreference === true) {
    return { intervention: 'memory', confidence: 1, reason: 'An explicit user preference belongs in model-independent memory.' };
  }
  if (missingProgramKnowledge) {
    return { intervention: 'rag_research', confidence: 0.95, reason: 'The behavior is blocked by missing application knowledge, not a runtime defect.' };
  }
  if (CODE_CATEGORIES.has(packet.category)) {
    return { intervention: 'code', confidence: 0.95, reason: 'A deterministic runtime, protocol, executor, or state-machine failure requires a minimal tested patch.' };
  }
  if (userCorrection && verifiedExamples >= 1) {
    return { intervention: 'training_example', confidence: 0.9, reason: 'A corrected and verified transition is suitable for the curated training set.' };
  }
  if (packet.category === 'grounding' && distinctApplications === 1 && occurrences >= 2) {
    return { intervention: 'skill', confidence: 0.85, reason: 'Repeated app-local grounding needs a verified reusable skill before any weight update.' };
  }
  if (packet.category === 'validation' && distinctApplications > 1 && occurrences >= 3) {
    return { intervention: 'prompt', confidence: 0.8, reason: 'The same semantic mistake across applications indicates a planning or validation policy problem.' };
  }
  if (verifiedExamples >= 200 && distinctApplications >= 3) {
    return { intervention: 'qlora_candidate', confidence: 0.7, reason: 'Only a varied, reviewed corpus is large enough to justify an adapter experiment.' };
  }
  return { intervention: 'memory', confidence: 0.6, reason: 'Keep the observation as an unpromoted episode until stronger evidence identifies a durable fix.' };
}
