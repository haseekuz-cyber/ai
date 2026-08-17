# Полный системный аудит AI Workstation — 2026-08-14

## Объём проверки

Проверен весь локальный проект, а не один обработчик ошибки:

- 174 проектных файла без `node_modules`, внешних репозиториев и сгенерированных артефактов;
- 65 модулей в `src`;
- 49 файлов тестов до текущего исправления;
- 35 скриптов и мостов, включая PowerShell и C# recorder;
- browser UI, Controller, Worker, LM Studio client/runtime, UIA, Pointer, наблюдение, демонстрации, навыки, память, JARVIS и self-improvement.

Отдельно загружены и изучены исходники эталонных систем в `D:\AI-Research\gui-agents`:

| Система | Проверенная ревизия | Что сравнивалось |
|---|---:|---|
| Microsoft UFO | `96983c7` | фазовый processor, FSM, UIA+vision, action executor, опыт |
| UI-TARS Desktop | `c2ad42e` | screenshot/model/operator loop, разбор и последовательное выполнение действий |
| Agent-S | `bffdb59` | Worker, reflection, grounding ACI, ограничение истории изображений |
| OSWorld | `091f5ef` | action space, state getters, task-specific result metrics, воспроизводимые оценки |

Также проверена официальная схема OpenAI Computer Use: свежий screenshot, структурированные actions, выполнение harness-ом, новый screenshot и повтор; для собственного harness рекомендуются отдельные метрики числа ходов, времени, восстановления и соблюдения policy.

## Фактический цикл текущей системы

| Стадия | Реализация сейчас | Проверка/доказательство | Главный риск |
|---|---|---|---|
| Цель | mission или causal skill | `worker.mjs`, frontend mission/skill flow | два разных пути исполнения могут расходиться |
| Наблюдение | весь назначенный монитор + UIA + event keyframes | `screen-capture`, `uia-bridge`, `window-observer` | fallback и event stream имеют разные гарантии |
| Состояние UI | список UIA элементов + карта изменений | `interface-state`, `interface-context` | не все canvas-программы дают полезный UIA |
| Planner | Qwen через LM Studio, один шаг + короткое продолжение | `agent-planner`, `mini-plan`, `lmstudio-client` | до нескольких повторных VLM/teacher вызовов на один шаг |
| Grounding | selector/UIA, visual refinement, canvas recovery | `agent-grounding`, `surface-gesture` | несколько независимых порогов могут спорить друг с другом |
| Policy | guided/anarchy/learned gates | `action-policy` | policy нельзя использовать как замену проверке результата |
| Executor | UIA invoke/setValue, затем Pointer fallback | `worker`, `uia-bridge`, `pointer-bridge` | транспортный сбой ранее не всегда был виден UI |
| Validator | UIA value, settling, VLM, crop, visual reference | `event-validation`, `reference-validation` | произвольное task state пока чаще оценивается визуально, а не app-native getter-ом |
| Experience | feedback, episodes, principles, teacher experiences | store-модули и JSONL | неудача не должна автоматически становиться знанием |
| Demonstration | hooks, modifiers, trajectory, before/after frames | `teach-recorder.cs`, `teaching`, `causal-skill` | синхронная запись PNG внутри low-level hook может задержать очень быстрый показ |
| Self-improvement | error packet → proposal → sandbox tests → apply/rollback | teacher/self-improvement modules | пока нет обязательного benchmark old-vs-candidate на живых replay cases |

## Что уже реализовано правильно

- свежий снимок и identity окна проверяются перед физическим действием;
- изменение geometry того же окна отделено от смены process/window/document;
- timeout/no-change не считается доказанным успехом;
- Ctrl/Shift/Alt и траектория drag сохраняются;
- финальный кадр демонстрации хранится как visual reference;
- сохранённый навык имеет отдельный executor, а не обязан заново превращаться в обычную mission;
- есть typed structured output, bounded prompts, отмена LM Studio запросов, event observation и полный shutdown;
- memory update после успеха ожидает пользовательскую оценку.

## Подтверждённые сквозные дефекты и исправления

### P0. Исправление шага не доходило до Worker

Frontend вызывал:

- `/api/skills/apply-plan-correction`;
- `/api/skills/apply-demonstrated-correction`.

Worker реализовывал соответствующие endpoints, но Controller не проксировал их. Поэтому текстовое исправление или мини-демонстрация могли закончиться до обновления причинного навыка.

Исправление: оба маршрута проведены через Controller. Добавлен контрактный тест, который автоматически сравнивает все `/api/*`, используемые browser UI, с маршрутами Controller.

### P0. Сохранённый навык всегда становился stale перед первым действием

`/skills/prepare` создавал run без `windowIdentity`, а `/skills/execute-step` сразу вызывал `sameWindowIdentity(current, run.windowIdentity)`. Сравнение с `undefined` всегда ложно.

Исправление: состояние learned-skill run теперь создаётся одним проверяемым конструктором и обязательно сохраняет отдельный snapshot identity. Geometry может измениться, но смена process/window/document по-прежнему блокируется.

## Архитектурные разрывы, которые нельзя чинить случайным patch-ем

### P1. Worker является монолитным оркестратором

`worker.mjs` содержит маршрутизацию, model orchestration, research, teacher review, grounding recovery, execution, validation, teaching, skills и code self-improvement. В отличие от UFO, границы фаз не являются исполнимым контрактом. Нужен постепенный перенос в отдельные phase services, без большого переписывания сразу:

1. `ObservationPhase`;
2. `DecisionPhase`;
3. `GroundingPhase`;
4. `ExecutionPhase`;
5. `ValidationPhase`;
6. `LearningPhase`.

Каждая фаза должна возвращать типизированный результат с `traceId`, timing, evidence и явным status.

### P1. Слишком много дорогих модельных повторов

Один шаг может вызвать planner, повтор planner после parse/grounding, visual refinement, повтор после failed/successful action, до четырёх teacher reviews, research и validator. Agent-S3 сознательно убирает иерархию для меньшей задержки; UI-TARS исполняет разобранный action batch внутри одного loop.

Правильная оптимизация:

- deterministic/UIA fast path до VLM;
- один planner call для текущего действия и guarded continuation;
- teacher/critic только при конфликте, низкой уверенности, повторе или провале;
- validator сначала deterministic event/state, затем VLM только когда этого недостаточно;
- повтор модели только с новой информацией, а не с тем же кадром и изменённой формулировкой.

### P1. Проверка задачи должна быть сильнее визуального сходства

OSWorld оценивает результат через getters и application-specific metrics. Универсальный продукт не должен содержать CorelDRAW-specific planner code, но может иметь подключаемые валидаторы:

- generic visual/UIA validator по умолчанию;
- app adapter с read-only getter, когда приложение предоставляет automation/API/document state;
- visual-reference comparison для демонстрации;
- пользовательская оценка как последний арбитр, а не как замена измерению.

### P1. Быстрые демонстрации требуют отдельного capture pipeline

Recorder получает реальные mouse/keyboard hooks и сохраняет модификаторы и траекторию. Однако `CaptureVisualEvidence` синхронно делает PNG внутри low-level hook на pointer/key down. На тяжёлом 3840×1080 экране это может задержать hook и ухудшить запись быстрых серий.

Следующее системное изменение должно заменить это на bounded frame ring buffer/отдельный capture worker:

- input hook только ставит timestamped event в очередь;
- screen capture идёт постоянно или событийно вне hook;
- для каждого важного события связываются ближайший кадр до и первый устойчивый кадр после;
- окна/диалоги определяются по foreground/root window на момент события;
- финальный кадр фиксируется после settle, до клика по панели остановки.

Это изменение требует живого latency/replay теста; его нельзя объявлять готовым только по static source.

## Эталон, который берём, и что не копируем

- Из UFO: явные фазы, FSM и fail-fast только для observation/model, но мягкая фиксация ошибок execution/memory.
- Из UI-TARS: компактный operator contract и несколько последовательных действий из одного структурированного ответа.
- Из Agent-S: отдельный grounding model/ACI, optional reflection и ограниченная история кадров.
- Из OSWorld: проверка реального task state и сохранение воспроизводимых trajectories/evaluations.
- Из OpenAI Computer Use: свежий screenshot loop, полный набор actions, координатное remapping и измерение turn/time/recovery.

Не копируем чужую систему целиком: JARVIS должен остаться универсальным Windows harness с обучением по демонстрации, пользовательскими предпочтениями и подключаемыми приложениями.

## Обязательный следующий критерий

Перед новой функцией запускается один эталонный сценарий:

`record -> compile causal graph -> prepare -> execute every step -> validate each step -> compare final reference -> rate -> replay after move/resize`

Готовность навыка: 8–9 успешных повторов из 10, включая перенос окна, сохранение modifiers/trajectory, отсутствие ложного success и рабочую текстовую/демонстрационную коррекцию.

## Проверки после текущего исправления

- полный Node test suite: **209/209 passed**;
- синтаксис JS/MJS: **124 файла, 0 ошибок**;
- синтаксис PowerShell: **21 файл, 0 ошибок**;
- C# recorder: скомпилирован тем же Windows PowerShell 5.1 и теми же assembly references, которые использует рабочий launcher;
- live read-only `/api/status`: Controller и Worker отвечают, UIA, display capture boundary, Pointer, Stop hotkey и LM Studio provider объявлены доступными;
- физическое повторение пользовательского навыка после исправления пока не выполнялось: для него нужен перезапуск текущих процессов и пользовательский эталонный показ. Это остаётся live verification, а не автоматически доказанный результат.

## Источники

- OpenAI Computer Use: https://developers.openai.com/api/docs/guides/tools-computer-use
- Microsoft UFO: https://github.com/microsoft/UFO
- UI-TARS Desktop: https://github.com/bytedance/UI-TARS-desktop
- Agent-S: https://github.com/simular-ai/Agent-S
- OSWorld: https://github.com/xlang-ai/OSWorld
