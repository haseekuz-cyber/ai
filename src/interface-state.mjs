function text(value) {
  return typeof value === 'string' ? value : '';
}

function cleanBounds(bounds) {
  if (!bounds || bounds.empty) return null;
  const normalized = {
    x: Number(bounds.x), y: Number(bounds.y),
    width: Number(bounds.width), height: Number(bounds.height)
  };
  return Object.values(normalized).every(Number.isFinite) ? normalized : null;
}

function elementBaseKey(element) {
  if (text(element.runtimeId)) return `runtime:${element.runtimeId}`;
  if (text(element.automationId)) return `automation:${element.controlType || ''}:${element.automationId}`;
  return `semantic:${element.controlType || ''}:${element.className || ''}:${element.name || ''}`;
}

function sanitizeElements(elements = []) {
  const counts = new Map();
  const result = new Map();
  for (const raw of elements) {
    if (!raw || raw.isPassword) continue;
    const base = elementBaseKey(raw);
    const ordinal = counts.get(base) || 0;
    counts.set(base, ordinal + 1);
    const id = ordinal === 0 ? base : `${base}#${ordinal}`;
    result.set(id, {
      id,
      runtimeId: text(raw.runtimeId),
      parentRuntimeId: text(raw.parentRuntimeId),
      automationId: text(raw.automationId),
      name: text(raw.name),
      className: text(raw.className),
      controlType: text(raw.controlType),
      enabled: raw.enabled !== false,
      offscreen: raw.offscreen === true,
      hasKeyboardFocus: raw.hasKeyboardFocus === true,
      value: typeof raw.value === 'string' ? raw.value : null,
      bounds: cleanBounds(raw.bounds),
      capabilities: Array.isArray(raw.capabilities) ? [...raw.capabilities] : []
    });
  }
  return result;
}

function sameBounds(left, right) {
  if (!left || !right) return left === right;
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

function changedProperties(left, right) {
  const fields = ['name', 'value', 'enabled', 'offscreen', 'hasKeyboardFocus'];
  return fields.filter((field) => left[field] !== right[field]);
}

function summary(element) {
  return element ? {
    id: element.id,
    name: element.name,
    automationId: element.automationId,
    controlType: element.controlType,
    bounds: element.bounds
  } : null;
}

export function updateInterfaceState(previous, inspected, { source = 'inspection', now = Date.now() } = {}) {
  const currentElements = sanitizeElements(inspected?.elements);
  const previousElements = previous?.elements instanceof Map ? previous.elements : new Map();
  const added = [];
  const removed = [];
  const moved = [];
  const changed = [];

  for (const [id, element] of currentElements) {
    const before = previousElements.get(id);
    if (!before) {
      added.push(summary(element));
      continue;
    }
    if (!sameBounds(before.bounds, element.bounds)) {
      moved.push({ ...summary(element), fromBounds: before.bounds, toBounds: element.bounds });
    }
    const properties = changedProperties(before, element);
    if (properties.length > 0) changed.push({ ...summary(element), properties });
  }
  for (const [id, element] of previousElements) {
    if (!currentElements.has(id)) removed.push(summary(element));
  }

  const hasChanges = added.length > 0 || removed.length > 0 || moved.length > 0 || changed.length > 0;
  return {
    version: previous ? previous.version + (hasChanges ? 1 : 0) : 1,
    updatedAt: new Date(now).toISOString(),
    source,
    window: inspected?.window ? {
      nativeWindowHandle: inspected.window.nativeWindowHandle,
      processId: inspected.window.processId,
      processName: inspected.window.processName,
      name: inspected.window.name,
      bounds: cleanBounds(inspected.window.bounds)
    } : null,
    elements: currentElements,
    changes: { added, removed, moved, changed },
    hasChanges
  };
}
export function publicInterfaceState(state, limit = 20) {
  if (!state) return { available: false, version: 0, elementCount: 0, changes: null };
  const trim = (items) => items.slice(0, limit);
  return {
    available: true,
    version: state.version,
    updatedAt: state.updatedAt,
    source: state.source,
    window: state.window,
    elementCount: state.elements.size,
    hasChanges: state.hasChanges,
    changes: {
      added: trim(state.changes.added),
      removed: trim(state.changes.removed),
      moved: trim(state.changes.moved),
      changed: trim(state.changes.changed),
      truncated: Object.values(state.changes).some((items) => items.length > limit)
    }
  };
}
