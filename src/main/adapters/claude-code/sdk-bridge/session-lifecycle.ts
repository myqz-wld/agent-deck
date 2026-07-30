import { sessionRepo } from '@main/store/session-repo';
import log from '@main/utils/logger';
import { runCloseSessionCleanup } from './pending-cancellation';
import type { InternalSession, SdkBridgeOptions } from './types';
import type { PermissionMode } from '@main/adapters/types';

const logger = log.scope('claude-bridge');
const CLOSE_STREAM_DRAIN_TIMEOUT_MS = 1_000;

function findClaudeSession(
  sessions: Map<string, InternalSession>,
  sessionId: string,
): { key: string; internal: InternalSession } | null {
  for (const [key, internal] of sessions) {
    if (
      key === sessionId ||
      internal.cliSessionId === sessionId ||
      internal.applicationSid === sessionId
    ) {
      return { key, internal };
    }
  }
  return null;
}

async function waitForStreamDrained(
  internal: InternalSession,
  sessionId: string,
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
  if (result === timeoutToken) {
    logger.warn(
      `[sdk-bridge] closeSession stream drain timed out after ${CLOSE_STREAM_DRAIN_TIMEOUT_MS}ms: ${sessionId}`,
    );
    return false;
  }
  return true;
}

export async function interruptClaudeSession(
  sessions: Map<string, InternalSession>,
  sessionId: string,
): Promise<void> {
  const resolved = findClaudeSession(sessions, sessionId);
  if (!resolved) throw new Error('Claude 会话不在运行中，无法中断。');
  try {
    await resolved.internal.query.interrupt();
  } catch (error) {
    logger.warn('[sdk-bridge] interrupt failed', error);
    throw error;
  }
}

export async function closeClaudeSession(input: {
  sessions: Map<string, InternalSession>;
  emit: SdkBridgeOptions['emit'];
  sessionId: string;
  options: { markRecentlyDeleted?: boolean };
}): Promise<void> {
  const resolved = findClaudeSession(input.sessions, input.sessionId);
  if (!resolved) return;
  const { internal, key } = resolved;

  // Abort wakes pending permission handlers. Marking the close as expected keeps this intentional
  // lifecycle transition from producing a red provider-stream error in the session timeline.
  internal.expectedClose = true;
  try {
    await internal.query?.interrupt?.();
  } catch (error) {
    logger.warn(`[sdk-bridge] interrupt during close failed: ${input.sessionId}`, error);
  }

  runCloseSessionCleanup({
    sessions: input.sessions,
    internal,
    key,
    sessionId: input.sessionId,
    emit: input.emit,
    markRecentlyDeleted: input.options.markRecentlyDeleted,
  });
  await waitForStreamDrained(internal, input.sessionId);
}

export async function closeClaudeSessionForRollback(input: {
  sessions: Map<string, InternalSession>;
  emit: SdkBridgeOptions['emit'];
  sessionId: string;
}): Promise<void> {
  const resolved = findClaudeSession(input.sessions, input.sessionId);
  if (!resolved) {
    throw new Error(`Claude rollback close cannot prove a live target runtime for ${input.sessionId}`);
  }
  const { internal, key } = resolved;
  const expectedCloseBefore = internal.expectedClose;
  internal.expectedClose = true;
  try {
    await internal.query?.interrupt?.();
  } catch (error) {
    logger.warn(`[sdk-bridge] strict interrupt during close failed: ${input.sessionId}`, error);
  }

  if (!(await waitForStreamDrained(internal, input.sessionId))) {
    internal.expectedClose = expectedCloseBefore;
    throw new Error(`Claude rollback close could not prove provider stream termination for ${input.sessionId}`);
  }

  runCloseSessionCleanup({
    sessions: input.sessions,
    internal,
    key,
    sessionId: input.sessionId,
    emit: input.emit,
  });
}

export function retireClaudeSessionAfterCurrentTurn(
  sessions: Map<string, InternalSession>,
  sessionId: string,
): void {
  const resolved = findClaudeSession(sessions, sessionId);
  if (!resolved) return;
  const { internal } = resolved;
  internal.retireRequested = true;
  internal.pendingUserMessages.length = 0;
  internal.acceptedEnqueueFingerprints?.clear();
}

export async function setClaudePermissionMode(input: {
  sessions: Map<string, InternalSession>;
  sessionId: string;
  mode: PermissionMode;
}): Promise<void> {
  const session = input.sessions.get(input.sessionId);
  if (!session) {
    if (sessionRepo.get(input.sessionId)) {
      logger.info(
        `[claude-bridge] setPermissionMode(${input.sessionId}, ${input.mode}) persisted with no live SDK query; ` +
          'next recovery/createSession will apply it',
      );
      return;
    }
    throw new Error(`session ${input.sessionId} not found`);
  }

  // Serialize optimistic live updates per session. The exposed promise preserves the provider
  // error, while the stored chain absorbs it so one failed update cannot poison later updates.
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
