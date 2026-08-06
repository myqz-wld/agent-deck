import type { PermissionMode } from '@main/adapters/types';
import {
  closeClaudeSessionCore,
  closeClaudeSessionForRollbackCore,
  interruptClaudeSessionCore,
  retireClaudeSessionAfterCurrentTurnCore,
  setClaudePermissionModeCore,
} from './session-lifecycle-core';
import { createDesktopClaudeSessionLifecycleHost } from './session-lifecycle-host';
import type { ClaudePendingCancellationManagerPort } from './pending-cancellation-host';
import type { InternalSession, SdkBridgeOptions } from './types';

export async function interruptClaudeSession(
  sessions: Map<string, InternalSession>,
  sessionId: string,
  sessionManager: ClaudePendingCancellationManagerPort,
): Promise<void> {
  return interruptClaudeSessionCore(
    sessions,
    sessionId,
    createDesktopClaudeSessionLifecycleHost(sessionManager),
  );
}

export async function closeClaudeSession(input: {
  sessions: Map<string, InternalSession>;
  emit: SdkBridgeOptions['emit'];
  sessionId: string;
  options: { markRecentlyDeleted?: boolean };
}, sessionManager: ClaudePendingCancellationManagerPort): Promise<void> {
  return closeClaudeSessionCore(input, createDesktopClaudeSessionLifecycleHost(sessionManager));
}

export async function closeClaudeSessionForRollback(input: {
  sessions: Map<string, InternalSession>;
  emit: SdkBridgeOptions['emit'];
  sessionId: string;
}, sessionManager: ClaudePendingCancellationManagerPort): Promise<void> {
  return closeClaudeSessionForRollbackCore(
    input,
    createDesktopClaudeSessionLifecycleHost(sessionManager),
  );
}

export function retireClaudeSessionAfterCurrentTurn(
  sessions: Map<string, InternalSession>,
  sessionId: string,
): void {
  retireClaudeSessionAfterCurrentTurnCore(sessions, sessionId);
}

export async function setClaudePermissionMode(input: {
  sessions: Map<string, InternalSession>;
  sessionId: string;
  mode: PermissionMode;
}, sessionManager: ClaudePendingCancellationManagerPort): Promise<void> {
  return setClaudePermissionModeCore(
    input,
    createDesktopClaudeSessionLifecycleHost(sessionManager),
  );
}
