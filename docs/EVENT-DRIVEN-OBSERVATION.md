# Event-driven window observation

## Runtime cycle

1. `WindowEventObserver` starts one persistent PowerShell capture process for the selected window.
2. The process captures frames with `PrintWindow` every 1200 ms in the background and temporarily switches to 200 ms around a physical action.
3. A 28 x 16 sampled visual map is compared with the previous frame.
4. JSON events contain the frame signature, geometry, changed cells, changed fraction, and capture time. The first frame and meaningful changed frames also create bounded 960-pixel PNG keyframes.
5. Adjacent changed cells are merged into normalized changed regions. Metadata and at most 12 recent temporal keyframes are retained; older keyframes are removed.
6. A debounced UI Automation refresh updates an in-memory interface map after meaningful background events. During an action it is suppressed because the explicit post-action checkpoint performs the authoritative refresh.
7. Before an action, Worker records the current observer sequence. After the action it waits only for later events until the window changes and becomes stable.
8. At a decision checkpoint Worker supplies Qwen up to two prior temporal keyframes plus the fresh full-resolution frame, in chronological order. Coordinates always belong to the final frame.
9. Worker writes one final PNG keyframe for audit and, when needed, Qwen validation. If the observer is unavailable, the fresh single-frame path remains available as a typed fallback.

## Validation routing

- Exact replacement text in an accessible UI field is verified from the fresh UI Automation value without Qwen.
- A non-wait action with no visual or structural change fails locally without Qwen.
- Canvas work, ambiguous changes, gestures, unexpected states, and visual goals still use Qwen.
- A final learned-skill reference comparison still uses the reference and current keyframes.

The event layer detects change; it does not infer success merely because pixels changed.

## Expected impact

- Stable-change detection normally completes in roughly 0.6-1.2 seconds, depending on application repaint behavior.
- Intermediate PNG writes fall from several files per action to one final keyframe when the event stream is healthy.
- Deterministic field edits and definite no-change failures avoid a validator-model call.
- Workflows dominated by accessible controls should see the largest improvement. Visual canvas workflows still require Qwen checkpoints.

## Limits

- `PrintWindow` support differs between applications and GPU-rendered surfaces.
- Small changes between sample points can be missed; the final full-resolution keyframe and periodic model checkpoints remain authoritative.
- Animations may delay the stable event until timeout.
- The observer watches one selected window at a time.
- UI Automation changes are refreshed after debounced visual events and at decision/validation checkpoints. Native UIA event subscriptions remain a future optimization.

## Configuration and rollback

- `AI_WORKSTATION_EVENT_OBSERVER=0` disables the stream and restores PNG polling.
- `AI_WORKSTATION_EVENT_INTERVAL_MS=250..5000` controls background observation; the default is 1200 ms.
- `AI_WORKSTATION_EVENT_ACTIVE_INTERVAL_MS=100..1000` controls short action-time observation; the default is 200 ms.
- The Stop button cancels in-flight local-model requests and stops this observer before LM Studio is unloaded.
