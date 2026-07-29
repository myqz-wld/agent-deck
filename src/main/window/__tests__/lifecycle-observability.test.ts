import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FloatingWindowState } from '../_deps';

const mocks = vi.hoisted(() => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    logger,
    loggerScope: vi.fn(() => logger),
    safeDiagnostic: vi.fn((value: unknown) => value),
    getProcessRunId: vi.fn(() => 'window-load-test-run'),
    browserWindow: vi.fn(),
    getPrimaryDisplay: vi.fn(),
    dockSetIcon: vi.fn(),
    openExternal: vi.fn(async () => undefined),
    stopInvalidateLoop: vi.fn(),
    installNavigationPolicy: vi.fn(),
    resolveIconImage: vi.fn(),
    toolkitIs: { dev: false },
  };
});

vi.mock('electron', () => ({
  BrowserWindow: mocks.browserWindow,
  app: {
    dock: { setIcon: mocks.dockSetIcon },
  },
  screen: {
    getPrimaryDisplay: mocks.getPrimaryDisplay,
  },
  shell: { openExternal: mocks.openExternal },
}));
vi.mock('@electron-toolkit/utils', () => ({ is: mocks.toolkitIs }));
vi.mock('../_deps', () => ({
  DEFAULT_WIDTH: 520,
  DEFAULT_HEIGHT: 680,
  MIN_WIDTH: 380,
  MIN_HEIGHT: 260,
  resolveIconImage: mocks.resolveIconImage,
}));
vi.mock('../pin-visual', () => ({ stopInvalidateLoop: mocks.stopInvalidateLoop }));
vi.mock('../navigation-policy', () => ({
  installWindowNavigationPolicy: mocks.installNavigationPolicy,
}));
vi.mock('@main/utils/logger', () => ({ default: { scope: mocks.loggerScope } }));
vi.mock('@main/utils/safe-diagnostic', () => ({ safeDiagnostic: mocks.safeDiagnostic }));
vi.mock('@main/utils/run-context', () => ({ getProcessRunId: mocks.getProcessRunId }));

interface FakeWindow {
  onceListeners: Map<string, (...args: unknown[]) => void>;
  webOnceListeners: Map<string, (...args: unknown[]) => void>;
  webOnListeners: Map<string, (...args: unknown[]) => void>;
  show: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  setAlwaysOnTop: ReturnType<typeof vi.fn>;
  setVisibleOnAllWorkspaces: ReturnType<typeof vi.fn>;
  setVibrancy: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  loadFile: ReturnType<typeof vi.fn>;
  webContents: {
    once: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    setBackgroundThrottling: ReturnType<typeof vi.fn>;
  };
  once: ReturnType<typeof vi.fn>;
}

function fakeWindow(): FakeWindow {
  const onceListeners = new Map<string, (...args: unknown[]) => void>();
  const webOnceListeners = new Map<string, (...args: unknown[]) => void>();
  const webOnListeners = new Map<string, (...args: unknown[]) => void>();
  return {
    onceListeners,
    webOnceListeners,
    webOnListeners,
    show: vi.fn(),
    close: vi.fn(),
    isDestroyed: vi.fn(() => false),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    setVibrancy: vi.fn(),
    loadURL: vi.fn(async () => undefined),
    loadFile: vi.fn(async () => undefined),
    webContents: {
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        webOnceListeners.set(event, listener);
      }),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        webOnListeners.set(event, listener);
      }),
      setBackgroundThrottling: vi.fn(),
    },
    once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      onceListeners.set(event, listener);
    }),
  };
}

function makeState(overrides: Partial<FloatingWindowState> = {}): FloatingWindowState {
  return {
    win: null,
    compact: true,
    invalidateTimer: null,
    lastNormalSize: { width: 900, height: 700 },
    preferredSize: { width: 700, height: 500 },
    lastToggleAt: 123,
    windowTransparent: false,
    alwaysOnTop: false,
    flashTimer: null,
    flashOriginalOpacity: 1,
    fallbackShowTimer: null,
    emitCompactChanged: vi.fn(),
    ...overrides,
  };
}

function trigger(listeners: Map<string, (...args: unknown[]) => void>,
  event: string, ...args: unknown[]): void {
  const listener = listeners.get(event);
  if (!listener) throw new Error(`missing listener: ${event}`);
  listener(...args);
}

function loggedText(): string {
  return [
    ...mocks.logger.info.mock.calls,
    ...mocks.logger.warn.mock.calls,
    ...mocks.logger.error.mock.calls,
  ].flat().map(String).join(' ');
}

let subject: typeof import('../lifecycle');
let currentWindow: FakeWindow;

describe('window lifecycle observability', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    currentWindow = fakeWindow();
    mocks.browserWindow.mockImplementation(() => currentWindow);
    mocks.getPrimaryDisplay.mockReturnValue({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    });
    mocks.loggerScope.mockReturnValue(mocks.logger);
    mocks.safeDiagnostic.mockImplementation((value: unknown) => value);
    mocks.getProcessRunId.mockReturnValue('window-load-test-run');
    mocks.resolveIconImage.mockReturnValue({ isEmpty: vi.fn(() => false) });
    mocks.toolkitIs.dev = false;
    subject = await import('../lifecycle');
  });

  afterEach(() => {
    vi.doUnmock('@main/utils/log-state-tracker');
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('preserves window options, navigation wiring, load target, and state reset', () => {
    const state = makeState();

    expect(subject.createImpl(state)).toBe(currentWindow);
    expect(mocks.browserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 520,
        height: 680,
        minWidth: 380,
        minHeight: 260,
        x: 1380,
        y: 60,
        transparent: true,
        frame: false,
        resizable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: false,
        backgroundColor: '#00000000',
        hasShadow: true,
        vibrancy: 'under-window',
        visualEffectState: 'active',
        titleBarStyle: 'hidden',
        show: false,
        icon: expect.anything(),
        webPreferences: expect.objectContaining({
          preload: expect.stringMatching(/preload\/index\.js$/),
          sandbox: false,
          contextIsolation: true,
        }),
      }),
    );
    expect(currentWindow.setAlwaysOnTop).toHaveBeenCalledWith(false, 'normal');
    expect(currentWindow.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
      visibleOnFullScreen: true,
    });
    expect(mocks.installNavigationPolicy).toHaveBeenCalledWith(
      currentWindow.webContents,
      expect.any(Function),
    );
    expect(currentWindow.loadFile).toHaveBeenCalledWith(
      expect.stringMatching(/renderer\/index\.html$/),
    );
    expect(currentWindow.loadURL).not.toHaveBeenCalled();
    expect(currentWindow.webContents.setBackgroundThrottling).toHaveBeenCalledWith(
      false,
    );
    expect(currentWindow.setVibrancy).toHaveBeenCalledWith('under-window');
    expect(state).toMatchObject({
      win: currentWindow,
      compact: false,
      preferredSize: null,
      lastNormalSize: { width: 520, height: 680 },
      lastToggleAt: 0,
    });
  });

  it('uses the development renderer URL when configured', async () => {
    mocks.toolkitIs.dev = true;
    vi.stubEnv(
      'ELECTRON_RENDERER_URL',
      'http://127.0.0.1:5173/private',
    );
    const state = makeState();

    subject.createImpl(state);
    expect(currentWindow.loadURL).toHaveBeenCalledWith(
      'http://127.0.0.1:5173/private',
    );
    expect(currentWindow.loadFile).not.toHaveBeenCalled();
  });

  it('uses the exact fallback threshold and recovers on late real load without reshowing', () => {
    const state = makeState();
    subject.createImpl(state);

    vi.advanceTimersByTime(1_499);
    expect(currentWindow.show).not.toHaveBeenCalled();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(currentWindow.show).toHaveBeenCalledOnce();
    expect(mocks.logger.warn).toHaveBeenCalledWith('window load state degraded', {
      event: 'window-load-state',
      runId: 'window-load-test-run',
      operation: 'window-load',
      state: 'fallback-show',
      previousState: null,
      transition: 'initial',
      abnormalDurationMs: 0,
      suppressedCount: 0,
      suppressedCountCapped: false,
      summaryIntervalMs: 300_000,
      fallbackThresholdMs: 1_500,
    });

    vi.setSystemTime(1_501);
    trigger(currentWindow.onceListeners, 'ready-to-show');
    expect(currentWindow.show).toHaveBeenCalledOnce();
    expect(mocks.logger.info).toHaveBeenCalledOnce();
    expect(mocks.logger.info).toHaveBeenCalledWith(
      'window load state recovered',
      expect.objectContaining({
        state: 'healthy',
        previousState: 'fallback-show',
        transition: 'transition',
        abnormalDurationMs: 1,
      }),
    );
    trigger(currentWindow.webOnceListeners, 'did-finish-load');
    expect(currentWindow.show).toHaveBeenCalledOnce();
    expect(mocks.logger.info).toHaveBeenCalledOnce();
  });

  it('does not manufacture fallback degradation after a timely load', () => {
    const state = makeState();
    subject.createImpl(state);

    vi.advanceTimersByTime(1_499);
    trigger(currentWindow.webOnceListeners, 'did-finish-load');
    expect(currentWindow.show).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(currentWindow.show).toHaveBeenCalledOnce();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(mocks.logger.info).not.toHaveBeenCalled();
  });

  it('distinguishes renderer and preload failures without emitting raw arguments', () => {
    const state = makeState();
    subject.createImpl(state);
    const rawRendererUrl = 'https://secret.example/private?token=hidden';
    const rawPreloadPath = '/Users/private/preload.js';
    const rawError = new Error('RAW_PRELOAD token=private');

    trigger(
      currentWindow.webOnListeners,
      'did-fail-load',
      {},
      -7,
      'RAW_RENDERER_DESCRIPTION',
      rawRendererUrl,
    );
    expect(mocks.logger.warn).toHaveBeenLastCalledWith(
      'window load state degraded',
      expect.objectContaining({
        state: 'renderer-load-failed',
        previousState: null,
        transition: 'initial',
      }),
    );

    vi.setSystemTime(1);
    trigger(
      currentWindow.webOnListeners,
      'preload-error',
      {},
      rawPreloadPath,
      rawError,
    );
    expect(mocks.logger.warn).toHaveBeenLastCalledWith(
      'window load state degraded',
      expect.objectContaining({
        state: 'preload-load-failed',
        previousState: 'renderer-load-failed',
        transition: 'transition',
      }),
    );
    expect(loggedText()).not.toMatch(
      /RAW_|secret\.example|hidden|\/Users\/private|preload\.js/,
    );

    vi.setSystemTime(2);
    trigger(currentWindow.onceListeners, 'ready-to-show');
    expect(mocks.logger.info).toHaveBeenCalledWith(
      'window load state recovered',
      expect.objectContaining({
        previousState: 'preload-load-failed',
        abnormalDurationMs: 2,
      }),
    );
  });

  it('suppresses repeated fallback and summarizes exactly five minutes later', () => {
    const stateA = makeState();
    subject.createImpl(stateA);
    vi.advanceTimersByTime(1_500);
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);

    currentWindow = fakeWindow();
    mocks.browserWindow.mockImplementation(() => currentWindow);
    const stateB = makeState();
    subject.createImpl(stateB);
    vi.advanceTimersByTime(1_500);
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);

    vi.setSystemTime(300_000);
    currentWindow = fakeWindow();
    mocks.browserWindow.mockImplementation(() => currentWindow);
    const stateC = makeState();
    subject.createImpl(stateC);
    vi.advanceTimersByTime(1_499);
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(mocks.logger.warn).toHaveBeenLastCalledWith(
      'window load state remains degraded',
      expect.objectContaining({
        state: 'fallback-show',
        previousState: 'fallback-show',
        transition: 'periodic-summary',
        abnormalDurationMs: 300_000,
        suppressedCount: 1,
      }),
    );
  });

  it('keeps old-generation callbacks from showing or diagnosing the replacement', () => {
    const state = makeState();
    const firstWindow = currentWindow;
    subject.createImpl(state);

    const secondWindow = fakeWindow();
    currentWindow = secondWindow;
    mocks.browserWindow.mockImplementation(() => secondWindow);
    subject.createImpl(state);
    vi.advanceTimersByTime(1_500);

    expect(firstWindow.show).not.toHaveBeenCalled();
    expect(secondWindow.show).toHaveBeenCalledOnce();
    expect(mocks.logger.warn).toHaveBeenCalledOnce();
  });

  it('cleans timer ownership and state on close events and explicit close', () => {
    const flashTimer = setInterval(() => {}, 10_000);
    const state = makeState({ flashTimer });
    subject.createImpl(state);

    trigger(currentWindow.onceListeners, 'closed');
    expect(mocks.stopInvalidateLoop).toHaveBeenCalledWith(state);
    expect(state.flashTimer).toBeNull();
    expect(state.fallbackShowTimer).toBeNull();
    expect(state.win).toBeNull();
    vi.advanceTimersByTime(1_500);
    expect(currentWindow.show).not.toHaveBeenCalled();

    const explicitWindow = fakeWindow();
    const explicitFlash = setInterval(() => {}, 10_000);
    const explicitFallback = setTimeout(() => {}, 10_000);
    const explicitState = makeState({
      win: explicitWindow as never,
      flashTimer: explicitFlash,
      fallbackShowTimer: explicitFallback,
    });
    subject.closeImpl(explicitState);
    expect(explicitWindow.close).toHaveBeenCalledOnce();
    expect(explicitState).toMatchObject({
      win: null,
      flashTimer: null,
      fallbackShowTimer: null,
      emitCompactChanged: null,
    });
  });

  it.each([
    ['serializer', () => mocks.safeDiagnostic.mockImplementation(() => {
      throw new Error('RAW_WINDOW_SERIALIZER');
    })],
    ['run id', () => mocks.getProcessRunId.mockImplementation(() => {
      throw new Error('RAW_WINDOW_RUN_ID');
    })],
    ['sink', () => mocks.logger.warn.mockImplementation(() => {
      throw new Error('RAW_WINDOW_SINK');
    })],
    ['clock', () => vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('RAW_WINDOW_CLOCK');
    })],
  ])('contains %s failure without changing window load behavior', (_name, fail) => {
    fail();
    const state = makeState();

    expect(() => subject.createImpl(state)).not.toThrow();
    expect(() =>
      trigger(
        currentWindow.webOnListeners,
        'did-fail-load',
        {},
        -7,
        'RAW_DESCRIPTION',
        'https://private.test',
      ),
    ).not.toThrow();
    vi.advanceTimersByTime(1_500);
    expect(currentWindow.show).toHaveBeenCalledOnce();
  });

  it('contains logger scope failure without changing window creation', async () => {
    vi.resetModules();
    mocks.loggerScope.mockImplementation(() => {
      throw new Error('RAW_WINDOW_SCOPE');
    });
    const fresh = await import('../lifecycle');
    const state = makeState();

    expect(fresh.createImpl(state)).toBe(currentWindow);
    vi.advanceTimersByTime(1_500);
    expect(currentWindow.show).toHaveBeenCalledOnce();
  });

  it('uses a one-entry tracker and contains tracker failure', async () => {
    const options: unknown[] = [];
    vi.resetModules();
    vi.doMock('@main/utils/log-state-tracker', () => ({
      BoundedLogStateTracker: class {
        constructor(value: unknown) {
          options.push(value);
        }

        observe(): never {
          throw new Error('RAW_WINDOW_TRACKER');
        }
      },
    }));
    const fresh = await import('../lifecycle');
    const state = makeState();

    expect(fresh.createImpl(state)).toBe(currentWindow);
    vi.advanceTimersByTime(1_500);
    expect(currentWindow.show).toHaveBeenCalledOnce();
    expect(options).toEqual([
      {
        capacity: 1,
        summaryIntervalMs: 300_000,
      },
    ]);
  });
});
