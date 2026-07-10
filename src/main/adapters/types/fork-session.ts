import type { CreateSessionOptions } from './create-session-opts';

/** Provider-neutral identity for the authenticated session being forked. */
export interface ForkSessionSource {
  applicationSessionId: string;
  nativeSessionId: string;
  cwd: string;
}

/**
 * A registered child session plus cleanup for failures in later MCP lifecycle steps.
 * Implementations must make discard idempotent and must never delete the source session.
 */
export interface ForkedSessionHandle {
  sessionId: string;
  discard(): Promise<void>;
}

export type ValidateForkSession = (
  source: ForkSessionSource,
  target: CreateSessionOptions,
) => Promise<void>;

export type CreateForkedSession = (
  source: ForkSessionSource,
  target: CreateSessionOptions,
) => Promise<ForkedSessionHandle>;
