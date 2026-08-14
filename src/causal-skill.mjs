const supportedStepTypes = new Set(['click', 'doubleClick', 'scroll', 'drag', 'typeText', 'pressKey']);

function clean(value, max = 1_000) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

function parseRange(value, stepCount) {
  const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(clean(value, 40));
  if (!match) return [];
  const first = Math.max(0, Number(match[1]));
  const last = Math.min(stepCount - 1, Number(match[2] ?? match[1]));
  if (last < first) return [];
  return Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
}

function evidenceByStep(skill) {
  const result = new Map();
  const count = Array.isArray(skill?.steps) ? skill.steps.length : 0;
  for (const evidence of skill?.semanticExperience?.actionEvidence || []) {
    for (const index of parseRange(evidence?.stepRange, count)) {
      const current = result.get(index);
      // A VLM may label a state-changing action as noise. Preserve the raw
      // action and only use the semantic label as an explanation/ranking hint.
      if (!current || current.importance === 'noise' || evidence.importance === 'causal') {
        result.set(index, evidence);
      }
    }
  }
  return result;
}

function causalRole(step, evidence) {
  if (step?.correctionSource) return 'essential';
  if (['typeText', 'pressKey'].includes(step.type)) return 'essential';
  if (step.type === 'drag' && (step.modifiers?.length || step.trajectory?.length)) return 'essential';
  if (evidence?.importance === 'causal') return 'essential';
  if (evidence?.importance === 'noise') return 'supporting';
  return 'supporting';
}

function nextPreconditionNodeId(index, stepCount) {
  return index + 1 < stepCount ? `precondition:${index + 1}` : 'final-reference';
}

function buildCausalSkillGraph({ causalSteps, goal, initialConditions, visualReference, recoveryVariants }) {
  const nodes = [];
  const stepCount = causalSteps.length;
  for (const step of causalSteps) {
    const index = step.index;
    const nextNodeId = nextPreconditionNodeId(index, stepCount);
    const hasSemanticTarget = Boolean(step.target && typeof step.target === 'object');
    const hasRecordedGeometry = Boolean(step.point || step.from || step.to || step.trajectory?.length);
    nodes.push(
      {
        nodeId: `precondition:${index}`,
        kind: 'precondition',
        stepIndex: index,
        checks: {
          sameApplicationIdentity: true,
          sameDocumentIdentity: true,
          freshObservationRequired: true,
          targetMustBeLocatable: hasSemanticTarget || hasRecordedGeometry,
          initialConditions: index === 0 ? initialConditions : ''
        },
        edges: {
          onSatisfied: `action:${index}`,
          onAlreadyAchieved: nextNodeId,
          onMissing: `recovery:${index}`
        }
      },
      {
        nodeId: `action:${index}`,
        kind: 'action',
        stepIndex: index,
        goal: step.causal?.purpose || goal,
        object: step.target || null,
        locate: {
          strategies: [
            ...(hasSemanticTarget ? ['fresh_uia_semantic_target'] : []),
            ...(hasRecordedGeometry ? ['adaptive_normalized_geometry'] : []),
            ...(step.verification?.demonstratedAfterImagePath ? ['visual_reference'] : [])
          ],
          neverReplayAbsoluteCoordinatesBlindly: true
        },
        requiredModifiers: Array.isArray(step.modifiers) ? step.modifiers : [],
        trajectory: {
          mode: step.trajectoryMode || step.causal?.trajectoryMeaning || 'not_applicable',
          recordedPathAvailable: Array.isArray(step.trajectory) && step.trajectory.length > 0
        },
        edges: {
          onExecuted: `validation:${index}`,
          onError: `recovery:${index}`
        }
      },
      {
        nodeId: `validation:${index}`,
        kind: 'postcondition',
        stepIndex: index,
        expectedResult: step.verification?.expectedResult || step.expectedResult || '',
        demonstratedAfterImagePath: step.verification?.demonstratedAfterImagePath || null,
        edges: {
          onMatched: nextNodeId,
          onMismatch: `recovery:${index}`,
          onUnavailable: `recovery:${index}`
        }
      },
      {
        nodeId: `recovery:${index}`,
        kind: 'recovery',
        stepIndex: index,
        alternatives: Array.isArray(step.recoveryVariants) && step.recoveryVariants.length
          ? step.recoveryVariants
          : (Array.isArray(recoveryVariants) ? recoveryVariants : []),
        edges: {
          onRetry: `precondition:${index}`,
          onCorrected: nextNodeId,
          onUnresolved: 'needs-review'
        }
      }
    );
  }
  nodes.push({
    nodeId: 'final-reference',
    kind: 'final_validation',
    goal,
    visualReference: visualReference || null,
    edges: { onMatched: 'complete', onMismatch: 'needs-review', onUnavailable: 'needs-review' }
  });
  return {
    schemaVersion: 1,
    kind: 'causal_skill_graph',
    entryNodeId: stepCount ? 'precondition:0' : 'final-reference',
    finalNodeId: 'final-reference',
    terminalNodeIds: ['complete', 'needs-review'],
    nodes
  };
}

export function causalReplayReadiness(skill, { minimumConfidence = 0.55 } = {}) {
  const semantic = skill?.semanticExperience;
  const reasons = [];
  if (skill?.learningMode !== 'passive') reasons.push('not_passive_observation');
  if (!semantic || semantic.understood !== true) reasons.push('semantic_intent_not_understood');
  if (!clean(semantic?.sessionGoal)) reasons.push('semantic_goal_missing');
  if (Number(semantic?.confidence) < minimumConfidence) reasons.push('semantic_confidence_too_low');
  if (semantic?.comparison?.resultFrameAfterFinalIntent !== true) reasons.push('final_result_frame_missing');
  if (!['yes', 'partial'].includes(semantic?.comparison?.matchedIntent)) reasons.push('demonstrated_result_not_verified');
  if (!clean(skill?.visualReference?.imagePath)) reasons.push('final_visual_reference_missing');
  if (!Array.isArray(skill?.steps) || skill.steps.length === 0) reasons.push('recorded_steps_missing');
  if ((skill?.steps || []).some((step) => !supportedStepTypes.has(step?.type))) reasons.push('unsupported_recorded_step');
  return { ready: reasons.length === 0, reasons, minimumConfidence };
}

export function compileCausalReplaySkill(skill, options = {}) {
  if (!skill || typeof skill !== 'object') throw new TypeError('skill is required.');
  if (skill.learningMode !== 'passive') return skill;
  const readiness = causalReplayReadiness(skill, options);
  if (!readiness.ready) {
    return {
      ...skill,
      executionPolicy: {
        ...(skill.executionPolicy || {}),
        replayable: false,
        mode: 'causal_adaptive',
        reason: `Observation is not ready for causal replay: ${readiness.reasons.join(', ')}`
      },
      causalReplay: { schemaVersion: 1, ready: false, reasons: readiness.reasons }
    };
  }

  const evidence = evidenceByStep(skill);
  const goal = clean(skill.semanticExperience.sessionGoal, 800);
  const finalResult = clean(
    skill.semanticExperience.comparison?.after || skill.semanticExperience.comparison?.outcome,
    900
  );
  const causalSteps = skill.steps.map((step, index) => {
    const semanticEvidence = evidence.get(index) || null;
    const purpose = clean(semanticEvidence?.purpose, 400) ||
      `Сохранить причинный шаг ${index + 1} показанного способа достижения цели.`;
    return {
      ...step,
      index,
      expectedResult: clean(step.expectedResult, 700) || purpose,
      causal: {
        schemaVersion: 1,
        role: causalRole(step, semanticEvidence),
        purpose,
        semanticImportance: semanticEvidence?.importance || 'unclassified',
        trajectoryMeaning: step.type === 'drag'
          ? (step.trajectoryMode || 'adaptive')
          : 'not_applicable'
      },
      verification: {
        schemaVersion: 1,
        expectedResult: clean(step.expectedResult, 700) || purpose,
        demonstratedAfterImagePath: clean(step.visualEvidence?.afterImagePath, 2_000) || null,
        compareAfterExecution: Boolean(step.visualEvidence?.afterImagePath)
      }
    };
  });
  const initialConditions = clean(skill.semanticExperience.comparison?.before, 700);
  const skillGraph = buildCausalSkillGraph({
    causalSteps,
    goal,
    initialConditions,
    visualReference: skill.visualReference,
    recoveryVariants: skill.recoveryVariants
  });

  return {
    ...skill,
    executionPolicy: {
      ...(skill.executionPolicy || {}),
      replayable: true,
      mode: 'causal_adaptive',
      requiresFreshObservation: true,
      requiresStepValidation: true,
      requiresFinalReferenceValidation: true,
      reason: 'Compiled semantic observation is replayed as an adaptive causal skill, never as a new autonomous mission.'
    },
    causalReplay: {
      schemaVersion: 1,
      ready: true,
      goal,
      initialConditions,
      expectedFinalResult: finalResult,
      sourceStepCount: skill.steps.length,
      executableStepCount: causalSteps.length,
      preservesRecordedOrder: true,
      adaptsToFreshWindowGeometry: true,
      finalReferenceSha256: clean(skill.visualReference?.sha256, 128) || null,
      graphReady: true
    },
    causalSteps,
    skillGraph
  };
}

export function executableSkillSteps(skill) {
  if (skill?.causalReplay?.ready === true && Array.isArray(skill.causalSteps) && skill.causalSteps.length > 0) {
    return skill.causalSteps;
  }
  return Array.isArray(skill?.steps) ? skill.steps : [];
}
