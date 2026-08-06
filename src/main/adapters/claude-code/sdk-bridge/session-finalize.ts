import {
  finalizeClaudeSessionStartCore,
  type FinalizeClaudeSessionStartArgs,
} from './session-finalize-core';
import { createDesktopClaudeSessionFinalizeHost } from './session-finalize-host';
import type { ClaudeSessionManagerPort } from '../session-manager-core';

export type FinalizeSessionStartArgs = FinalizeClaudeSessionStartArgs;

export function finalizeSessionStart(
  input: FinalizeSessionStartArgs,
  sessionManager: Pick<ClaudeSessionManagerPort, 'updateCliSessionId'>,
): void {
  finalizeClaudeSessionStartCore(input, createDesktopClaudeSessionFinalizeHost(sessionManager));
}
