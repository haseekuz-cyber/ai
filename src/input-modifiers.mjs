const MODIFIER_ORDER = ['Control', 'Shift', 'Alt'];
const allowedModifiers = new Set(MODIFIER_ORDER);

export function normalizeInputModifiers(input, { label = 'modifiers' } = {}) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new TypeError(`${label} must be an array.`);

  const values = new Set();
  for (const modifier of input) {
    if (typeof modifier !== 'string' || !allowedModifiers.has(modifier)) {
      throw new TypeError(`${label} may contain only Control, Shift, and Alt.`);
    }
    values.add(modifier);
  }
  return MODIFIER_ORDER.filter((modifier) => values.has(modifier));
}

export const INPUT_MODIFIERS = Object.freeze([...MODIFIER_ORDER]);
