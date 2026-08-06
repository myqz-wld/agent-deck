import type { RecoveryContinuationHost } from '@main/session/continuation-context/recovery-types';

/** Desktop-owned history, continuation-spool, and diagnostic boundary for recovery. */
export interface ClaudeRecoveryFreshnessHost extends RecoveryContinuationHost {
  latestConversationMessageTs(sessionId: string): number | null;
  warn(message: string, error?: unknown): void;
}
