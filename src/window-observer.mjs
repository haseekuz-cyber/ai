import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import readline from 'node:readline';

const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizedCaptureBounds(value) {
  if (!value || typeof value !== 'object') return null;
  const bounds = {
    x: Math.round(Number(value.x)),
    y: Math.round(Number(value.y)),
    width: Math.round(Number(value.width)),
    height: Math.round(Number(value.height))
  };
  return Number.isFinite(bounds.x) && Number.isFinite(bounds.y) &&
    bounds.width > 0 && bounds.height > 0 ? bounds : null;
}

function sameCaptureBounds(left, right) {
  if (!left && !right) return true;
  return Boolean(left && right && left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height);
}

function cellKey(cell) {
  return `${cell.column}:${cell.row}`;
}

export function coalesceChangedCells(cells = [], columns, rows) {
  const width = positiveInteger(columns, 1);
  const height = positiveInteger(rows, 1);
  const remaining = new Map();
  for (const raw of cells) {
    const column = Number(raw?.column);
    const row = Number(raw?.row);
    if (!Number.isInteger(column) || !Number.isInteger(row) || column < 0 || row < 0 || column >= width || row >= height) continue;
    remaining.set(`${column}:${row}`, { column, row });
  }

  const regions = [];
  while (remaining.size > 0) {
    const seed = remaining.values().next().value;
    const queue = [seed];
    remaining.delete(cellKey(seed));
    let minColumn = seed.column;
    let maxColumn = seed.column;
    let minRow = seed.row;
    let maxRow = seed.row;
    let cellCount = 0;
    while (queue.length > 0) {
      const current = queue.shift();
      cellCount += 1;
      minColumn = Math.min(minColumn, current.column);
      maxColumn = Math.max(maxColumn, current.column);
      minRow = Math.min(minRow, current.row);
      maxRow = Math.max(maxRow, current.row);
      for (const [column, row] of [
        [current.column - 1, current.row], [current.column + 1, current.row],
        [current.column, current.row - 1], [current.column, current.row + 1]
      ]) {
        const key = `${column}:${row}`;
        const neighbor = remaining.get(key);
        if (!neighbor) continue;
        remaining.delete(key);
        queue.push(neighbor);
      }
    }
    regions.push({
      x: minColumn / width,
      y: minRow / height,
      width: (maxColumn - minColumn + 1) / width,
      height: (maxRow - minRow + 1) / height,
      cellCount
    });
  }
  return regions.sort((left, right) => right.cellCount - left.cellCount).slice(0, 12);
}

export function createSettlingTracker({
  afterSequence = 0,
  startedAtMs = Date.now(),
  minimumObservationMs = 600,
  stableSamples = 2,
  minimumChangedFraction = 0
} = {}) {
  return {
    afterSequence,
    startedAtMs,
    minimumObservationMs,
    stableSamples,
    minimumChangedFraction,
    changed: false,
    stableStreak: 0,
    frameCount: 0,
    firstChangeSequence: null,
    lastSequence: afterSequence,
    changedCells: new Map(),
    geometryChanged: false
  };
}

export function advanceSettlingTracker(tracker, frame, nowMs = Date.now()) {
  if (!tracker || frame?.type !== 'frame' || Number(frame.sequence) <= tracker.afterSequence) {
    return { done: false, tracker };
  }
  tracker.frameCount += 1;
  tracker.lastSequence = Number(frame.sequence);
  const significant = frame.geometryChanged === true ||
    (frame.changedFromPrevious === true && Number(frame.changedFraction || 0) >= tracker.minimumChangedFraction);
  if (significant) {
    tracker.changed = true;
    tracker.stableStreak = 0;
    tracker.geometryChanged ||= frame.geometryChanged === true;
    tracker.firstChangeSequence ??= Number(frame.sequence);
    for (const cell of frame.changedCells || []) tracker.changedCells.set(cellKey(cell), cell);
  } else if (tracker.changed) {
    tracker.stableStreak += 1;
  }
  const elapsedMs = nowMs - tracker.startedAtMs;
  return {
    done: tracker.changed && tracker.stableStreak >= tracker.stableSamples && elapsedMs >= tracker.minimumObservationMs,
    tracker
  };
}

export function selectTemporalKeyframePaths(frames = [], { limit = 2 } = {}) {
  const maximum = Math.max(1, Math.min(3, positiveInteger(limit, 2)));
  const candidates = [];
  const seen = new Set();
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const filePath = typeof frames[index]?.keyframePath === 'string' ? frames[index].keyframePath.trim() : '';
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    candidates.push({
      index,
      filePath,
      importance: ['critical', 'high', 'normal', 'low'].includes(frames[index]?.importance)
        ? frames[index].importance
        : 'normal'
    });
  }
  if (candidates.length <= maximum) return candidates.reverse().map((item) => item.filePath);

  // Keep the freshest visual state, then prefer the most important recent
  // transitions. This avoids spending VLM context on cursor animation while
  // preserving a frame that explains a modal, large layout change or action.
  const selected = [candidates[0]];
  for (const importance of ['critical', 'high', 'normal', 'low']) {
    for (const candidate of candidates.slice(1)) {
      if (selected.length >= maximum) break;
      if (candidate.importance === importance && !selected.includes(candidate)) selected.push(candidate);
    }
    if (selected.length >= maximum) break;
  }
  return selected.sort((left, right) => left.index - right.index).map((item) => item.filePath);
}

function publicSnapshot(observer) {
  const frame = observer.latestFrame;
  return {
    enabled: true,
    status: observer.status,
    mode: observer.mode,
    intervalMs: observer.currentIntervalMs,
    windowHandle: observer.windowHandle,
    processId: observer.child?.pid ?? null,
    sequence: frame?.sequence ?? 0,
    capturedAt: frame?.capturedAt ?? null,
    bounds: frame?.bounds ?? null,
    signature: frame?.signature ?? null,
    changedFraction: frame?.changedFraction ?? 0,
    importance: frame?.importance ?? null,
    changedRegions: frame ? coalesceChangedCells(frame.changedCells, frame.columns, frame.rows) : [],
    temporalKeyframes: selectTemporalKeyframePaths(observer.keyframes, { limit: 3 }).length,
    framesObserved: observer.framesObserved,
    significantEvents: observer.significantEvents,
    error: observer.error
  };
}

export class WindowEventObserver extends EventEmitter {
  constructor({
    scriptPath,
    intervalMs = 1_200,
    activeIntervalMs = 200,
    columns = 28,
    rows = 16,
    maxBufferedFrames = 120,
    keyframeDirectory = null,
    maxBufferedKeyframes = 12
  } = {}) {
    super();
    if (!scriptPath) throw new TypeError('scriptPath is required.');
    this.scriptPath = scriptPath;
    this.intervalMs = Math.max(250, Math.min(5_000, positiveInteger(intervalMs, 1_200)));
    this.activeIntervalMs = Math.max(100, Math.min(1_000, positiveInteger(activeIntervalMs, 200)));
    this.currentIntervalMs = this.intervalMs;
    this.mode = 'idle';
    this.columns = Math.max(8, Math.min(64, positiveInteger(columns, 28)));
    this.rows = Math.max(6, Math.min(36, positiveInteger(rows, 16)));
    this.maxBufferedFrames = Math.max(20, positiveInteger(maxBufferedFrames, 120));
    this.keyframeDirectory = typeof keyframeDirectory === 'string' && keyframeDirectory.trim()
      ? keyframeDirectory.trim()
      : null;
    this.maxBufferedKeyframes = Math.max(3, Math.min(30, positiveInteger(maxBufferedKeyframes, 12)));
    this.child = null;
    this.windowHandle = null;
    this.captureBounds = null;
    this.latestFrame = null;
    this.frames = [];
    this.keyframes = [];
    this.framesObserved = 0;
    this.significantEvents = 0;
    this.status = 'idle';
    this.error = null;
    this.stopping = false;
  }

  snapshot() {
    return publicSnapshot(this);
  }

  async recentKeyframePaths({ limit = 2 } = {}) {
    const paths = selectTemporalKeyframePaths(this.keyframes, { limit });
    const existing = [];
    for (const filePath of paths) {
      try {
        await fs.access(filePath);
        existing.push(filePath);
      } catch { }
    }
    return existing;
  }

  async ensure(windowHandle, { readyTimeoutMs = 4_000, mode = 'background', captureBounds = null } = {}) {
    if (!Number.isInteger(windowHandle) || windowHandle <= 0) throw new TypeError('windowHandle must be a positive integer.');
    if (!['background', 'active'].includes(mode)) throw new TypeError('mode must be background or active.');
    const desiredIntervalMs = mode === 'active' ? this.activeIntervalMs : this.intervalMs;
    const desiredCaptureBounds = normalizedCaptureBounds(captureBounds);
    if (this.child && this.windowHandle === windowHandle && this.status === 'observing' &&
        this.currentIntervalMs === desiredIntervalMs && sameCaptureBounds(this.captureBounds, desiredCaptureBounds)) {
      if (this.latestFrame) return this.snapshot();
      return this.waitForFirstFrame(readyTimeoutMs);
    }
    const preserveKeyframes = this.windowHandle === windowHandle;
    this.stop({ preserveKeyframes });
    this.mode = mode;
    this.currentIntervalMs = desiredIntervalMs;
    this.windowHandle = windowHandle;
    this.captureBounds = desiredCaptureBounds;
    this.latestFrame = null;
    this.frames = [];
    if (!preserveKeyframes) this.keyframes = [];
    this.framesObserved = 0;
    this.significantEvents = 0;
    this.error = null;
    this.status = 'starting';
    this.stopping = false;
    if (this.keyframeDirectory) await fs.mkdir(this.keyframeDirectory, { recursive: true });
    const childArguments = [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', this.scriptPath,
      '-WindowHandle', String(windowHandle),
      '-ParentProcessId', String(process.pid),
      '-IntervalMs', String(this.currentIntervalMs),
      '-Columns', String(this.columns),
      '-Rows', String(this.rows)
    ];
    if (this.keyframeDirectory) childArguments.push('-KeyframeDirectory', this.keyframeDirectory);
    if (this.captureBounds) {
      childArguments.push(
        '-CaptureX', String(this.captureBounds.x),
        '-CaptureY', String(this.captureBounds.y),
        '-CaptureWidth', String(this.captureBounds.width),
        '-CaptureHeight', String(this.captureBounds.height)
      );
    }
    const child = spawn(powershell, childArguments, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => this.#ingest(line));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) this.error = text.slice(-1_000);
    });
    child.once('error', (error) => {
      this.error = error.message;
      this.status = 'error';
      this.emit('observerError', error);
    });
    child.once('exit', (code) => {
      lines.close();
      if (this.child !== child) {
        this.emit('observerExit', { code, windowHandle });
        return;
      }
      this.child = null;
      if (!this.stopping && this.status !== 'ended') {
        this.status = code === 0 ? 'ended' : 'error';
        if (code !== 0 && !this.error) this.error = `Window observer exited with code ${code}.`;
      }
      this.emit('observerExit', { code, windowHandle });
    });
    return this.waitForFirstFrame(readyTimeoutMs);
  }

  #ingest(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      this.error = 'Window observer returned an invalid event.';
      return;
    }
    if (event.type === 'frame') {
      this.latestFrame = event;
      this.framesObserved += 1;
      if (event.changedFromPrevious) this.significantEvents += 1;
      this.frames.push(event);
      if (this.frames.length > this.maxBufferedFrames) this.frames.splice(0, this.frames.length - this.maxBufferedFrames);
      if (typeof event.keyframePath === 'string' && event.keyframePath.trim()) {
        this.keyframes.push({
          capturedAt: event.capturedAt,
          keyframePath: event.keyframePath.trim(),
          importance: event.importance || 'normal'
        });
        if (this.keyframes.length > this.maxBufferedKeyframes) {
          const removed = this.keyframes.splice(0, this.keyframes.length - this.maxBufferedKeyframes);
          for (const item of removed) void fs.unlink(item.keyframePath).catch(() => {});
        }
      }
      this.status = 'observing';
      this.emit('frame', event);
      return;
    }
    if (event.type === 'error') {
      this.error = event.message || 'Window observer capture failed.';
      this.emit('observerWarning', event);
      return;
    }
    if (event.type === 'ended') {
      this.status = 'ended';
      this.emit('observerEnded', event);
    }
  }

  waitForFirstFrame(timeoutMs = 4_000) {
    if (this.latestFrame) return Promise.resolve(this.snapshot());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Window event observer did not produce its first frame in time.'));
      }, timeoutMs);
      const onFrame = () => { cleanup(); resolve(this.snapshot()); };
      const onError = (error) => { cleanup(); reject(error); };
      const cleanup = () => {
        clearTimeout(timer);
        this.off('frame', onFrame);
        this.off('observerError', onError);
      };
      this.once('frame', onFrame);
      this.once('observerError', onError);
    });
  }

  waitForSettledChange({
    afterSequence = this.latestFrame?.sequence ?? 0,
    minimumObservationMs = 600,
    maxWaitMs = 4_500,
    stableSamples = 2,
    minimumChangedFraction = 0
  } = {}) {
    if (!this.child || this.status !== 'observing') {
      return Promise.reject(new Error('Window event observer is not running.'));
    }
    const startedAtMs = Date.now();
    const tracker = createSettlingTracker({
      afterSequence, startedAtMs, minimumObservationMs, stableSamples, minimumChangedFraction
    });
    const buffered = this.frames.filter((frame) => Number(frame.sequence) > afterSequence);

    return new Promise((resolve) => {
      let finished = false;
      const finish = (reason) => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve({
          changed: tracker.changed,
          stable: reason === 'changed_and_stable',
          reason,
          source: 'event_stream',
          frameCount: tracker.frameCount,
          elapsedMs: Date.now() - startedAtMs,
          stableSamples: tracker.stableStreak,
          afterSequence,
          finalSequence: tracker.lastSequence,
          geometryChanged: tracker.geometryChanged,
          changedRegions: coalesceChangedCells([...tracker.changedCells.values()], this.columns, this.rows)
        });
      };
      const consume = (frame) => {
        const result = advanceSettlingTracker(tracker, frame);
        if (result.done) finish('changed_and_stable');
      };
      const onExit = () => finish(tracker.changed ? 'observer_ended_after_change' : 'observer_ended_without_change');
      const timer = setTimeout(() => finish(tracker.changed ? 'timeout_after_change' : 'timeout_without_change'), maxWaitMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off('frame', consume);
        this.off('observerExit', onExit);
      };
      this.on('frame', consume);
      this.on('observerExit', onExit);
      for (const frame of buffered) {
        consume(frame);
        if (finished) break;
      }
    });
  }

  stop({ preserveKeyframes = false } = {}) {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    if (child) child.kill();
    this.status = 'idle';
    this.mode = 'idle';
    this.currentIntervalMs = this.intervalMs;
    this.windowHandle = null;
    if (!preserveKeyframes) this.keyframes = [];
  }
}
