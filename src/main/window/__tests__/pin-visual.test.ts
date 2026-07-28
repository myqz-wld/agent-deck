import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

import type { FloatingWindowState } from '@main/window/_deps';
import {
  setAlwaysOnTopImpl,
  setWindowTransparentImpl,
  stopInvalidateLoop,
} from '@main/window/pin-visual';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

function makeWindow(): {
  win: BrowserWindow;
  invalidate: ReturnType<typeof vi.fn>;
  invalidateShadow: ReturnType<typeof vi.fn>;
  setAlwaysOnTop: ReturnType<typeof vi.fn>;
  setContentSize: ReturnType<typeof vi.fn>;
  setVibrancy: ReturnType<typeof vi.fn>;
} {
  const invalidate = vi.fn();
  const invalidateShadow = vi.fn();
  const setAlwaysOnTop = vi.fn();
  const setContentSize = vi.fn();
  const setVibrancy = vi.fn();
  const win = {
    isDestroyed: vi.fn(() => false),
    invalidateShadow,
    setAlwaysOnTop,
    setVibrancy,
    getContentSize: vi.fn(() => [520, 680]),
    setContentSize,
    webContents: {
      isDestroyed: vi.fn(() => false),
      invalidate,
    },
  } as unknown as BrowserWindow;
  return { win, invalidate, invalidateShadow, setAlwaysOnTop, setContentSize, setVibrancy };
}

function makeState(
  win: BrowserWindow,
  overrides: Partial<FloatingWindowState> = {},
): FloatingWindowState {
  return {
    win,
    compact: false,
    invalidateTimer: null,
    lastNormalSize: { width: 520, height: 680 },
    preferredSize: null,
    lastToggleAt: 0,
    windowTransparent: true,
    alwaysOnTop: true,
    flashTimer: null,
    flashOriginalOpacity: 1,
    fallbackShowTimer: null,
    emitCompactChanged: null,
    ...overrides,
  };
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: true,
    value: 'darwin',
  });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
});

describe('window compositor invalidation', () => {
  it('keeps repainting after pin is disabled while transparent mode remains enabled', async () => {
    const { win, invalidate, invalidateShadow, setContentSize } = makeWindow();
    const state = makeState(win, { alwaysOnTop: true, windowTransparent: true });

    setAlwaysOnTopImpl(state, false);

    expect(state.alwaysOnTop).toBe(false);
    expect(state.invalidateTimer).not.toBeNull();
    expect(setContentSize).toHaveBeenCalledWith(520, 681);
    await vi.advanceTimersByTimeAsync(100);
    expect(setContentSize).toHaveBeenLastCalledWith(520, 680);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidateShadow).toHaveBeenCalledTimes(3);
    stopInvalidateLoop(state);
  });

  it('starts repainting and forces a full compositor refresh when transparency is enabled unpinned', () => {
    const { win, invalidateShadow, setContentSize, setVibrancy } = makeWindow();
    const state = makeState(win, { alwaysOnTop: false, windowTransparent: false });

    setWindowTransparentImpl(state, true);

    expect(setVibrancy).toHaveBeenCalledWith(null);
    expect(setContentSize).toHaveBeenCalledWith(520, 681);
    expect(invalidateShadow).toHaveBeenCalledTimes(1);
    expect(state.invalidateTimer).not.toBeNull();
    stopInvalidateLoop(state);
  });

  it('stops the repaint loop only when both pin and transparency are disabled', () => {
    const { win, setVibrancy } = makeWindow();
    const state = makeState(win, {
      alwaysOnTop: false,
      windowTransparent: true,
    });
    setWindowTransparentImpl(state, true);
    expect(state.invalidateTimer).not.toBeNull();
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    setWindowTransparentImpl(state, false);

    expect(setVibrancy).toHaveBeenCalledWith('under-window');
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(state.invalidateTimer).toBeNull();
  });

  it('keeps the repaint loop active for an opaque pinned window', () => {
    const { win, invalidateShadow } = makeWindow();
    const state = makeState(win, { alwaysOnTop: true, windowTransparent: true });

    setWindowTransparentImpl(state, false);

    expect(state.invalidateTimer).not.toBeNull();
    vi.advanceTimersByTime(100);
    expect(invalidateShadow).toHaveBeenCalledTimes(2);
    stopInvalidateLoop(state);
  });
});
