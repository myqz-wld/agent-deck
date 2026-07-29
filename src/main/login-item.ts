import { app } from 'electron';
import log from '@main/utils/logger';
import { safeDiagnostic } from '@main/utils/safe-diagnostic';
import { getProcessRunId } from '@main/utils/run-context';
import {
  BoundedLogStateTracker,
  type LogStateDecision,
  type LogStateSnapshot,
} from '@main/utils/log-state-tracker';

const LOGIN_ITEM_TRACKER_CAPACITY = 1;
const SUMMARY_INTERVAL_MS = 300_000;

type LoginItemOperation = 'login-item';
type LoginItemState = 'healthy' | 'read-failed' | 'approval-required';

function createLoginItemLogger(): ReturnType<typeof log.scope> | null {
  try {
    return log.scope('login-item');
  } catch {
    return null;
  }
}

function createLoginItemTracker(): BoundedLogStateTracker<
  LoginItemOperation,
  LoginItemState
> | null {
  try {
    return new BoundedLogStateTracker<LoginItemOperation, LoginItemState>({
      capacity: LOGIN_ITEM_TRACKER_CAPACITY,
      summaryIntervalMs: SUMMARY_INTERVAL_MS,
    });
  } catch {
    return null;
  }
}

const logger = createLoginItemLogger();
const loginItemTracker = createLoginItemTracker();

function observeLoginItemState(state: LoginItemState): void {
  if (!loginItemTracker) return;
  try {
    emitLoginItemDecision(
      loginItemTracker.observe('login-item', {
        signature: state,
        abnormal: state !== 'healthy',
      }),
    );
  } catch {
    // Login item diagnostics cannot alter OS synchronization.
  }
}

function emitLoginItemDecision(decision: LogStateDecision<LoginItemState>): void {
  if (decision.kind === 'repeat') return;
  if (decision.kind === 'initial' && !decision.current.abnormal) return;

  const priorAbnormal: LogStateSnapshot<LoginItemState> | null =
    decision.flushed?.abnormal ? decision.flushed : null;
  const aggregate = priorAbnormal ?? decision.current;
  try {
    const details = safeDiagnostic({
      event: 'login-item-state',
      runId: getProcessRunId(),
      operation: 'login-item',
      state: decision.current.signature,
      previousState: decision.flushed?.signature ?? null,
      transition: decision.kind,
      abnormalDurationMs: aggregate.abnormalDurationMs,
      suppressedCount: aggregate.suppressedCount,
      suppressedCountCapped: aggregate.suppressedCountCapped,
      summaryIntervalMs: SUMMARY_INTERVAL_MS,
    });
    if (decision.current.abnormal) {
      logger?.warn(
        decision.kind === 'periodic-summary'
          ? 'login item state remains degraded'
          : 'login item state degraded',
        details,
      );
    } else if (priorAbnormal) {
      logger?.info('login item state recovered', details);
    }
  } catch {
    // Serialization and logging remain best-effort.
  }
}

export interface LoginItemApp {
  getLoginItemSettings(options?: Electron.LoginItemSettingsOptions): Electron.LoginItemSettings;
  setLoginItemSettings(settings: Electron.Settings): void;
}

export type LoginItemSyncResult =
  | 'unsupported'
  | 'dev-skipped'
  | 'already-current'
  | 'updated';

const MAC_LOGIN_ITEM_OPTIONS = {
  type: 'mainAppService',
} satisfies Electron.LoginItemSettingsOptions;

function loginItemReadOptions(platform: NodeJS.Platform): Electron.LoginItemSettingsOptions | undefined {
  return platform === 'darwin' ? MAC_LOGIN_ITEM_OPTIONS : undefined;
}

function loginItemWriteSettings(
  openAtLogin: boolean,
  platform: NodeJS.Platform,
): Electron.Settings {
  if (platform === 'darwin') {
    return {
      openAtLogin,
      type: 'mainAppService',
    };
  }
  return { openAtLogin };
}

export function shouldUpdateLoginItem(
  openAtLogin: boolean,
  current: Electron.LoginItemSettings,
  platform: NodeJS.Platform,
): boolean {
  if (platform === 'darwin') {
    const status = current.status;
    if (openAtLogin) {
      if (status === 'enabled' || status === 'requires-approval') return false;
      if (status === 'not-registered' || status === 'not-found') return true;
      return !current.openAtLogin;
    }
    return status === 'enabled' || status === 'requires-approval' || current.openAtLogin;
  }
  return current.openAtLogin !== openAtLogin;
}

/**
 * Sync Agent Deck's login item setting with the OS, but avoid writing when the OS
 * already reflects the requested state. On macOS 13+, repeated writes while the
 * main app service is already enabled or waiting for approval can surface as
 * duplicate rows in System Settings > Login Items.
 */
export function syncLoginItemSetting(
  openAtLogin: boolean,
  opts: {
    app?: LoginItemApp;
    dev?: boolean;
    platform?: NodeJS.Platform;
  } = {},
): LoginItemSyncResult {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'win32') return 'unsupported';
  if (opts.dev === true) return 'dev-skipped';

  const electronApp = opts.app ?? app;
  let current: Electron.LoginItemSettings | null = null;
  let readFailed = false;
  try {
    current = electronApp.getLoginItemSettings(loginItemReadOptions(platform));
  } catch {
    readFailed = true;
    observeLoginItemState('read-failed');
  }

  if (current && !shouldUpdateLoginItem(openAtLogin, current, platform)) {
    if (platform === 'darwin' && openAtLogin && current.status === 'requires-approval') {
      observeLoginItemState('approval-required');
    } else {
      observeLoginItemState('healthy');
    }
    return 'already-current';
  }

  electronApp.setLoginItemSettings(loginItemWriteSettings(openAtLogin, platform));
  if (!readFailed) observeLoginItemState('healthy');
  return 'updated';
}
