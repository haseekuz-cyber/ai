function clean(value, max = 2_000) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

function isControllerEvent(event, controllerTitle) {
  const title = clean(event?.windowName, 400).toLocaleLowerCase();
  return Boolean(title && title.includes(clean(controllerTitle, 200).toLocaleLowerCase()));
}

function looksLikeGuidance(event) {
  if (event?.type !== 'typeText' || event.sensitive || !clean(event.text, 4_000)) return false;
  const processName = clean(event.processName, 120).toLocaleLowerCase();
  if (!['browser', 'chrome', 'msedge', 'firefox', 'yandex'].some((name) => processName.includes(name))) return false;
  const text = clean(event.text, 4_000).toLocaleLowerCase();
  if (text.length < 24) return false;
  const directiveMarkers = [
    'ассистент', 'ты должен', 'тебе нужно', 'сначала', 'после', 'потом',
    'нажать', 'нажми', 'создать', 'сделать', 'покажи', 'обрати внимание'
  ];
  return directiveMarkers.filter((marker) => text.includes(marker)).length >= 2;
}

function sameWindow(left, right) {
  if (Number(left?.windowHandle) > 0 && Number(right?.windowHandle) > 0) {
    return Number(left.windowHandle) === Number(right.windowHandle);
  }
  return clean(left?.processName, 120).toLocaleLowerCase() === clean(right?.processName, 120).toLocaleLowerCase();
}

export function partitionObservationEvents(events, { controllerTitle = 'Рабочее место ИИ' } = {}) {
  const ordered = [...(Array.isArray(events) ? events : [])]
    .sort((left, right) => Number(left?.atMs) - Number(right?.atMs));
  const ignoredIndexes = new Set();
  const controllerIndexes = new Set();
  const guidance = [];

  ordered.forEach((event, index) => {
    if (isControllerEvent(event, controllerTitle)) {
      ignoredIndexes.add(index);
      controllerIndexes.add(index);
    }
    if (!looksLikeGuidance(event)) return;
    guidance.push({
      text: clean(event.text, 4_000),
      atMs: Math.max(0, Number(event.atMs) || 0),
      processName: clean(event.processName, 120),
      windowName: clean(event.windowName, 400),
      source: 'typed_during_observation'
    });
    ignoredIndexes.add(index);
    const next = ordered[index + 1];
    if (next?.type === 'pressKey' && clean(next.key, 40).toLocaleLowerCase() === 'enter' &&
        Number(next.atMs) - Number(event.atMs) <= 10_000 && sameWindow(event, next)) {
      ignoredIndexes.add(index + 1);
    }
  });

  const actionEvents = ordered.filter((_, index) => !ignoredIndexes.has(index));
  const meaningful = actionEvents.filter((event) => !['pointerMove', 'keyPreview'].includes(event.type));
  const lastMeaningfulAtMs = Math.max(0, ...meaningful.map((event) => Number(event.atMs) || 0));
  const controllerEventsAfterResult = ordered.filter((event, index) =>
    controllerIndexes.has(index) && Number(event.atMs) >= lastMeaningfulAtMs
  );
  const applicationCounts = new Map();
  for (const event of meaningful) {
    const processName = clean(event.processName, 120);
    if (!processName) continue;
    const current = applicationCounts.get(processName.toLocaleLowerCase()) || {
      processName,
      windowName: clean(event.windowName, 400),
      windowBounds: event.windowBounds || null,
      count: 0
    };
    current.count += 1;
    if (event.windowName) current.windowName = clean(event.windowName, 400);
    if (event.windowBounds) current.windowBounds = event.windowBounds;
    applicationCounts.set(processName.toLocaleLowerCase(), current);
  }
  const observedApplications = [...applicationCounts.values()].sort((left, right) => right.count - left.count);
  return {
    events: actionEvents,
    guidance,
    ignoredEventCount: ignoredIndexes.size,
    observedApplications,
    primaryApplication: observedApplications[0] || null,
    lastMeaningfulSequence: Math.max(0, ...meaningful.map((event) => Number(event.sequence) || 0)),
    lastMeaningfulAtMs,
    firstControllerEventAfterResultAtMs: controllerEventsAfterResult.length
      ? Math.min(...controllerEventsAfterResult.map((event) => Number(event.atMs) || 0))
      : null
  };
}

export function selectFinalMeaningfulFrame(frames, {
  throughSequence,
  lastMeaningfulAtMs = 0,
  beforeControllerAtMs = null
} = {}) {
  const ordered = [...(Array.isArray(frames) ? frames : [])]
    .filter((frame) => typeof frame?.imagePath === 'string')
    .sort((left, right) => Number(left.atMs) - Number(right.atMs));
  const beforeController = Number.isFinite(Number(beforeControllerAtMs))
    ? ordered.filter((frame) => Number(frame.atMs) < Number(beforeControllerAtMs))
    : ordered;
  const candidates = beforeController.filter((frame) => Number(frame.atMs) >= Number(lastMeaningfulAtMs));
  if (Number(throughSequence) > 0) {
    return candidates.find((frame) => Number(frame.throughSequence) >= Number(throughSequence)) || null;
  }
  return candidates.at(-1) || null;
}
