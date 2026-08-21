import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import type { BrowserAnnotationCapture } from '@shared/browser-view';
import { StableButtonContent } from '../StableButtonContent';
import {
  appendAnnotationPoint,
  commitAnnotationStroke,
  fitImageRect,
  normalizedPoint,
  renderAnnotationStrokes,
  startAnnotationStroke,
  type IabAnnotationStroke,
  type IabAnnotationTool,
} from './iab-annotation-model';

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('标注截图解码失败。'));
    image.src = dataUrl;
  });
}

function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob == null) reject(new Error('标注 PNG 导出失败。'));
      else resolve(blob);
    }, 'image/png');
  });
}

export async function exportIabAnnotationPng(
  capture: BrowserAnnotationCapture,
  strokes: readonly IabAnnotationStroke[],
): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = capture.physicalPixels.width;
  canvas.height = capture.physicalPixels.height;
  const context = canvas.getContext('2d');
  if (context == null) throw new Error('当前环境无法创建标注画布。');
  const image = await loadImage(`data:image/png;base64,${capture.pngBase64}`);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  renderAnnotationStrokes(context, strokes, canvas.width, canvas.height);
  const blob = await canvasPng(canvas);
  return new File([blob], 'iab-annotation.png', { type: 'image/png' });
}

export function IabAnnotationCanvas({
  capture,
  onCancel,
  onComplete,
}: {
  capture: BrowserAnnotationCapture;
  onCancel: () => void;
  onComplete: (file: File) => Promise<boolean>;
}): JSX.Element {
  const [tool, setTool] = useState<IabAnnotationTool>('pen');
  const [strokes, setStrokes] = useState<readonly IabAnnotationStroke[]>([]);
  const [draft, setDraft] = useState<IabAnnotationStroke | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 1, height: 1 });
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const draftRef = useRef<IabAnnotationStroke | null>(null);
  const imageUrl = `data:image/png;base64,${capture.pngBase64}`;
  const fitted = useMemo(() => fitImageRect(
    containerSize.width,
    containerSize.height,
    capture.physicalPixels.width,
    capture.physicalPixels.height,
  ), [capture.physicalPixels.height, capture.physicalPixels.width, containerSize]);
  const fittedStyle = useMemo(() => ({
    left: fitted.x,
    top: fitted.y,
    width: fitted.width,
    height: fitted.height,
  }), [fitted]);

  useEffect(() => {
    const container = containerRef.current;
    if (container == null) return;
    const update = (): void => setContainerSize({
      width: Math.max(1, container.clientWidth),
      height: Math.max(1, container.clientHeight),
    });
    const observer = new ResizeObserver(update);
    observer.observe(container);
    update();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (canvas == null || context == null) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    renderAnnotationStrokes(
      context,
      draft == null ? strokes : [...strokes, draft],
      canvas.width,
      canvas.height,
    );
  }, [draft, strokes]);

  const pointFor = (event: ReactPointerEvent<HTMLCanvasElement>) =>
    normalizedPoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (event.button !== 0 || pointerIdRef.current != null) return;
    pointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const next = startAnnotationStroke(tool, pointFor(event));
    draftRef.current = next;
    setDraft(next);
  };
  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (pointerIdRef.current !== event.pointerId) return;
    const current = draftRef.current;
    if (current == null) return;
    const next = appendAnnotationPoint(current, pointFor(event));
    draftRef.current = next;
    setDraft(next);
  };
  const pointerEnd = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (pointerIdRef.current !== event.pointerId) return;
    pointerIdRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    const completed = draftRef.current;
    draftRef.current = null;
    setDraft(null);
    if (completed != null) setStrokes((items) => commitAnnotationStroke(items, completed));
  };
  const pointerCancel = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (pointerIdRef.current !== event.pointerId) return;
    pointerIdRef.current = null;
    draftRef.current = null;
    setDraft(null);
  };
  const complete = async (): Promise<void> => {
    if (exporting || strokes.length === 0) return;
    setExporting(true);
    setError(null);
    try {
      const file = await exportIabAnnotationPng(capture, strokes);
      if (!await onComplete(file)) throw new Error('标注图片未能加入消息附件。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setExporting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-neutral-950" data-iab-annotation>
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-white/10 px-2 py-1">
        <button type="button" className={tool === 'pen' ? 'rounded bg-white/15 px-2 py-1 text-[10px]' : 'rounded px-2 py-1 text-[10px] text-deck-muted hover:bg-white/10'} onClick={() => setTool('pen')}>画笔</button>
        <button type="button" className={tool === 'circle' ? 'rounded bg-white/15 px-2 py-1 text-[10px]' : 'rounded px-2 py-1 text-[10px] text-deck-muted hover:bg-white/10'} onClick={() => setTool('circle')}>圈选</button>
        <button type="button" className="rounded px-2 py-1 text-[10px] text-deck-muted hover:bg-white/10" disabled={strokes.length === 0} onClick={() => setStrokes((items) => items.slice(0, -1))}>撤销</button>
        <button type="button" className="rounded px-2 py-1 text-[10px] text-deck-muted hover:bg-white/10" disabled={strokes.length === 0} onClick={() => setStrokes([])}>清空</button>
        <span className="min-w-2 flex-1" />
        <button type="button" className="rounded px-2 py-1 text-[10px] text-deck-muted hover:bg-white/10" disabled={exporting} onClick={onCancel}>取消</button>
        <button type="button" className="rounded bg-red-500/80 px-2 py-1 text-[10px] text-white hover:bg-red-500 disabled:opacity-40" disabled={exporting || strokes.length === 0} onClick={() => void complete()}>
          <StableButtonContent
            activeKey={exporting ? 'busy' : 'idle'}
            variants={[
              { key: 'idle', content: '加入消息' },
              { key: 'busy', content: '处理中…' },
            ]}
          />
        </button>
      </div>
      {error && <div role="alert" className="shrink-0 bg-red-500/15 px-2 py-1 text-[9px] text-red-200">{error}</div>}
      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden">
        <img
          src={imageUrl}
          alt="冻结的 IAB 页面截图"
          draggable={false}
          className="pointer-events-none absolute select-none"
          style={fittedStyle}
        />
        <canvas
          ref={canvasRef}
          width={capture.physicalPixels.width}
          height={capture.physicalPixels.height}
          className="absolute cursor-crosshair touch-none"
          style={fittedStyle}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerEnd}
          onPointerCancel={pointerCancel}
        />
      </div>
    </div>
  );
}
