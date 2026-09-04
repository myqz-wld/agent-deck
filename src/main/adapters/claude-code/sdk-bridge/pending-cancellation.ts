import type { AgentEvent } from '@shared/types';
import {
  runClaudeCloseSessionCleanupCore,
} from './pending-cancellation-core';
import {
  createDesktopClaudePendingCancellationHost,
  type ClaudePendingCancellationManagerPort,
} from './pending-cancellation-host';
import type { InternalSession } from './types';

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
