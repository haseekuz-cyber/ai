import { timingSafeEqual } from 'node:crypto';

const allowedModes = new Set(['inspect', 'dry-run', 'execute']);

export function isAuthorized(headerValue, expectedToken) {
  if (typeof headerValue !== 'string' || !headerValue.startsWith('Bearer ')) return false;

  const provided = Buffer.from(headerValue.slice(7), 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function normalizeTask(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Task must be an object');
  }

  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) throw new TypeError('Prompt is required');
  if (prompt.length > 2_000) throw new TypeError('Prompt must be 2000 characters or fewer');

  const mode = input.mode ?? 'dry-run';
  if (!allowedModes.has(mode)) throw new TypeError(`Unsupported task mode: ${mode}`);

  return Object.freeze({ prompt, mode });
}

