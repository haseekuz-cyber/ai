import test from 'node:test';
import assert from 'node:assert/strict';
import {
  explicitGestureModifiers,
  isSurfaceClickCandidate,
  isSurfaceGestureCandidate,
  isSurfaceTextCandidate,
  normalizeSurfaceGesture,
  normalizeSurfacePoint
} from '../src/surface-gesture.mjs';

test('recognizes a drawing click aimed at a generic canvas as a recoverable gesture', () => {
  assert.equal(isSurfaceGestureCandidate({
    instruction: 'Нарисуй идеальный круг с CTRL',
    proposal: {
      action: { type: 'click', targetHint: { name: 'Canvas' } },
      reason: 'Создать круг на рабочей области',
      expectedResult: 'Круг появится на холсте'
    }
  }), true);
});

test('recognizes a single-point operation on a generic editing surface', () => {
  assert.equal(isSurfaceClickCandidate({
    proposal: { action: { type: 'click', targetHint: { controlType: 'Canvas', name: 'Document canvas' } } }
  }), true);
  assert.deepEqual(normalizeSurfacePoint({
    targetVisible: true,
    point: { x: 0.5, y: 0.55 },
    confidence: 0.88,
    evidence: 'Видна белая страница'
  }), {
    targetVisible: true,
    point: { x: 0.5, y: 0.55 },
    confidence: 0.88,
    evidence: 'Видна белая страница'
  });
});

test('normalizes screenshot-pixel coordinates returned by the surface refiner', () => {
  assert.deepEqual(normalizeSurfacePoint({
    targetVisible: true,
    point: { x: 968, y: 548 },
    confidence: 0.9,
    evidence: 'Visible page'
  }, { bounds: { width: 1936, height: 1096 } }), {
    targetVisible: true,
    point: { x: 968 / 1935, y: 548 / 1095 },
    confidence: 0.9,
    evidence: 'Visible page'
  });
});

test('accepts a generic pane only for an explicit single-point surface operation', () => {
  assert.equal(isSurfaceClickCandidate({ proposal: {
    action: { type: 'click', targetHint: { controlType: 'Pane' } },
    reason: 'Разместить текстовый объект на холсте',
    expectedResult: 'Появится точка вставки текста'
  } }), true);
  assert.equal(isSurfaceClickCandidate({ proposal: {
    action: { type: 'click', targetHint: { controlType: 'Pane' } },
    reason: 'Выбрать якобы существующий объект на холсте',
    expectedResult: 'Белый прямоугольник будет выделен'
  } }), false);
});

test('does not reinterpret a discrete visible button as a surface gesture', () => {
  assert.equal(isSurfaceGestureCandidate({
    instruction: 'Нарисуй круг',
    proposal: {
      action: { type: 'click', targetHint: { name: 'Ellipse tool' } },
      reason: 'Выбрать инструмент',
      expectedResult: 'Инструмент будет активен'
    }
  }), false);
});

test('recognizes text insertion on an identified custom canvas', () => {
  assert.equal(isSurfaceTextCandidate({ proposal: {
    action: {
      type: 'typeText', text: 'Привет',
      targetHint: { name: 'Document canvas', controlType: 'Canvas' }
    },
    reason: 'Написать фразу новым текстовым объектом',
    expectedResult: 'Текст появится на холсте'
  } }), true);
  assert.equal(isSurfaceTextCandidate({ proposal: {
    action: { type: 'typeText', text: 'Привет', targetHint: { name: 'Имя', controlType: 'Edit' } },
    reason: 'Заполнить поле', expectedResult: 'Поле заполнено'
  } }), false);
});

test('normalizes a recovered drag and carries only explicit modifiers', () => {
  assert.deepEqual(explicitGestureModifiers('Создай фигуру с Ctrl и Shift'), ['Control', 'Shift']);
  assert.deepEqual(normalizeSurfaceGesture({
    targetVisible: true,
    from: { x: 0.35, y: 0.3 },
    to: { x: 0.55, y: 0.6 },
    confidence: 0.91,
    evidence: 'Белая страница видна'
  }, { instruction: 'Нарисуй с CTRL' }), {
    targetVisible: true,
    from: { x: 0.35, y: 0.3 },
    to: { x: 0.55, y: 0.6 },
    confidence: 0.91,
    evidence: 'Белая страница видна',
    modifiers: ['Control']
  });
});

test('normalizes screenshot-pixel drag coordinates returned by the surface refiner', () => {
  const gesture = normalizeSurfaceGesture({
    targetVisible: true,
    from: { x: 700, y: 320 },
    to: { x: 1000, y: 620 },
    confidence: 0.92,
    evidence: 'Visible page'
  }, { instruction: 'Draw a square', bounds: { width: 1936, height: 1096 } });
  assert.deepEqual(gesture.from, { x: 700 / 1935, y: 320 / 1095 });
  assert.deepEqual(gesture.to, { x: 1000 / 1935, y: 620 / 1095 });
});
