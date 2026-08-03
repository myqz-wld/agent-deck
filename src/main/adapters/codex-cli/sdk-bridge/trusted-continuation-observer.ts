import { isCodexModelActivity } from '../app-server/first-model-event-watchdog';
import {
  readTerminalError,
} from '../app-server/notification-helpers';
import type { CodexAppServerNotification } from '../app-server/client';
import type { InternalSession } from './types';

/** Observe only the accepted turn's native notifications; lifecycle/config/user echo is ignored. */
export function observeCodexTrustedContinuationNotification(
  internal: InternalSession,
  notification: CodexAppServerNotification,
): void {
  const acceptance = internal.trustedContinuationAcceptance;
  if (!acceptance) return;
  if (isCodexModelActivity(notification)) {
    delete internal.trustedContinuationAcceptance;
    acceptance.acceptModelActivity();
    return;
  }
  const terminalError = readTerminalError(notification);
  if (terminalError) {
    delete internal.trustedContinuationAcceptance;
    acceptance.reject(
      terminalError.codexErrorInfo === 'contextWindowExceeded'
        ? 'context-window-exceeded'
        : 'provider-error',
    );
    return;
  }
  if (notification.method === 'turn/completed') {
    delete internal.trustedContinuationAcceptance;
    acceptance.acceptModelActivity();
  }
}

export function rejectUnsettledCodexTrustedContinuation(internal: InternalSession): void {
  const acceptance = internal.trustedContinuationAcceptance;
  if (!acceptance) return;
  delete internal.trustedContinuationAcceptance;
  acceptance.reject('provider-error');
}
