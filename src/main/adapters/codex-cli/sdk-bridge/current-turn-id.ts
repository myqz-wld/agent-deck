import type { InternalSession } from './types';
import type { CodexAppServerNotification } from '../app-server/client';
import { getNotificationTurnId } from '../app-server/notification-helpers';

export function trackCodexCurrentTurnId(
  internal: InternalSession,
  notification: CodexAppServerNotification,
): void {
  if (notification.method === 'turn/started') {
    const turnId = getNotificationTurnId(notification);
    if (turnId) internal.currentTurnId = turnId;
    return;
  }
  if (notification.method === 'turn/completed') {
    const turnId = getNotificationTurnId(notification);
    if (!turnId || turnId === internal.currentTurnId) {
      internal.currentTurnId = null;
    }
    return;
  }
  if (notification.method === 'error') {
    const params = notification.params as { willRetry?: unknown; turnId?: unknown } | undefined;
    if (params?.willRetry === true) return;
    const turnId = typeof params?.turnId === 'string' ? params.turnId : null;
    if (!turnId || turnId === internal.currentTurnId) {
      internal.currentTurnId = null;
    }
  }
}
