function clean(value, maxLength = 120) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, maxLength) : '';
}

function normalizedCenter(bounds, windowBounds) {
  if (!bounds || bounds.empty || bounds.width <= 0 || bounds.height <= 0 || !windowBounds?.width || !windowBounds?.height) return null;
  return {
    x: Math.min(1, Math.max(0, (bounds.x + bounds.width / 2 - windowBounds.x) / windowBounds.width)),
    y: Math.min(1, Math.max(0, (bounds.y + bounds.height / 2 - windowBounds.y) / windowBounds.height))
  };
}

export function buildInterfaceContext(elements, windowBounds, { limit = 80, maxChars = 1_600 } = {}) {
  const candidates = (Array.isArray(elements) ? elements : [])
    .filter((element) => element && !element.offscreen && element.enabled !== false && !element.isPassword)
    .map((element) => {
      const capabilities = Array.isArray(element.capabilities) ? element.capabilities.map((item) => clean(item, 32)).filter(Boolean) : [];
      const name = clean(element.name);
      const automationId = clean(element.automationId, 80);
      const controlType = clean(element.controlType, 48);
      const center = normalizedCenter(element.bounds, windowBounds);
      const score = (capabilities.length ? 8 : 0) + (automationId ? 4 : 0) + (name ? 3 : 0) + (center ? 1 : 0);
      return { name, automationId, controlType, capabilities, center, score };
    })
    .filter((item) => item.score >= 4 && (item.name || item.automationId))
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, Math.min(Number(limit) || 80, 120)))
    .map(({ score, ...item }) => item);
  if (!candidates.length) return '';
  const prefix = '\nСтруктурная карта доступного интерфейса (центр в координатах 0..1): ';
  const suffix = '\nСначала ищи цель по роли, имени и automationId в этой карте. Изображение используй для проверки текущего состояния, нестандартных холстов и элементов, которых нет в карте.';
  const selected = [];
  for (const candidate of candidates) {
    const next = [...selected, candidate];
    if (prefix.length + JSON.stringify(next).length + suffix.length > maxChars) break;
    selected.push(candidate);
  }
  return selected.length ? `${prefix}${JSON.stringify(selected)}${suffix}` : '';
}
