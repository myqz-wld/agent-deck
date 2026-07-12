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

export interface FinalizeUiHandOffSourceDeps {
  markClosed: (sessionId: string) => void;
  close: (sessionId: string) => Promise<void>;
  archive: (sessionId: string) => Promise<ArchiveSourceSessionResult>;
}

/** Run every post-commit source cleanup step even when an earlier one fails. */
export async function finalizeUiHandOffSource(
  sessionId: string,
  deps: FinalizeUiHandOffSourceDeps,
): Promise<void> {
  const failures: string[] = [];
  try {
    deps.markClosed(sessionId);
  } catch (error) {
    failures.push(`标记源会话关闭失败：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await deps.close(sessionId);
  } catch (error) {
    failures.push(`关闭源会话失败：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const archiveResult = await deps.archive(sessionId);
    if (!archiveResult.ok) failures.push(`归档源会话失败：${archiveResult.reason}`);
  } catch (error) {
    failures.push(`归档源会话失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (failures.length > 0) throw new Error(failures.join('；'));
}

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
