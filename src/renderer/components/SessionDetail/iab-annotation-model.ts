export type IabAnnotationTool = 'pen' | 'circle';

export interface NormalizedPoint {
  readonly x: number;
  readonly y: number;
}

export interface IabAnnotationStroke {
  readonly tool: IabAnnotationTool;
  readonly points: readonly NormalizedPoint[];
}

export interface FittedImageRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const MAX_IAB_ANNOTATION_STROKES = 200;
export const MAX_IAB_ANNOTATION_POINTS = 2_000;

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function normalizedPoint(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
): NormalizedPoint {
  return {
    x: clamp((clientX - rect.left) / Math.max(1, rect.width)),
    y: clamp((clientY - rect.top) / Math.max(1, rect.height)),
  };
}

export function startAnnotationStroke(
  tool: IabAnnotationTool,
  point: NormalizedPoint,
): IabAnnotationStroke {
  return { tool, points: tool === 'circle' ? [point, point] : [point] };
}

export function appendAnnotationPoint(
  stroke: IabAnnotationStroke,
  point: NormalizedPoint,
): IabAnnotationStroke {
  if (stroke.tool === 'circle') return { ...stroke, points: [stroke.points[0]!, point] };
  if (stroke.points.length >= MAX_IAB_ANNOTATION_POINTS) return stroke;
  const previous = stroke.points.at(-1);
  if (previous != null && Math.hypot(point.x - previous.x, point.y - previous.y) < 0.001) {
    return stroke;
  }
  return { ...stroke, points: [...stroke.points, point] };
}

export function commitAnnotationStroke(
  strokes: readonly IabAnnotationStroke[],
  stroke: IabAnnotationStroke,
): readonly IabAnnotationStroke[] {
  if (strokes.length >= MAX_IAB_ANNOTATION_STROKES) return strokes;
  const usedPoints = strokes.reduce((total, item) => total + item.points.length, 0);
  const availablePoints = MAX_IAB_ANNOTATION_POINTS - usedPoints;
  if (availablePoints < (stroke.tool === 'circle' ? 2 : 1)) return strokes;
  const boundedStroke = stroke.points.length <= availablePoints
    ? stroke
    : { ...stroke, points: stroke.points.slice(0, availablePoints) };
  if (boundedStroke.tool === 'circle') {
    const [start, end] = boundedStroke.points;
    if (start == null || end == null || Math.hypot(end.x - start.x, end.y - start.y) < 0.003) {
      return strokes;
    }
  }
  return [...strokes, boundedStroke];
}

export function fitImageRect(
  containerWidth: number,
  containerHeight: number,
  imageWidth: number,
  imageHeight: number,
): FittedImageRect {
  const safeContainerWidth = Math.max(1, containerWidth);
  const safeContainerHeight = Math.max(1, containerHeight);
  const scale = Math.min(
    safeContainerWidth / Math.max(1, imageWidth),
    safeContainerHeight / Math.max(1, imageHeight),
  );
  const width = Math.max(1, imageWidth * scale);
  const height = Math.max(1, imageHeight * scale);
  return {
    x: (safeContainerWidth - width) / 2,
    y: (safeContainerHeight - height) / 2,
    width,
    height,
  };
}

export function renderAnnotationStrokes(
  context: CanvasRenderingContext2D,
  strokes: readonly IabAnnotationStroke[],
  width: number,
  height: number,
): void {
  context.save();
  context.strokeStyle = '#ef4444';
  context.fillStyle = '#ef4444';
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.lineWidth = Math.max(3, Math.min(width, height) * 0.008);
  for (const stroke of strokes) {
    const points = stroke.points;
    if (points.length === 0) continue;
    if (stroke.tool === 'circle') {
      const start = points[0]!;
      const end = points.at(-1)!;
      const x1 = start.x * width;
      const y1 = start.y * height;
      const x2 = end.x * width;
      const y2 = end.y * height;
      context.beginPath();
      context.ellipse(
        (x1 + x2) / 2,
        (y1 + y2) / 2,
        Math.abs(x2 - x1) / 2,
        Math.abs(y2 - y1) / 2,
        0,
        0,
        Math.PI * 2,
      );
      context.stroke();
      continue;
    }
    if (points.length === 1) {
      context.beginPath();
      context.arc(points[0]!.x * width, points[0]!.y * height, context.lineWidth / 2, 0, Math.PI * 2);
      context.fill();
      continue;
    }
    context.beginPath();
    context.moveTo(points[0]!.x * width, points[0]!.y * height);
    for (const point of points.slice(1)) context.lineTo(point.x * width, point.y * height);
    context.stroke();
  }
  context.restore();
}
