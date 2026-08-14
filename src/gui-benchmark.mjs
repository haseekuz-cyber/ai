function pointInside(point, region) {
  return Number.isFinite(point?.x) && Number.isFinite(point?.y) &&
    point.x >= region.xMin && point.x <= region.xMax &&
    point.y >= region.yMin && point.y <= region.yMax;
}

export const corelGroundingCases = Object.freeze([
  {
    id: 'circle-task-first-step',
    instruction: 'Нарисуй круг и покрась его в жёлтый. Предложи только первый следующий видимый шаг.',
    expectedAction: 'click',
    region: { xMin: 0, xMax: 0.055, yMin: 0.34, yMax: 0.43 },
    expectedTarget: 'инструмент эллипса или круга на левой панели'
  },
  {
    id: 'ellipse-tool-grounding',
    instruction: 'Нажми видимый инструмент эллипса или круга на левой панели. Предложи только этот шаг.',
    expectedAction: 'click',
    region: { xMin: 0, xMax: 0.055, yMin: 0.34, yMax: 0.43 },
    expectedTarget: 'инструмент эллипса или круга на левой панели'
  },
  {
    id: 'yellow-swatch-grounding',
    instruction: 'Нажми видимый жёлтый образец цвета на правой вертикальной палитре. Предложи только этот шаг.',
    expectedAction: 'click',
    region: { xMin: 0.975, xMax: 1, yMin: 0.39, yMax: 0.48 },
    expectedTarget: 'жёлтый образец правой вертикальной палитры'
  },
  {
    id: 'canvas-grounding',
    instruction: 'Нажми один раз в безопасной центральной области белой страницы. Предложи только этот шаг.',
    expectedAction: 'click',
    region: { xMin: 0.30, xMax: 0.52, yMin: 0.28, yMax: 0.78 },
    expectedTarget: 'центральная область белой страницы'
  }
]);

export function scoreGuiPlan(plan, benchmarkCase) {
  const action = plan?.current?.action || plan?.action || null;
  const actionMatches = action?.type === benchmarkCase.expectedAction;
  const pointMatches = pointInside(action?.point, benchmarkCase.region);
  return {
    passed: actionMatches && pointMatches,
    actionMatches,
    pointMatches,
    expectedAction: benchmarkCase.expectedAction,
    expectedTarget: benchmarkCase.expectedTarget,
    actualAction: action?.type || null,
    actualPoint: action?.point || null
  };
}
