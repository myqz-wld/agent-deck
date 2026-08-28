import { AsyncNotificationQueue } from './async-notification-queue';
import type { CodexAppServerClient } from './client';
import {
  classifyTerminalForTurn,
  getNotificationThreadId,
  getNotificationTurnId,
} from './notification-helpers';
import type {
  CodexAppServerNotification,
  CodexAppServerStreamEvent,
} from './protocol';
import type { CodexRuntimeIdentityTracker } from './runtime-identity';

const ACCEPTANCE_TIMEOUT_MS = 30_000;

/** Stream one app-server control operation that owns a normal turn lifecycle. */
export async function* streamCodexThreadControlTurn(input: {
  client: CodexAppServerClient;
  method: 'thread/compact/start';
  threadId: string;
  runtimeIdentity: CodexRuntimeIdentityTracker;
  setActiveTurnId(turnId: string | null): void;
}): AsyncIterable<CodexAppServerStreamEvent> {
  const queue = new AsyncNotificationQueue<CodexAppServerNotification>();
  const generation = input.client.generation;
  let activeTurnId: string | null = null;
  let terminalSeen = false;
  let acceptanceTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    queue.throw(new Error(`Codex ${input.method} did not start a turn within 30 seconds`));
  }, ACCEPTANCE_TIMEOUT_MS);
  acceptanceTimer.unref();
  const clearAcceptanceTimer = (): void => {
    if (!acceptanceTimer) return;
    clearTimeout(acceptanceTimer);
    acceptanceTimer = null;
  };
  const unsubscribe = input.client.subscribe((notification) => {
    if (!input.client.acceptsNotificationForGeneration(generation)) return;
    const notificationThreadId = getNotificationThreadId(notification);
    if (notificationThreadId && notificationThreadId !== input.threadId) return;
    const notificationTurnId = getNotificationTurnId(notification);
    if (notification.method === 'turn/started') {
      if (!notificationTurnId || activeTurnId && notificationTurnId !== activeTurnId) return;
      activeTurnId = notificationTurnId;
      input.setActiveTurnId(notificationTurnId);
      clearAcceptanceTimer();
    }
    if (activeTurnId && notificationTurnId && notificationTurnId !== activeTurnId) return;
    const terminal = classifyTerminalForTurn(notification, activeTurnId);
    if (terminal === 'other-turn' || terminal === 'retrying') return;
    if (terminal === 'malformed' || terminal === 'unattributed-completion') {
      queue.throw(new Error(`Codex ${input.method} returned a malformed terminal notification`));
      return;
    }
    input.runtimeIdentity.observeNotification(notification);
    queue.push(notification);
    if (terminal === 'terminal') {
      terminalSeen = true;
      input.setActiveTurnId(null);
      queue.close();
    }
  });

  try {
    await input.client.request(input.method, { threadId: input.threadId });
    for await (const notification of queue) {
      yield {
        type: 'server.notification',
        notification,
        runtimeIdentity: input.runtimeIdentity.snapshot(),
      };
    }
  } finally {
    clearAcceptanceTimer();
    unsubscribe();
    input.setActiveTurnId(null);
    if (activeTurnId && !terminalSeen && input.client.isProcessAlive) {
      await input.client.request('turn/interrupt', {
        threadId: input.threadId,
        turnId: activeTurnId,
      }).catch(() => undefined);
    }
  }
}
