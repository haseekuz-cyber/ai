import fs from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, logicalStateHash } from './canonical-json.mjs';
import { createSessionEvent, validateSessionEvent } from './session-events.mjs';
import { reduceSessionEvent } from './session-reducer.mjs';

function sessionError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function validateSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new TypeError('sessionId must contain only letters, digits, underscore or hyphen.');
  }
  return sessionId;
}

export class SessionStore {
  constructor({ directory, snapshotEvery = 100 } = {}) {
    if (typeof directory !== 'string' || !directory) throw new TypeError('SessionStore directory is required.');
    if (!Number.isSafeInteger(snapshotEvery) || snapshotEvery < 1) {
      throw new TypeError('snapshotEvery must be a positive safe integer.');
    }
    this.directory = path.resolve(directory);
    this.snapshotEvery = snapshotEvery;
    this.cache = new Map();
    this.tails = new Map();
  }

  #paths(sessionId) {
    const safeId = validateSessionId(sessionId);
    const sessionDirectory = path.join(this.directory, safeId);
    return {
      sessionDirectory,
      eventsPath: path.join(sessionDirectory, 'events.jsonl'),
      snapshotsDirectory: path.join(sessionDirectory, 'snapshots')
    };
  }

  #serialize(sessionId, operation) {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.tails.set(sessionId, current.then(() => undefined, () => undefined));
    return current;
  }

  async start({ sessionId, goal, mode, surface, pendingCriteria = [], versions = {} } = {}) {
    return this.#serialize(sessionId, async () => {
      const paths = this.#paths(sessionId);
      await fs.mkdir(paths.sessionDirectory, { recursive: true });
      const draft = createSessionEvent({
        sessionId,
        sequence: 1,
        type: 'session.started',
        payload: { goal, mode, surface: surface ?? null, pendingCriteria, versions },
        stateHash: '0'.repeat(64)
      });
      const state = reduceSessionEvent(null, draft);
      const event = createSessionEvent({ ...draft, stateHash: logicalStateHash(state) });
      try {
        await fs.writeFile(paths.eventsPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'wx' });
      } catch (error) {
        if (error.code === 'EEXIST') throw sessionError('session_exists', `Session ${sessionId} already exists.`, error);
        throw error;
      }
      const record = { state, events: [event] };
      this.cache.set(sessionId, record);
      if (this.snapshotEvery === 1) await this.#writeSnapshot(paths, state);
      return { event, state };
    });
  }

  async append(sessionId, draftEvent = {}) {
    return this.#serialize(sessionId, async () => {
      const paths = this.#paths(sessionId);
      const current = this.cache.get(sessionId) ?? await this.#loadFromDisk(sessionId);
      const sequence = current.state.lastEventSequence + 1;
      const provisional = createSessionEvent({
        ...draftEvent,
        sessionId,
        sequence,
        stateHash: '0'.repeat(64)
      });
      const state = reduceSessionEvent(current.state, provisional);
      const event = createSessionEvent({ ...provisional, stateHash: logicalStateHash(state) });
      await fs.appendFile(paths.eventsPath, `${JSON.stringify(event)}\n`, 'utf8');
      const record = { state, events: [...current.events, event] };
      this.cache.set(sessionId, record);
      if (sequence % this.snapshotEvery === 0) await this.#writeSnapshot(paths, state);
      return { event, state };
    });
  }

  async load(sessionId) {
    return this.#serialize(sessionId, async () => this.#loadFromDisk(sessionId));
  }

  async #writeSnapshot(paths, state) {
    await fs.mkdir(paths.snapshotsDirectory, { recursive: true });
    const stateHash = logicalStateHash(state);
    const snapshot = {
      schemaVersion: 1,
      sessionId: state.sessionId,
      sequence: state.lastEventSequence,
      state,
      stateHash
    };
    const target = path.join(paths.snapshotsDirectory, `${snapshot.sequence}.json`);
    const temporary = `${target}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(snapshot)}\n`, 'utf8');
    await fs.rename(temporary, target);
  }

  async #readSnapshots(paths, sessionId) {
    let names;
    try {
      names = await fs.readdir(paths.snapshotsDirectory);
    } catch (error) {
      if (error.code === 'ENOENT') return new Map();
      throw error;
    }
    const snapshots = new Map();
    for (const name of names.filter((value) => /^\d+\.json$/.test(value))) {
      let snapshot;
      try {
        snapshot = JSON.parse(await fs.readFile(path.join(paths.snapshotsDirectory, name), 'utf8'));
      } catch (error) {
        throw sessionError('session_corrupt', `Session ${sessionId} snapshot contains invalid JSON.`, error);
      }
      if (snapshot?.schemaVersion !== 1 || snapshot.sessionId !== sessionId ||
          !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 1 ||
          snapshot.stateHash !== logicalStateHash(snapshot.state) ||
          snapshot.state?.lastEventSequence !== snapshot.sequence) {
        throw sessionError('session_corrupt', `Session ${sessionId} snapshot stateHash is invalid.`);
      }
      snapshots.set(snapshot.sequence, snapshot);
    }
    return snapshots;
  }

  async #loadFromDisk(sessionId) {
    const paths = this.#paths(sessionId);
    let body;
    try {
      body = await fs.readFile(paths.eventsPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') throw sessionError('session_not_found', `Session ${sessionId} was not found.`, error);
      throw error;
    }
    if (!body.endsWith('\n')) {
      throw sessionError('session_corrupt', `Session ${sessionId} has a truncated final event.`);
    }
    const snapshots = await this.#readSnapshots(paths, sessionId);
    const lines = body.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) throw sessionError('session_corrupt', `Session ${sessionId} has no events.`);

    const events = [];
    let state = null;
    let previousSequence = 0;
    try {
      for (const line of lines) {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          throw sessionError('session_corrupt', `Session ${sessionId} event contains invalid JSON.`, error);
        }
        const event = validateSessionEvent(parsed, previousSequence);
        if (event.sessionId !== sessionId) {
          throw new Error(`Event belongs to session ${event.sessionId}.`);
        }
        state = reduceSessionEvent(state, event);
        const actualHash = logicalStateHash(state);
        if (event.stateHash !== actualHash) {
          throw new Error(`stateHash mismatch at sequence ${event.sequence}.`);
        }
        const snapshot = snapshots.get(event.sequence);
        if (snapshot && (snapshot.stateHash !== actualHash || canonicalJson(snapshot.state) !== canonicalJson(state))) {
          throw new Error(`snapshot mismatch at sequence ${event.sequence}.`);
        }
        events.push(event);
        previousSequence = event.sequence;
      }
      for (const sequence of snapshots.keys()) {
        if (sequence > previousSequence || !events.some((event) => event.sequence === sequence)) {
          throw new Error(`orphan snapshot at sequence ${sequence}.`);
        }
      }
    } catch (error) {
      if (error.code === 'session_corrupt') throw error;
      throw sessionError('session_corrupt', `Session ${sessionId} is corrupt: ${error.message}`, error);
    }

    const record = { state, events };
    this.cache.set(sessionId, record);
    return record;
  }
}
