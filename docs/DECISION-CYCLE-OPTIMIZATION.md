# Decision cycle optimization

## Current latency budget

The ranges below are engineering estimates for the local Qwen3-VL 8B runtime on the current workstation. Actual timings are returned by LM Studio and vary with image complexity and context size.

| Stage | Typical time before | Critical path after optimization | Qwen calls after |
|---|---:|---|---:|
| UIA inspection and fresh planning screenshot | 0.4-1.5 s | Always | 0 |
| Load feedback, skills, principles, teacher memory | 0.02-0.20 s | Always, reads run in parallel | 0 |
| Choose one next action | 4-7 s | Always | 1 |
| Ground against UIA | under 0.1 s | Always | 0 |
| Visual target refinement | 3-6 s | Only when semantic UIA grounding is unavailable | 0 or 1 |
| JARVIS pre-action review | 4-7 s | Only for ambiguous, recovered, autonomous, visual, external, or lower-confidence actions | 0 or more |
| Human confirmation | unbounded | Guided mode only | 0 |
| Freshness check and pre-action screenshot | 0.3-1.2 s | Always | 0 |
| Physical action | 0.1-1.0 s | Always | 0 |
| Adaptive settling | 0.4-5.0 s | Always; timeout/no-change fails closed | 0 |
| Visual result validation | 4-7 s | Always | 1 |
| Focused click validation | 3-6 s | Only after a negative full-window click validation | 0 or 1 |
| Generalize experience | 4-7 s | Merged into the mandatory validator response | 0 |

Observed audit baseline before this change: 139 executions averaged 10.9 s from authorization to the final response. Successful executions averaged 11.5 s. This excludes planning and user confirmation.

## Routing rules

Normal deterministic fast path uses two model calls per executed step:

1. Planner chooses one action from the fresh screenshot.
2. Validator checks the fresh result and may return one portable learning candidate.

JARVIS review is skipped only when all conditions hold:

- guided mission;
- click, double-click, or text input;
- local/reversible risk and a non-external application;
- planner confidence at least 0.90;
- exactly one semantic UIA target, with grounding confidence at least 0.80 for clicks;
- no visual refinement, recovery, recent failed step, or human correction.

Every other proposal keeps the JARVIS review. Drag, canvas work, autonomous experiments, external applications, recovered targets, low confidence, and corrected/failed missions never use the fast path.

Set `AI_WORKSTATION_TEACHER_FAST_PATH=false` before starting the worker to restore mandatory JARVIS review for every proposal without reverting code.

## Reliability invariants

- Planner always uses a fresh screenshot.
- Grounding remains fail-closed.
- Window/document identity and visible content are rechecked immediately before execution.
- The executor remains deterministic and performs exactly one approved action.
- Every physical action keeps post-action settling and visual validation.
- A non-wait action with no visible change is never successful.
- Focused crop validation remains a conditional second opinion after a negative click result.
- Learning is saved only when validation succeeded and the candidate passes the existing generalization filter.

## Guarded mini-plans

The planner may return the current action plus at most two `nextActions`. Only deterministic `click`, `doubleClick`, and `typeText` follow-ups can enter the queue. Every queued step must already be visible, carry a unique semantic target, use local/reversible risk, have confidence at least 0.90, and define a precondition and expected result.

After each executed action the normal visual validator still runs. On the next step Worker captures fresh state and rebinds the queued action to the same `automationId` or exact semantic target without calling Planner Qwen. A missing, ambiguous, changed, external, visually grounded, corrected, or failed target discards the complete remainder and returns to normal fresh planning.

Canvas gestures, drag, scroll, dialogs, navigation changes, external applications, and visual checkpoints deliberately end the mini-plan. The first implementation therefore reduces planner calls for stable toolbars and forms without allowing a cached chain to continue through visually uncertain state.

Set `AI_WORKSTATION_MINI_PLANS=false` before starting Worker to disable this route instantly while keeping the rest of the optimized cycle.
