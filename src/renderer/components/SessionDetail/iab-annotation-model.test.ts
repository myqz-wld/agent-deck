import { describe, expect, it, vi } from 'vitest';

import {
  appendAnnotationPoint,
  commitAnnotationStroke,
  fitImageRect,
  MAX_IAB_ANNOTATION_POINTS,
  MAX_IAB_ANNOTATION_STROKES,
  normalizedPoint,
  renderAnnotationStrokes,
  startAnnotationStroke,
  type IabAnnotationStroke,
} from './iab-annotation-model';

function fakeContext(): CanvasRenderingContext2D {
  return {
    save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), ellipse: vi.fn(), stroke: vi.fn(),
    arc: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

describe('IAB annotation model', () => {
  it('fits the frozen image responsively and normalizes clamped pointer coordinates', () => {
    expect(fitImageRect(420, 480, 840, 960)).toEqual({
      x: 0, y: 0, width: 420, height: 480,
    });
    expect(fitImageRect(500, 300, 400, 400)).toEqual({
      x: 100, y: 0, width: 300, height: 300,
    });
    const rect = { left: 100, top: 20, width: 400, height: 200 };
    expect(normalizedPoint(300, 120, rect)).toEqual({ x: 0.5, y: 0.5 });
    expect(normalizedPoint(-50, 999, rect)).toEqual({ x: 0, y: 1 });
  });

  it('renders normalized pen and circle strokes into physical PNG pixels', () => {
    const context = fakeContext();
    const strokes: readonly IabAnnotationStroke[] = [
      { tool: 'pen', points: [{ x: 0.25, y: 0.5 }, { x: 0.75, y: 1 }] },
      { tool: 'circle', points: [{ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.8 }] },
    ];

    renderAnnotationStrokes(context, strokes, 1_000, 500);

    expect(context.moveTo).toHaveBeenCalledWith(250, 250);
    expect(context.lineTo).toHaveBeenCalledWith(750, 500);
    expect(context.ellipse).toHaveBeenCalledWith(300, 250, 200, 150, 0, 0, Math.PI * 2);
  });

  it('bounds both stroke count and total stored points', () => {
    let pen = startAnnotationStroke('pen', { x: 0, y: 0 });
    for (let index = 1; index < MAX_IAB_ANNOTATION_POINTS + 20; index += 1) {
      pen = appendAnnotationPoint(pen, { x: index % 2, y: 0.5 });
    }
    expect(pen.points).toHaveLength(MAX_IAB_ANNOTATION_POINTS);

    const committed = commitAnnotationStroke([], pen);
    expect(committed).toHaveLength(1);
    expect(commitAnnotationStroke(committed, startAnnotationStroke('pen', { x: 1, y: 1 })))
      .toBe(committed);

    const circles = Array.from({ length: MAX_IAB_ANNOTATION_STROKES }, () => ({
      tool: 'circle' as const,
      points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    }));
    expect(commitAnnotationStroke(circles, startAnnotationStroke('pen', { x: 0.5, y: 0.5 })))
      .toBe(circles);
  });
});
