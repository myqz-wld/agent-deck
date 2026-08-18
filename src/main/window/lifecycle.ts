import { BrowserWindow, app, screen, shell } from 'electron';
import { join } from 'node:path';
import { is } from '@electron-toolkit/utils';

import {
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  MIN_WIDTH,
  MIN_HEIGHT,
  resolveIconImage,
  type FloatingWindowState,
} from './_deps';
import { stopInvalidateLoop } from './pin-visual';
import { installWindowNavigationPolicy } from './navigation-policy';
import log from '@main/utils/logger';
import { safeDiagnostic } from '@main/utils/safe-diagnostic';
import { getProcessRunId } from '@main/utils/run-context';
import {
  BoundedLogStateTracker,
  type LogStateDecision,
  type LogStateSnapshot,
} from '@main/utils/log-state-tracker';
import { registerWindowRole } from './window-role-registry';
import { parkAllBrowserViews } from '@main/browser-use/view-presentation-lifecycle';

const WINDOW_LOAD_TRACKER_CAPACITY = 1;
const SUMMARY_INTERVAL_MS = 300_000;
const FALLBACK_SHOW_THRESHOLD_MS = 1_500;

type WindowLoadOperation = 'window-load';
type WindowLoadState =
  | 'healthy'
  | 'fallback-show'
  | 'renderer-load-failed'
  | 'preload-load-failed';

function createWindowLogger(): ReturnType<typeof log.scope> | null {
  try {
    return log.scope('window-lifecycle');
  } catch {
    return null;
  }
}

function createWindowLoadTracker(): BoundedLogStateTracker<
  WindowLoadOperation,
  WindowLoadState
> | null {
  try {
    return new BoundedLogStateTracker<WindowLoadOperation, WindowLoadState>({
      capacity: WINDOW_LOAD_TRACKER_CAPACITY,
      summaryIntervalMs: SUMMARY_INTERVAL_MS,
    });
  } catch {
    return null;
  }
}

const logger = createWindowLogger();
const windowLoadTracker = createWindowLoadTracker();
const unregisterWindowRoles = new WeakMap<BrowserWindow, () => void>();

function observeWindowLoadState(state: WindowLoadState): void {
  if (!windowLoadTracker) return;
  try {
    emitWindowLoadDecision(
      windowLoadTracker.observe('window-load', {
        signature: state,
        abnormal: state !== 'healthy',
      }),
    );
  } catch {
    // Window diagnostics cannot alter creation, timers, or event dispatch.
  }
}

function emitWindowLoadDecision(decision: LogStateDecision<WindowLoadState>): void {
  if (decision.kind === 'repeat') return;
  if (decision.kind === 'initial' && !decision.current.abnormal) return;

  const priorAbnormal: LogStateSnapshot<WindowLoadState> | null =
    decision.flushed?.abnormal ? decision.flushed : null;
  const aggregate = priorAbnormal ?? decision.current;
  try {
    const details = safeDiagnostic({
      event: 'window-load-state',
      runId: getProcessRunId(),
      operation: 'window-load',
      state: decision.current.signature,
      previousState: decision.flushed?.signature ?? null,
      transition: decision.kind,
      abnormalDurationMs: aggregate.abnormalDurationMs,
      suppressedCount: aggregate.suppressedCount,
      suppressedCountCapped: aggregate.suppressedCountCapped,
      summaryIntervalMs: SUMMARY_INTERVAL_MS,
      fallbackThresholdMs: FALLBACK_SHOW_THRESHOLD_MS,
    });
    if (decision.current.abnormal) {
      logger?.warn(
        decision.kind === 'periodic-summary'
          ? 'window load state remains degraded'
          : 'window load state degraded',
        details,
      );
    } else if (priorAbnormal) {
      logger?.info('window load state recovered', details);
    }
  } catch {
    // Serialization and logging remain best-effort.
  }
}

/** Create one window generation and attach its load, cleanup, and presentation lifecycle. */
export function createImpl(state: FloatingWindowState): BrowserWindow {
  const display = screen.getPrimaryDisplay().workArea;
  const x = display.x + display.width - DEFAULT_WIDTH - 20;
  const y = display.y + 60;

  state.win = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    x,
    y,
    transparent: true,
    frame: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: state.alwaysOnTop,
    backgroundColor: '#00000000',
    hasShadow: true,
    vibrancy: state.windowTransparent ? undefined : 'under-window',
    visualEffectState: 'active',
    titleBarStyle: 'hidden',
    show: false,
    icon: resolveIconImage(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
    },
  });
  unregisterWindowRoles.set(state.win, registerWindowRole(state.win, 'floating'));

  // Development builds need an explicit dock icon; packaged builds accept the same call.
  if (process.platform === 'darwin') {
    try {
      const img = resolveIconImage();
      if (!img.isEmpty()) app.dock?.setIcon(img);
    } catch {
      // Dock presentation is optional.
    }
  }

  state.win.setAlwaysOnTop(
    state.alwaysOnTop,
    state.alwaysOnTop ? 'floating' : 'normal',
  );
  state.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Every asynchronous callback is fenced to the BrowserWindow generation that registered it.
  const capturedWin = state.win;
  installWindowNavigationPolicy(capturedWin.webContents, (url) =>
    shell.openExternal(url),
  );
  capturedWin.once('closed', () => {
    unregisterWindowRoles.get(capturedWin)?.();
    unregisterWindowRoles.delete(capturedWin);
    if (state.win !== capturedWin) return;
    stopInvalidateLoop(state);
    if (state.flashTimer) {
      clearInterval(state.flashTimer);
      state.flashTimer = null;
    }
    if (state.fallbackShowTimer) {
      clearTimeout(state.fallbackShowTimer);
      state.fallbackShowTimer = null;
    }
    state.win = null;
  });

  // Real load events show once and may recover a prior failure or fallback presentation.
  let shown = false;
  const showOnce = (): boolean => {
    if (shown || state.win !== capturedWin || capturedWin.isDestroyed()) {
      return false;
    }
    shown = true;
    capturedWin.show();
    return true;
  };
  const observeSuccessfulLoad = (): void => {
    if (state.win !== capturedWin || capturedWin.isDestroyed()) return;
    showOnce();
    observeWindowLoadState('healthy');
  };
  capturedWin.once('ready-to-show', observeSuccessfulLoad);
  capturedWin.webContents.once('did-finish-load', observeSuccessfulLoad);

  // Transparent windows occasionally miss readiness events, so retain the exact fallback timer.
  const fallbackTimer = setTimeout(() => {
    if (showOnce()) observeWindowLoadState('fallback-show');
    if (state.fallbackShowTimer === fallbackTimer) {
      state.fallbackShowTimer = null;
    }
  }, FALLBACK_SHOW_THRESHOLD_MS);
  state.fallbackShowTimer = fallbackTimer;

  capturedWin.webContents.on('did-fail-load', () => {
    if (state.win !== capturedWin || capturedWin.isDestroyed()) return;
    observeWindowLoadState('renderer-load-failed');
  });
  capturedWin.webContents.on('preload-error', () => {
    if (state.win !== capturedWin || capturedWin.isDestroyed()) return;
    observeWindowLoadState('preload-load-failed');
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    state.win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    state.win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  // Keep painting responsive while a transparent or pinned window is behind another app.
  state.win.webContents.setBackgroundThrottling(false);

  // Reapply the persisted transparency choice for recreated macOS windows.
  if (process.platform === 'darwin') {
    state.win.setVibrancy(
      state.windowTransparent ? null : 'under-window',
    );
  }

  // A new native window starts in the default non-compact geometry.
  state.compact = false;
  state.preferredSize = null;
  state.lastNormalSize = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  state.lastToggleAt = 0;

  return state.win;
}

/** Close the current window and release timers and callback references owned by its state. */
export function closeImpl(state: FloatingWindowState): void {
  parkAllBrowserViews();
  stopInvalidateLoop(state);
  if (state.flashTimer) {
    clearInterval(state.flashTimer);
    state.flashTimer = null;
  }
  if (state.fallbackShowTimer) {
    clearTimeout(state.fallbackShowTimer);
    state.fallbackShowTimer = null;
  }
  state.win?.close();
  state.win = null;
  state.emitCompactChanged = null;
}
