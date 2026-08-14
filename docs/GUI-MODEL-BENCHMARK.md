# GUI model benchmark

Date: 2026-08-13

This is a read-only grounding benchmark. It does not execute clicks or change the target application.

## Test fixture

- One captured CorelDRAW window.
- Four grounding requests: choose the ellipse tool, locate the ellipse tool explicitly, locate the yellow swatch, and locate the editable canvas.
- The same strict JSON schema and deterministic temperature were used for both models.

## Result

| Model | Correct | Mean latency | Range |
| --- | ---: | ---: | ---: |
| `qwen/qwen3-vl-8b` | 1/4 | 9.33 s | 9.14-9.49 s |
| `gui-owl-1.5-8b-instruct` | 4/4 | 4.66 s | 4.09-5.08 s |

The original four-point benchmark favored GUI-Owl, but a later full-instruction regression on the same CorelDRAW workflow showed that the model could ground a visible point while misunderstanding the Russian task. Therefore this benchmark is useful only for grounding, not for selecting the end-to-end planner.

GUI-Owl emits coordinates on a 0-1000 canvas. `src/gui-model-adapter.mjs` converts those points to the Workstation's normalized 0-1 coordinate space before grounding and execution.

## Runtime configuration

- Default model: `qwen/qwen3-vl-8b`
- Engine: LM Studio / llama.cpp
- Context: 8192
- Parallel requests: 1
- GPU offload: maximum available
- GUI-Owl remains installed as an experimental grounding model and can be selected explicitly with `AI_WORKSTATION_LM_STUDIO_MODEL=gui-owl-1.5-8b-instruct`.

Raw reports:

- `artifacts/benchmarks/qwen3-vl-8b.json`
- `artifacts/benchmarks/gui-owl-1.5-8b-instruct-adapted.json`
