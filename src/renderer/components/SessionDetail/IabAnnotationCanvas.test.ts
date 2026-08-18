// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { BrowserAnnotationCapture } from '@shared/browser-view';
import { IabAnnotationCanvas, exportIabAnnotationPng } from './IabAnnotationCanvas';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('IAB annotation PNG export', () => {
  it('composites normalized strokes over the original physical-pixel capture', async () => {
    const context = {
      drawImage: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(),
      ellipse: vi.fn(), stroke: vi.fn(), arc: vi.fn(), fill: vi.fn(), moveTo: vi.fn(),
      lineTo: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => context),
      toBlob: vi.fn((callback: BlobCallback) => callback(new Blob(['annotated'], {
        type: 'image/png',
      }))),
    } as unknown as HTMLCanvasElement;
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) =>
      tagName === 'canvas' ? canvas : originalCreateElement(tagName)) as typeof document.createElement);
    const OriginalImage = globalThis.Image;
    class ReadyImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    globalThis.Image = ReadyImage as unknown as typeof Image;
    const capture = {
      physicalPixels: { width: 840, height: 960 },
      pngBase64: 'cG5n',
    } as BrowserAnnotationCapture;

    try {
      const file = await exportIabAnnotationPng(capture, [{
        tool: 'pen',
        points: [{ x: 0.25, y: 0.5 }, { x: 0.75, y: 1 }],
      }]);

      expect(canvas.width).toBe(840);
      expect(canvas.height).toBe(960);
      expect(context.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 840, 960);
      expect(context.moveTo).toHaveBeenCalledWith(210, 480);
      expect(context.lineTo).toHaveBeenCalledWith(630, 960);
      expect(file).toMatchObject({ name: 'iab-annotation.png', type: 'image/png' });
    } finally {
      globalThis.Image = OriginalImage;
    }
  });

  it('records a pointer stroke and completes only through the attachment callback', async () => {
    const context = {
      clearRect: vi.fn(), drawImage: vi.fn(), save: vi.fn(), restore: vi.fn(),
      beginPath: vi.fn(), ellipse: vi.fn(), stroke: vi.fn(), arc: vi.fn(), fill: vi.fn(),
      moveTo: vi.fn(), lineTo: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(new Blob(['annotated'], { type: 'image/png' }));
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, width: 420, height: 480,
      top: 0, left: 0, right: 420, bottom: 480,
      toJSON: () => ({}),
    });
    const OriginalImage = globalThis.Image;
    const originalResizeObserver = globalThis.ResizeObserver;
    class ReadyImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    globalThis.Image = ReadyImage as unknown as typeof Image;
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element): void {
        this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      disconnect(): void {}
      unobserve(): void {}
    };
    const onComplete = vi.fn(async (_file: File) => true);
    const capture = {
      physicalPixels: { width: 840, height: 960 },
      pngBase64: 'cG5n',
    } as BrowserAnnotationCapture;

    try {
      const view = render(createElement(IabAnnotationCanvas, {
        capture,
        onCancel: vi.fn(),
        onComplete,
      }));
      const canvas = view.container.querySelector('canvas');
      if (canvas == null) throw new Error('missing annotation canvas');
      fireEvent.pointerDown(canvas, { button: 0, pointerId: 7, clientX: 42, clientY: 48 });
      fireEvent.pointerMove(canvas, { pointerId: 7, clientX: 210, clientY: 240 });
      fireEvent.pointerUp(canvas, { pointerId: 7, clientX: 378, clientY: 432 });
      fireEvent.click(screen.getByRole('button', { name: '加入消息' }));

      await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
      expect(onComplete.mock.calls[0]?.[0]).toMatchObject({
        name: 'iab-annotation.png', type: 'image/png',
      });
    } finally {
      globalThis.Image = OriginalImage;
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });
});
