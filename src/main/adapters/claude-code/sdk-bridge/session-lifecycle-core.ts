import type { PermissionMode } from '@shared/types';

const CLOSE_STREAM_DRAIN_TIMEOUT_MS = 1_000;

export interface ClaudeLifecycleQuery {
  interrupt(): Promise<unknown>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
}

export interface ClaudeLifecycleSession {
  applicationSid: string;
  cliSessionId: string | null;
  query: ClaudeLifecycleQuery;
  streamDrained: Promise<void>;
  expectedClose?: boolean;
  retireRequested?: boolean;
  pendingUserMessages: unknown[];
  acceptedEnqueueFingerprints?: { clear(): void };
  permissionMode: PermissionMode;
  permissionModeChain?: Promise<unknown>;
}

export interface ClaudeLifecycleCleanupInput<Session, Emit> {
  sessions: Map<string, Session>;
  internal: Session;
  key: string;
  sessionId: string;
  emit: Emit;
  markRecentlyDeleted?: boolean;
}

export interface ClaudeSessionLifecycleHost<Session, Emit> {
  cleanupSession(input: ClaudeLifecycleCleanupInput<Session, Emit>): void;
  hasPersistedSession(sessionId: string): boolean;
  warn(message: string, error?: unknown): void;
  info(message: string): void;
}

export function findClaudeSessionCore<Session extends ClaudeLifecycleSession>(
  sessions: ReadonlyMap<string, Session>,
  sessionId: string,
): { key: string; internal: Session } | null {
  for (const [key, internal] of sessions) {
    if (
      key === sessionId
      || internal.cliSessionId === sessionId
      || internal.applicationSid === sessionId
    ) {
      return { key, internal };
    }
  }
  return null;
}

async function waitForStreamDrained<Session, Emit>(
  internal: ClaudeLifecycleSession,
  sessionId: string,
  host: ClaudeSessionLifecycleHost<Session, Emit>,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutToken = Symbol('timeout');
  const result = await Promise.race([
    internal.streamDrained.then(() => undefined),
    new Promise<typeof timeoutToken>((resolve) => {
      timeout = setTimeout(() => resolve(timeoutToken), CLOSE_STREAM_DRAIN_TIMEOUT_MS);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (result !== timeoutToken) return true;
  warnWithoutThrow(
    host,
    `[sdk-bridge] closeSession stream drain timed out after ${CLOSE_STREAM_DRAIN_TIMEOUT_MS}ms: ${sessionId}`,
  );
  return false;
}

export async function interruptClaudeSessionCore<
  Session extends ClaudeLifecycleSession,
  Emit,
>(
  sessions: ReadonlyMap<string, Session>,
  sessionId: string,
  host: ClaudeSessionLifecycleHost<Session, Emit>,
): Promise<void> {
  const resolved = findClaudeSessionCore(sessions, sessionId);
  if (!resolved) throw new Error('Claude 会话不在运行中，无法中断。');
  try {
    await resolved.internal.query.interrupt();
  } catch (error) {
    warnWithoutThrow(host, '[sdk-bridge] interrupt failed', error);
    throw error;
  }
}

export async function closeClaudeSessionCore<
  Session extends ClaudeLifecycleSession,
  Emit,
>(input: {
  sessions: Map<string, Session>;
  emit: Emit;
  sessionId: string;
  options: { markRecentlyDeleted?: boolean };
}, host: ClaudeSessionLifecycleHost<Session, Emit>): Promise<void> {
  const resolved = findClaudeSessionCore(input.sessions, input.sessionId);
  if (!resolved) return;
  const { internal, key } = resolved;
  internal.expectedClose = true;
  try {
    await internal.query.interrupt();
  } catch (error) {
    warnWithoutThrow(host, `[sdk-bridge] interrupt during close failed: ${input.sessionId}`, error);
  }
  host.cleanupSession({
    sessions: input.sessions,
    internal,
    key,
    sessionId: input.sessionId,
    emit: input.emit,
    markRecentlyDeleted: input.options.markRecentlyDeleted,
  });
  await waitForStreamDrained(internal, input.sessionId, host);
}

export async function closeClaudeSessionForRollbackCore<
  Session extends ClaudeLifecycleSession,
  Emit,
>(input: {
  sessions: Map<string, Session>;
  emit: Emit;
  sessionId: string;
}, host: ClaudeSessionLifecycleHost<Session, Emit>): Promise<void> {
  const resolved = findClaudeSessionCore(input.sessions, input.sessionId);
  if (!resolved) {
    throw new Error(`Claude rollback close cannot prove a live target runtime for ${input.sessionId}`);
  }
  const { internal, key } = resolved;
  const expectedCloseBefore = internal.expectedClose;
  internal.expectedClose = true;
  try {
    await internal.query.interrupt();
  } catch (error) {
    warnWithoutThrow(
      host,
      `[sdk-bridge] strict interrupt during close failed: ${input.sessionId}`,
      error,
    );
  }

  if (!(await waitForStreamDrained(internal, input.sessionId, host))) {
    internal.expectedClose = expectedCloseBefore;
    throw new Error(
      `Claude rollback close could not prove provider stream termination for ${input.sessionId}`,
    );
  }
  host.cleanupSession({
    sessions: input.sessions,
    internal,
    key,
    sessionId: input.sessionId,
    emit: input.emit,
  });
}

export function retireClaudeSessionAfterCurrentTurnCore<Session extends ClaudeLifecycleSession>(
  sessions: ReadonlyMap<string, Session>,
  sessionId: string,
): void {
  const resolved = findClaudeSessionCore(sessions, sessionId);
  if (!resolved) return;
  resolved.internal.retireRequested = true;
  resolved.internal.pendingUserMessages.length = 0;
  resolved.internal.acceptedEnqueueFingerprints?.clear();
}

export async function setClaudePermissionModeCore<
  Session extends ClaudeLifecycleSession,
  Emit,
>(input: {
  sessions: Map<string, Session>;
  sessionId: string;
  mode: PermissionMode;
}, host: ClaudeSessionLifecycleHost<Session, Emit>): Promise<void> {
  const session = input.sessions.get(input.sessionId);
  if (!session) {
    if (host.hasPersistedSession(input.sessionId)) {
      infoWithoutThrow(
        host,
        `[claude-bridge] setPermissionMode(${input.sessionId}, ${input.mode}) persisted with no live SDK query; `
          + 'next recovery/createSession will apply it',
      );
      return;
    }
    throw new Error(`session ${input.sessionId} not found`);
  }

  const previous = session.permissionModeChain ?? Promise.resolve();
  const next = previous.then(async () => {
    const oldMode = session.permissionMode;
    session.permissionMode = input.mode;
    try {
      await session.query.setPermissionMode(input.mode);
    } catch (error) {
      session.permissionMode = oldMode;
      throw error;
    }
  });
  session.permissionModeChain = next.catch(() => undefined);
  return next;
}

function warnWithoutThrow<Session, Emit>(
  host: ClaudeSessionLifecycleHost<Session, Emit>,
  message: string,
  error?: unknown,
): void {
  try {
    host.warn(message, error);
  } catch {
    // Diagnostics cannot change lifecycle authority.
  }
}

function infoWithoutThrow<Session, Emit>(
  host: ClaudeSessionLifecycleHost<Session, Emit>,
  message: string,
): void {
  try {
    host.info(message);
  } catch {
    // Diagnostics cannot change lifecycle authority.
  }
}
