import assert from 'node:assert/strict';
import test from 'node:test';
import { partitionObservationEvents, selectFinalMeaningfulFrame } from '../src/observation-guidance.mjs';

test('desktop observation separates teacher guidance and controller clicks from reusable actions', () => {
  const result = partitionObservationEvents([
    {
      type: 'typeText', sequence: 1, atMs: 100, processName: 'browser', windowHandle: 10,
      windowName: 'Новая вкладка — Яндекс Браузер',
      text: 'Привет ассистент, сначала нажми Создать документ, потом нажми Enter'
    },
    { type: 'pressKey', sequence: 2, atMs: 200, processName: 'browser', windowHandle: 10, key: 'Enter' },
    {
      type: 'click', sequence: 3, atMs: 500, processName: 'CorelDRW', windowHandle: 20,
      windowName: 'CorelDRAW - Безымянный-1', windowBounds: { x: 1920, y: 0, width: 1920, height: 1080 },
      x: 2100, y: 300, button: 'left'
    },
    {
      type: 'click', sequence: 4, atMs: 900, processName: 'chrome', windowHandle: 30,
      windowName: 'Рабочее место ИИ - Google Chrome', name: 'Завершить наблюдение',
      x: 500, y: 500, button: 'left'
    }
  ]);

  assert.equal(result.guidance.length, 1);
  assert.match(result.guidance[0].text, /Создать документ/);
  assert.deepEqual(result.events.map((event) => event.sequence), [3]);
  assert.equal(result.primaryApplication.processName, 'CorelDRW');
  assert.equal(result.lastMeaningfulSequence, 3);
  assert.equal(result.ignoredEventCount, 3);
});

test('final result frame must be after the useful action and before the controller stop click', () => {
  const frames = [
    { imagePath: 'before.png', atMs: 0, throughSequence: 0 },
    { imagePath: 'result.png', atMs: 700, throughSequence: 3 },
    { imagePath: 'controller.png', atMs: 950, throughSequence: 4 }
  ];
  assert.equal(selectFinalMeaningfulFrame(frames, {
    throughSequence: 3,
    lastMeaningfulAtMs: 500,
    beforeControllerAtMs: 900
  }).imagePath, 'result.png');
  assert.equal(selectFinalMeaningfulFrame([
    frames[0], frames[2]
  ], {
    throughSequence: 3,
    lastMeaningfulAtMs: 500,
    beforeControllerAtMs: 900
  }), null);
});
