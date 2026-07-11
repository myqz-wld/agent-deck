import type {
  SessionHandOffCommitResponse,
  SessionHandOffCommitResult,
} from '@shared/types';
import { HandOffExecutionError } from '@main/session/hand-off/executor';

/** Keep stable orphan identity/details when Electron serializes a UI handoff response. */
export async function serializeSessionHandOffCommit(
  commit: () => Promise<SessionHandOffCommitResult>,
): Promise<SessionHandOffCommitResponse> {
  try {
    return { status: 'success', ...(await commit()) };
  } catch (error) {
    if (!(error instanceof HandOffExecutionError)) throw error;
    return {
      status: 'execution-error',
      stage: error.stage,
      successorSessionId: error.successorSessionId,
      successorCleanup: error.successorCleanup,
      message: error.message,
    };
  }
}
