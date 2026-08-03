import type {
  SessionHandOffCommitResponse,
  SessionHandOffCommitResult,
} from '@shared/types';
import { HandOffExecutionError } from '@main/session/hand-off/executor';
import { TrustedContinuationStartupFailure } from '@main/session/hand-off/trusted-continuation-gate';

/** Keep stable orphan identity/details when Electron serializes a UI handoff response. */
export async function serializeSessionHandOffCommit(
  commit: () => Promise<SessionHandOffCommitResult>,
): Promise<SessionHandOffCommitResponse> {
  try {
    return { status: 'success', ...(await commit()) };
  } catch (error) {
    if (error instanceof TrustedContinuationStartupFailure) {
      throw new Error(
        '目标 provider 未能在生成稳定会话前启动续接会话。源会话与续接内容均未改变，请重试。',
      );
    }
    if (!(error instanceof HandOffExecutionError)) throw error;
    return {
      status: 'execution-error',
      stage: error.stage,
      successorSessionId: error.successorSessionId,
      successorCleanup: error.successorCleanup,
      usedLowerBudgetRetry: error.usedLowerBudgetRetry,
      ...(error.cutoverReason ? { cutoverReason: error.cutoverReason } : {}),
      message: error.message,
    };
  }
}
