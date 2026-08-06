import type { AgentEvent } from '@shared/types';
import {
  cancelClaudePendingAndEmitCore,
  runClaudeCloseSessionCleanupCore,
} from './pending-cancellation-core';
import {
  createDesktopClaudePendingCancellationHost,
  type ClaudePendingCancellationManagerPort,
} from './pending-cancellation-host';
import type { InternalSession } from './types';

export function cancelPendingAndEmit(
  internal: InternalSession,
  realIdForEmit: string,
  emit: (event: AgentEvent) => void,
  sessionManager: ClaudePendingCancellationManagerPort,
): void {
  cancelClaudePendingAndEmitCore(
    internal,
    realIdForEmit,
    emit,
    createDesktopClaudePendingCancellationHost(sessionManager),
  );
}

export function runCloseSessionCleanup(input: {
  sessions: Map<string, InternalSession>;
  internal: InternalSession;
  key: string;
  sessionId: string;
  emit: (event: AgentEvent) => void;
  markRecentlyDeleted?: boolean;
}, sessionManager: ClaudePendingCancellationManagerPort): void {
  runClaudeCloseSessionCleanupCore(
    input,
    createDesktopClaudePendingCancellationHost(sessionManager),
  );
}
