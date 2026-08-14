import { createHash } from 'node:crypto';

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical JSON requires a finite JSON number.');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = [];
    for (let index = 0; index < value.length; index += 1) {
      items.push(canonicalJson(value[index]));
    }
    return `[${items.join(',')}]`;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('Canonical JSON accepts only JSON values.');
  }
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(',')}}`;
}

export function logicalStateHash(state) {
  return createHash('sha256').update(canonicalJson(state), 'utf8').digest('hex');
}
