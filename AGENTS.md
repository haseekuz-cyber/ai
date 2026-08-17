# AI Workstation engineering rule

Before changing Worker/JARVIS behavior, do a full-path audit rather than patching only the visible symptom.

Required path:

`goal -> observation -> UI state -> planning -> grounding -> policy -> execution -> validation -> experience -> skill/principle -> teacher -> self-improvement`

For the affected path:

1. Index the whole repository and read callers, callees, configuration, bridges, browser UI and tests.
2. Compare the mechanism with primary implementations or official documentation for current GUI agents.
3. Prove the root cause with a reproducer or failing test before the patch.
4. Make the smallest systemic change that fixes the contract across stages.
5. Run the stage test, cross-stage contract tests and the complete suite.
6. Report what was live-tested, what is structural only and what remains uncertain.
7. Do not publish to GitHub before the user's local verification unless the user explicitly asks to publish now.

An error message disappearing is not success. The requested visible result and its validation must complete.

The detailed process is in `docs/FULL-SYSTEM-AUDIT-PRINCIPLE.md`.
