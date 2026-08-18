import { describe, expect, it, vi } from 'vitest';

import {
  BrowserViewHostCore,
  type BrowserViewLike,
  type BrowserViewWindowLike,
} from './view-host-core';

function view(): BrowserViewLike & { bounds: Electron.Rectangle; visible: boolean } {
  return {
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    visible: false,
    setBounds: vi.fn(function (this: { bounds: Electron.Rectangle }, bounds: Electron.Rectangle) {
      this.bounds = { ...bounds };
    }),
    setVisible: vi.fn(function (this: { visible: boolean }, visible: boolean) {
      this.visible = visible;
    }),
  };
}

function window(width: number, height: number): BrowserViewWindowLike & {
  children: BrowserViewLike[];
  focused: boolean;
  visible: boolean;
} {
  const target = {
    children: [] as BrowserViewLike[],
    focused: true,
    visible: true,
    contentView: {
      addChildView: vi.fn((candidate: BrowserViewLike) => target.children.push(candidate)),
      removeChildView: vi.fn((candidate: BrowserViewLike) => {
        target.children = target.children.filter((item) => item !== candidate);
      }),
    },
    getContentBounds: vi.fn(() => ({ x: 100, y: 50, width, height })),
    getBounds: vi.fn(() => ({ x: 100, y: 50, width, height })),
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => target.focused),
    isVisible: vi.fn(() => target.visible),
  };
  return target;
}

describe('Browser WebContentsView placement core', () => {
  it('parks every registered view attached and visible at the narrow fallback viewport', () => {
    const parking = window(420, 480);
    const host = new BrowserViewHostCore({
      parkingWindow: parking,
      initialViewport: { width: 420, height: 480 },
    });
    const firstView = view();
    const secondView = view();
    const first = host.register(firstView);
    const second = host.register(secondView);

    expect(parking.children).toEqual([firstView, secondView]);
    expect(firstView.visible).toBe(true);
    expect(secondView.visible).toBe(true);
    expect(firstView.bounds).toEqual({ x: 0, y: 0, width: 420, height: 480 });
    expect(first.viewportRevision).toBe(1);
    expect(second.viewportRevision).toBe(1);
    expect(firstView.setVisible).not.toHaveBeenCalledWith(false);
  });

  it('reparents one selected view and reparks the previous view without hiding either', () => {
    const parking = window(420, 480);
    const presentation = window(520, 680);
    const host = new BrowserViewHostCore({ parkingWindow: parking });
    const firstView = view();
    const secondView = view();
    const first = host.register(firstView);
    const second = host.register(secondView);

    expect(host.present(first, presentation, { x: 12, y: 100, width: 480, height: 500 }))
      .toEqual({ x: 12, y: 100, width: 480, height: 500 });
    expect(presentation.children).toEqual([firstView]);
    expect(parking.children).toEqual([secondView]);
    expect(first.canSendInputEvents()).toBe(true);

    host.present(second, presentation, { x: 20, y: 110, width: 460, height: 480 });
    expect(presentation.children).toEqual([secondView]);
    expect(parking.children).toEqual([firstView]);
    expect(firstView.visible).toBe(true);
    expect(first.canSendInputEvents()).toBe(false);
    expect(second.canSendInputEvents()).toBe(true);
    expect(firstView.setVisible).not.toHaveBeenCalledWith(false);
  });

  it('clips renderer bounds to the real content area and increments revision only for visual size', () => {
    const parking = window(420, 480);
    const presentation = window(500, 600);
    const host = new BrowserViewHostCore({ parkingWindow: parking });
    const candidate = host.register(view());

    expect(host.present(candidate, presentation, {
      x: -20, y: 580, width: 900, height: 200,
    })).toEqual({ x: 0, y: 580, width: 500, height: 20 });
    expect(candidate.viewportRevision).toBe(2);
    host.present(candidate, presentation, { x: 0, y: 10, width: 500, height: 20 });
    expect(candidate.viewportRevision).toBe(2);
    candidate.updateVisualMetrics({ deviceScaleFactor: 2, zoomFactor: 1 });
    expect(candidate.viewportRevision).toBe(3);
    candidate.updateVisualMetrics({ deviceScaleFactor: 2, zoomFactor: 1 });
    expect(candidate.viewportRevision).toBe(3);
  });

  it('resizes all parked views responsively and fences destroyed presentation windows', () => {
    const parking = window(420, 480);
    const presentation = window(520, 680);
    const host = new BrowserViewHostCore({ parkingWindow: parking });
    const firstView = view();
    const secondView = view();
    const first = host.register(firstView);
    const second = host.register(secondView);
    host.present(first, presentation, { x: 0, y: 100, width: 500, height: 500 });

    host.updateParkingViewport({ width: 360, height: 430 });
    expect(secondView.bounds).toEqual({ x: 0, y: 0, width: 360, height: 430 });
    expect(second.viewportRevision).toBe(2);
    expect(firstView.bounds).toEqual({ x: 0, y: 100, width: 500, height: 500 });

    vi.mocked(presentation.isDestroyed).mockReturnValue(true);
    expect(host.present(second, presentation, { x: 0, y: 0, width: 100, height: 100 }))
      .toBeNull();
    expect(parking.children).toContain(firstView);
    expect(parking.children).toContain(secondView);
  });

  it('removes a view exactly once and never disposes another parked view', () => {
    const parking = window(420, 480);
    const host = new BrowserViewHostCore({ parkingWindow: parking });
    const firstView = view();
    const secondView = view();
    const first = host.register(firstView);
    host.register(secondView);

    expect(first.dispose()).toBe(true);
    expect(first.dispose()).toBe(false);
    expect(parking.children).toEqual([secondView]);
  });
});
