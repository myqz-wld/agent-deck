import type { AgentEvent } from '@shared/types';
import { sessionManager } from '@main/session/manager';
import { notifyUser } from './visual';
import log from '@main/utils/logger';
import { safeDiagnostic } from '@main/utils/safe-diagnostic';
import { getProcessRunId } from '@main/utils/run-context';
import {
  BoundedLogStateTracker,
  type LogStateDecision,
  type LogStateSnapshot,
} from '@main/utils/log-state-tracker';

const ROUTER_TRACKER_CAPACITY = 2;
const SUMMARY_INTERVAL_MS = 300_000;

type NotificationOperation = 'waiting-for-user' | 'finished';
type NotificationState = 'healthy' | 'notification-failed';

function createRouterLogger(): ReturnType<typeof log.scope> | null {
  try {
    return log.scope('notify-event-router');
  } catch {
    return null;
  }
}

function createRouterTracker(): BoundedLogStateTracker<
  NotificationOperation,
  NotificationState
> | null {
  try {
    return new BoundedLogStateTracker<NotificationOperation, NotificationState>({
      capacity: ROUTER_TRACKER_CAPACITY,
      summaryIntervalMs: SUMMARY_INTERVAL_MS,
    });
  } catch {
    return null;
  }
}

const logger = createRouterLogger();
const routerTracker = createRouterTracker();

function observeNotificationState(
  operation: NotificationOperation,
  state: NotificationState,
): void {
  if (!routerTracker) return;
  let decision: LogStateDecision<NotificationState>;
  try {
    decision = routerTracker.observe(operation, {
      signature: state,
      abnormal: state !== 'healthy',
    });
    emitNotificationDecision(operation, decision);
  } catch {
    return;
  }
}

function emitNotificationDecision(
  operation: NotificationOperation,
  decision: LogStateDecision<NotificationState>,
): void {
  if (decision.kind === 'repeat') return;
  if (decision.kind === 'initial' && !decision.current.abnormal) return;

  const priorAbnormal: LogStateSnapshot<NotificationState> | null =
    decision.flushed?.abnormal ? decision.flushed : null;
  const aggregate = priorAbnormal ?? decision.current;
  try {
    const details = safeDiagnostic({
      event: 'notification-routing-state',
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
          ? 'notification routing remains degraded'
          : 'notification routing degraded',
        details,
      );
    } else if (priorAbnormal) {
      logger?.info('notification routing recovered', details);
    }
  } catch {
    // Diagnostics cannot alter event routing.
  }
}

/**
 * Route user-attention events after ingestion. Notification failures remain isolated from the
 * adapter event stream, and cancellation events never create replacement notifications.
 */
export function routeEventToNotification(event: AgentEvent): void {
  let operation: NotificationOperation | null = null;
  try {
    if (event.kind === 'waiting-for-user') {
      operation = 'waiting-for-user';
      const payload = (event.payload ?? {}) as { type?: string; message?: string };
      const type = payload.type;
      if (typeof type === 'string' && type.endsWith('-cancelled')) {
        return;
      }
      const session = sessionManager.get(event.sessionId);
      notifyUser({
        title: 'Agent 等待你的输入',
        body: session ? `${session.title}：${payload.message ?? ''}` : '',
        level: 'waiting',
      });
      observeNotificationState(operation, 'healthy');
      return;
    }

    if (event.kind === 'finished') {
      const payload = (event.payload ?? {}) as {
        ok?: boolean;
        subtype?: string;
        expectedWorktreeTransition?: unknown;
      };
      if (payload.expectedWorktreeTransition) return;
      operation = 'finished';
      const session = sessionManager.get(event.sessionId);
      const isError = payload.ok === false;
      const subtype = payload.subtype;
      const title = isError
        ? subtype === 'interrupted'
          ? 'Agent 已中断'
          : 'Agent 出错'
        : 'Agent 完成';
      notifyUser({
        title,
        body: session?.title ?? '',
        level: 'finished',
      });
      observeNotificationState(operation, 'healthy');
    }
  } catch {
    if (operation) observeNotificationState(operation, 'notification-failed');
  }
}
