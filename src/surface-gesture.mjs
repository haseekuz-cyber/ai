import { normalizeInputModifiers } from './input-modifiers.mjs';

const surfaceWords = /(canvas|artboard|drawing\s*(area|surface)|work\s*area|document\s*page|page\s*area|холст|монтажн\w*\s+област|рабоч\w*\s+област|област\w*\s+рисован|страниц\w*\s+документ)/iu;
const gestureWords = /(draw|create|make|paint|sketch|shape|circle|ellipse|rectangle|line|рис|созда|нарис|фигур|круг|эллипс|прямоуголь|лини)/iu;
const genericSurfaceRoles = /^(canvas|pane|document|custom)$/iu;
const singlePointWords = /(caret|text\s*object|insertion|anchor|place|position|курсор|текстов\w*\s+объект|точк\w*\s+встав|мест\w*\s+встав|размест)/iu;
const textEntryWords = /(type|text|write|enter|insert|phrase|caption|надпис|текст|фраз|пиш|ввод|ввест|напечат)/iu;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function finitePoint(value, label, bounds = null) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError(`${label} must contain finite coordinates.`);
  }
  if (x >= 0 && x <= 1 && y >= 0 && y <= 1) return { x, y };
  const width = Number(bounds?.width);
  const height = Number(bounds?.height);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 1 && height > 1 &&
      x >= 0 && x < width && y >= 0 && y < height) {
    return { x: x / (width - 1), y: y / (height - 1) };
  }
  throw new TypeError(`${label} must use normalized coordinates or pixels inside the screenshot.`);
}

export function isSurfaceGestureCandidate({ instruction = '', proposal = null } = {}) {
  if (!['click', 'doubleClick'].includes(proposal?.action?.type)) return false;
  const hint = proposal.action.targetHint || {};
  const targetText = [hint.name, hint.visibleText, hint.automationId, hint.controlType]
    .map(text)
    .filter(Boolean)
    .join(' ');
  const taskText = [instruction, proposal.reason, proposal.expectedResult]
    .map(text)
    .filter(Boolean)
    .join(' ');
  return surfaceWords.test(targetText) && gestureWords.test(taskText);
}

export function isSurfaceClickCandidate({ proposal = null } = {}) {
  if (!['click', 'doubleClick'].includes(proposal?.action?.type)) return false;
  const hint = proposal.action.targetHint || {};
  const targetText = [hint.name, hint.visibleText, hint.automationId, hint.controlType]
    .map(text)
    .filter(Boolean)
    .join(' ');
  if (surfaceWords.test(targetText)) return true;
  const contextText = [proposal.reason, proposal.expectedResult].map(text).filter(Boolean).join(' ');
  return genericSurfaceRoles.test(text(hint.controlType)) &&
    surfaceWords.test(contextText) &&
    singlePointWords.test(contextText);
}

export function isSurfaceTextCandidate({ proposal = null } = {}) {
  if (proposal?.action?.type !== 'typeText') return false;
  const hint = proposal.action.targetHint || {};
  const targetText = [hint.name, hint.visibleText, hint.automationId, hint.controlType]
    .map(text)
    .filter(Boolean)
    .join(' ');
  const contextText = [proposal.reason, proposal.expectedResult]
    .map(text)
    .filter(Boolean)
    .join(' ');
  return (surfaceWords.test(targetText) || genericSurfaceRoles.test(text(hint.controlType))) &&
    textEntryWords.test(`${targetText} ${contextText}`);
}

export function explicitGestureModifiers(instruction = '') {
  const source = text(instruction);
  const modifiers = [];
  if (/(^|\W)(ctrl|control|контрол)(\W|$)/iu.test(source)) modifiers.push('Control');
  if (/(^|\W)(shift|шифт)(\W|$)/iu.test(source)) modifiers.push('Shift');
  if (/(^|\W)(alt|альт)(\W|$)/iu.test(source)) modifiers.push('Alt');
  return normalizeInputModifiers(modifiers, { label: 'surface gesture modifiers' });
}

export function normalizeSurfaceGesture(value, { instruction = '', bounds = null } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Surface gesture result must be an object.');
  }
  const targetVisible = value.targetVisible === true;
  const confidence = Math.min(Math.max(Number(value.confidence) || 0, 0), 1);
  const result = {
    targetVisible,
    confidence,
    evidence: text(value.evidence).slice(0, 500),
    from: null,
    to: null,
    modifiers: explicitGestureModifiers(instruction)
  };
  if (!targetVisible) return result;
  result.from = finitePoint(value.from, 'from', bounds);
  result.to = finitePoint(value.to, 'to', bounds);
  if (Math.hypot(result.to.x - result.from.x, result.to.y - result.from.y) < 0.02) {
    throw new TypeError('Surface gesture must describe a visible non-zero drag.');
  }
  return result;
}

export function normalizeSurfacePoint(value, { bounds = null } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Surface point result must be an object.');
  }
  const targetVisible = value.targetVisible === true;
  const confidence = Math.min(Math.max(Number(value.confidence) || 0, 0), 1);
  return {
    targetVisible,
    confidence,
    evidence: text(value.evidence).slice(0, 500),
    point: targetVisible ? finitePoint(value.point, 'point', bounds) : null
  };
}
