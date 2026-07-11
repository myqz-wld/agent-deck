import { SessionRowMissingError } from '@main/store/session-repo';
import log from '@main/utils/logger';

const logger = log.scope('ipc-sessions-handoff');

export interface ArchiveSourceSessionDeps {
  archive: (sessionId: string) => Promise<void>;
  getSession: (sessionId: string) => unknown | null;
  emitArchiveFailed: (payload: {
    sessionId: string;
    toolName: 'SessionHandOffCommit';
    reason: string;
    reasonKind: 'row-missing' | 'probe-throw' | 'archive-throw';
  }) => void;
}

export type ArchiveSourceSessionResult =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      reasonKind: 'row-missing' | 'probe-throw' | 'archive-throw';
    };

/** Best-effort UI source archive with an actionable failure event and a fresh row probe. */
export async function archiveSourceSessionWithEmit(
  sessionId: string,
  deps: ArchiveSourceSessionDeps,
): Promise<ArchiveSourceSessionResult> {
  let row: unknown | null;
  try {
    row = deps.getSession(sessionId);
  } catch (error) {
    const reason = `probe getSession threw for ${sessionId}: ${
      error instanceof Error ? error.message : String(error)
    }`;
    logger.warn(`[ipc sessions hand-off] ${reason}`);
    deps.emitArchiveFailed({
      sessionId,
      toolName: 'SessionHandOffCommit',
      reason,
      reasonKind: 'probe-throw',
    });
    return { ok: false, reason, reasonKind: 'probe-throw' };
  }
  if (!row) {
    const reason = `cannot archive caller ${sessionId}: not in sessions table (createSession 期间被异常清理)`;
    logger.warn(`[ipc sessions hand-off] ${reason}`);
    deps.emitArchiveFailed({
      sessionId,
      toolName: 'SessionHandOffCommit',
      reason,
      reasonKind: 'row-missing',
    });
    return { ok: false, reason, reasonKind: 'row-missing' };
  }
  try {
    await deps.archive(sessionId);
  } catch (error) {
    const rowMissing = error instanceof SessionRowMissingError;
    const errorText = error instanceof Error ? error.message : String(error);
    const reason = rowMissing
      ? `cannot archive caller ${sessionId}: ${errorText} (race window: probe OK 后 setArchived no-op)`
      : `archive caller ${sessionId} failed: ${errorText}`;
    logger.warn(
      `[ipc sessions hand-off] ${
        rowMissing
          ? `archive source session ${sessionId} setArchived no-op (race window)`
          : `archive source session ${sessionId} failed`
      }:`,
      error,
    );
    deps.emitArchiveFailed({
      sessionId,
      toolName: 'SessionHandOffCommit',
      reason,
      reasonKind: rowMissing ? 'row-missing' : 'archive-throw',
    });
    return {
      ok: false,
      reason,
      reasonKind: rowMissing ? 'row-missing' : 'archive-throw',
    };
  }
  return { ok: true };
}
