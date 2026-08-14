// Bootstrap wiring creates the floating window, bridges events to the renderer, registers
// shortcuts, and schedules initial CLI handling. Listener failures stay inside their established
// swallow boundaries so synchronous event emitters cannot be disrupted.

import { globalShortcut } from 'electron';

import { ensureFocusableOnActivate, getFloatingWindow } from '../window';
import { eventBus } from '../event-bus';
import { sessionManager } from '../session/manager';
import { notifyUser } from '../notify/visual';
import { handleCliArgv } from '../cli';
import { rememberSessionFocusRequest } from '../session-focus-request';
import { IpcEvent } from '@shared/ipc-channels';
import type { AppSettings } from '@shared/types/settings/app-settings';

import { makeDebouncedKeyedSender, makeSafeSend, TOOL_DISPLAY_NAME } from './_deps';
import log from '@main/utils/logger';
import { safeDiagnostic } from '@main/utils/safe-diagnostic';
import { getProcessRunId } from '@main/utils/run-context';
import {
  BoundedLogStateTracker,
  type LogStateDecision,
  type LogStateSnapshot,
} from '@main/utils/log-state-tracker';

const WIRING_TRACKER_CAPACITY = 8;
const SUMMARY_INTERVAL_MS = 300_000;

type WiringOperation = 'session-projection' | 'archive-dispatch';
type WiringState =
  | 'healthy'
  | 'session-projection-failed'
  | 'archive-notification-failed'
  | 'archive-ipc-failed'
  | 'archive-dispatch-failed';

function createWiringLogger(): ReturnType<typeof log.scope> | null {
  try {
    return log.scope('bootstrap-wiring');
  } catch {
    return null;
  }
}

function createWiringTracker(): BoundedLogStateTracker<WiringOperation, WiringState> | null {
  try {
    return new BoundedLogStateTracker<WiringOperation, WiringState>({
      capacity: WIRING_TRACKER_CAPACITY,
      summaryIntervalMs: SUMMARY_INTERVAL_MS,
    });
  } catch {
    return null;
  }
}

const logger = createWiringLogger();
const wiringTracker = createWiringTracker();

function observeWiringState(operation: WiringOperation, state: WiringState): void {
  if (!wiringTracker) return;
  let decision: LogStateDecision<WiringState>;
  try {
    decision = wiringTracker.observe(operation, {
      signature: state,
      abnormal: state !== 'healthy',
    });
    emitWiringDecision(operation, decision);
  } catch {
    return;
  }
}

function emitWiringDecision(
  operation: WiringOperation,
  decision: LogStateDecision<WiringState>,
): void {
  if (decision.kind === 'repeat') return;
  if (decision.kind === 'initial' && !decision.current.abnormal) return;

  const priorAbnormal: LogStateSnapshot<WiringState> | null =
    decision.flushed?.abnormal ? decision.flushed : null;
  const aggregate = priorAbnormal ?? decision.current;
  try {
    const details = safeDiagnostic({
      event: 'bootstrap-event-bridge-state',
      runId: getProcessRunId(),
      operation,
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
          ? 'bootstrap event bridge remains degraded'
          : 'bootstrap event bridge degraded',
        details,
      );
    } else if (priorAbnormal) {
      logger?.info('bootstrap event bridge recovered', details);
    }
  } catch {
    // Diagnostics cannot alter event bridge behavior.
  }
}

function logShortcutRegistrationFailure(failedCount: number): void {
  const boundedFailedCount = Number.isFinite(failedCount)
    ? Math.min(4, Math.max(0, Math.trunc(failedCount)))
    : 0;
  if (boundedFailedCount === 0) return;
  try {
    logger?.warn(
      'shortcut registration failed',
      safeDiagnostic({
        event: 'shortcut-registration-failed',
        runId: getProcessRunId(),
        failedCount: boundedFailedCount,
      }),
    );
  } catch {
    // Shortcut diagnostics cannot alter registration or bootstrap behavior.
  }
}

/** Wire the initialized infrastructure to windows, IPC, notifications, and shortcuts. */
export function initWiring(settings: AppSettings): void {
  // Create the window before attaching event bridges that resolve it lazily through safeSend.
  const floating = getFloatingWindow();
  floating.create();
  floating.setWindowTransparent(settings.windowTransparent);
  // Apply both persisted window flags immediately so startup and dock recreation are consistent.
  floating.setAlwaysOnTop(settings.alwaysOnTop);
  const safeSend = makeSafeSend(() => floating.window);
  // Window size toggles use this callback to keep renderer compact state synchronized.
  floating.emitCompactChanged = (compact) => safeSend(IpcEvent.CompactToggled, compact);
  eventBus.on('agent-event', (e) => safeSend(IpcEvent.AgentEvent, e));
  // Team projection may touch storage, so failure is swallowed at the synchronous event boundary.
  eventBus.on('session-upserted', (s) => {
    try {
      safeSend(IpcEvent.SessionUpserted, sessionManager.enrichWithTeams(s));
      observeWiringState('session-projection', 'healthy');
    } catch {
      observeWiringState('session-projection', 'session-projection-failed');
    }
  });
  eventBus.on('session-removed', (id) => safeSend(IpcEvent.SessionRemoved, id));
  eventBus.on('session-renamed', (p) => safeSend(IpcEvent.SessionRenamed, p));
  eventBus.on('summary-added', (s) => safeSend(IpcEvent.SummaryAdded, s));
  eventBus.on('session-focus-request', (sid) => {
    rememberSessionFocusRequest(sid);
    safeSend(IpcEvent.SessionFocusRequest, sid);
  });

  // Mutable task, issue, and token projections trigger renderer refreshes.
  eventBus.on('task-changed', (p) => safeSend(IpcEvent.TaskChanged, p));
  eventBus.on('issue-changed', (p) => safeSend(IpcEvent.IssueChanged, p));
  eventBus.on('token-usage-changed', (p) => safeSend(IpcEvent.TokenUsageChanged, p));
  // Rate ticks are display-only and do not represent persisted token usage.
  eventBus.on('token-rate-tick', (p) => safeSend(IpcEvent.TokenRateTick, p));

  // Archive failure notification and renderer IPC are independent channels. Their combined
  // outcome is observed once, and neither channel failure may escape the synchronous listener.
  eventBus.on('caller-archive-failed', (payload) => {
    try {
      const shortSid = payload.sessionId.slice(0, 8);
      const toolDisplay = TOOL_DISPLAY_NAME[payload.toolName];
      let body: string;
      if (payload.reasonKind === 'archive-throw') {
        body = `原会话未归档,可重试归档(${shortSid}…,工具:${toolDisplay})`;
      } else if (payload.reasonKind === 'probe-throw') {
        body = `数据库异常无法探针原会话,可稍后重试归档(${shortSid}…,工具:${toolDisplay})`;
      } else {
        body = `原会话记录不可用,归档未完成(${shortSid}…,工具:${toolDisplay})`;
      }
      let notificationFailed = false;
      let ipcFailed = false;
      try {
        notifyUser({
          title: 'Agent Deck 归档失败',
          body,
          level: 'info',
        });
      } catch {
        notificationFailed = true;
      }
      try {
        safeSend(IpcEvent.CallerArchiveFailed, payload);
      } catch {
        ipcFailed = true;
      }
      const state: WiringState =
        notificationFailed && ipcFailed
          ? 'archive-dispatch-failed'
          : notificationFailed
            ? 'archive-notification-failed'
            : ipcFailed
              ? 'archive-ipc-failed'
              : 'healthy';
      observeWiringState('archive-dispatch', state);
    } catch {
      observeWiringState('archive-dispatch', 'archive-dispatch-failed');
    }
  });

  // Message identity, not optional team membership, determines debounce grouping.
  const messageChangedSender = makeDebouncedKeyedSender<{ kind: string; teamId: string | null; messageId: string; payload: unknown }>(
    IpcEvent.AgentDeckMessageChanged,
    safeSend,
    (item) => `${item.kind}:${item.messageId}`,
  );
  eventBus.on('agent-deck-message-enqueued', (p) =>
    messageChangedSender({ kind: 'enqueued', teamId: p.teamId, messageId: p.id, payload: p }),
  );
  eventBus.on('agent-deck-message-status-changed', (p) =>
    messageChangedSender({ kind: 'status-changed', teamId: p.teamId, messageId: p.id, payload: p }),
  );
  // Purges use one fixed synthetic message key because they span teams and have no row identity.
  eventBus.on('agent-deck-message-purged', (p) =>
    messageChangedSender({ kind: 'purged', teamId: null, messageId: 'purged:gc', payload: p }),
  );

  ensureFocusableOnActivate();

  let failedShortcutCount = 0;

  // Pin and transparency shortcuts update live state and notify the renderer.
  const pinShortcut = 'CommandOrControl+Alt+P';
  const registered = globalShortcut.register(pinShortcut, () => {
    const w = floating.window;
    if (!w || w.isDestroyed()) return;
    const next = !w.isAlwaysOnTop();
    floating.setAlwaysOnTop(next);
    safeSend(IpcEvent.PinToggled, next);
  });
  if (!registered) {
    failedShortcutCount += 1;
  }

  const transparentShortcut = 'CommandOrControl+Alt+T';
  const transparentRegistered = globalShortcut.register(transparentShortcut, () => {
    const w = floating.window;
    if (!w || w.isDestroyed()) return;
    // The live floating-window field is authoritative between renderer persistence updates.
    const next = !floating.windowTransparent;
    floating.setWindowTransparent(next);
    safeSend(IpcEvent.TransparentToggled, next);
  });
  if (!transparentRegistered) {
    failedShortcutCount += 1;
  }

  // Size shortcuts toggle between remembered custom, maximum, and default dimensions.
  const maximizeShortcut = 'CommandOrControl+Alt+=';
  const maximizeRegistered = globalShortcut.register(maximizeShortcut, () => {
    floating.toggleMaximize();
  });
  if (!maximizeRegistered) {
    failedShortcutCount += 1;
  }

  const defaultSizeShortcut = 'CommandOrControl+Alt+-';
  const defaultSizeRegistered = globalShortcut.register(defaultSizeShortcut, () => {
    floating.toggleDefault();
  });
  if (!defaultSizeRegistered) {
    failedShortcutCount += 1;
  }
  logShortcutRegistrationFailure(failedShortcutCount);

  // CLI handling waits until synchronous wiring is complete.
  setImmediate(() => {
    void handleCliArgv(process.argv);
  });
}
