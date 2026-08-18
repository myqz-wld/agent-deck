import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FloatingWindowState } from '../_deps';

const mocks = vi.hoisted(() => ({
  parkAllBrowserViews: vi.fn(),
  getDisplayMatching: vi.fn(() => ({
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  })),
}));

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  screen: { getDisplayMatching: mocks.getDisplayMatching },
}));

vi.mock('../_deps', () => ({
  COMPACT_HEIGHT: 64,
  DEFAULT_WIDTH: 520,
  DEFAULT_HEIGHT: 680,
  MIN_WIDTH: 380,
  MIN_HEIGHT: 260,
  MAX_INSET: 40,
  TARGET_TOLERANCE_PX: 4,
  ANIMATE_GUARD_MS: 300,
}));

vi.mock('@main/browser-use/view-presentation-lifecycle', () => ({
  parkAllBrowserViews: mocks.parkAllBrowserViews,
}));

import { toggleCompactImpl } from '../sizing';

function createState(): FloatingWindowState {
  const win = {
    isDestroyed: vi.fn(() => false),
    getSize: vi.fn(() => [520, 680]),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 520, height: 680 })),
    setMinimumSize: vi.fn(),
    setSize: vi.fn(),
  };
  return {
    win,
    compact: false,
    invalidateTimer: null,
    lastNormalSize: { width: 520, height: 680 },
    preferredSize: null,
    lastToggleAt: Date.now(),
    windowTransparent: true,
    alwaysOnTop: false,
    flashTimer: null,
    flashOriginalOpacity: 1,
    fallbackShowTimer: null,
    emitCompactChanged: null,
  } as unknown as FloatingWindowState;
}

describe('Browser view presentation lifecycle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parks every presented Browser view before entering compact mode', () => {
    const state = createState();

    expect(toggleCompactImpl(state)).toBe(true);
    expect(mocks.parkAllBrowserViews).toHaveBeenCalledOnce();

    expect(toggleCompactImpl(state)).toBe(false);
    expect(mocks.parkAllBrowserViews).toHaveBeenCalledOnce();
  });
});
