import type { PermissionMode } from '@main/adapters/types';
import type { SessionRecord } from '@shared/types';

export type ClaudeRestartSandbox = 'off' | 'workspace-write' | 'strict' | null;
export type ClaudeSessionRename = { from: string; to: string };

/** Desktop-owned persistence, publication, and diagnostic boundary for one Claude cold restart. */
export interface ClaudeRestartSessionHost {
  readSession(sessionId: string): SessionRecord | null;
  setPermissionModeAndPublish(sessionId: string, mode: PermissionMode): void;
  setSandboxAndPublish(sessionId: string, sandbox: ClaudeRestartSandbox): void;
  subscribeRenames(listener: (payload: ClaudeSessionRename) => void): () => void;
  warn(message: string, error: unknown): void;
}
