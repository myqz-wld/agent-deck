import type {
  TrustedContinuationAcceptance,
  TrustedContinuationSessionCandidate,
} from '@main/adapters/trusted-continuation';
import log from '@main/utils/logger';
import type { TrustedContinuationInitialTurn } from '../continuation-context/initial-turn';

export const HANDOFF_TRUSTED_CONTINUATION_DEADLINE_MS = 90_000;
const logger = log.scope('handoff-readiness');

export type HandOffSuccessorCleanup = 'ok' | 'failed' | 'pending';

export type HandOffTrustedContinuationFailureReason =
  | 'target-startup-timeout'
  | 'target-retry-startup-failed'
  | 'target-acceptance-timeout'
  | 'target-context-rejected'
  | 'target-provider-rejected'
  | 'target-rollback-failed'
  | 'target-retry-rejected';

export class TrustedContinuationGateFailure extends Error {
  constructor(
    message: string,
    readonly successorSessionId: string | null,
    readonly successorCleanup: HandOffSuccessorCleanup,
    readonly reason: HandOffTrustedContinuationFailureReason,
    readonly usedLowerBudgetRetry: boolean,
  ) {
    super(message);
    this.name = 'TrustedContinuationGateFailure';
  }
}

export interface SelectTrustedContinuationCandidateInput {
  capacityStatus: 'observed' | 'stale' | 'unknown';
  primaryTurn: TrustedContinuationInitialTurn;
  lowerBudgetRetryTurn: TrustedContinuationInitialTurn | null;
  createCandidate: (
    turn: TrustedContinuationInitialTurn,
  ) => Promise<TrustedContinuationSessionCandidate>;
  rollbackRejectedCandidate: (sessionId: string) => Promise<void>;
  closeCandidateBestEffort: (sessionId: string) => Promise<void>;
  deadlineMs?: number;
  now?: () => number;
}

export interface SelectedTrustedContinuationCandidate {
  candidate: TrustedContinuationSessionCandidate;
  usedLowerBudgetRetry: boolean;
}

class ReadinessDeadlineError extends Error {
  constructor() {
    super('Trusted continuation readiness deadline expired');
    this.name = 'ReadinessDeadlineError';
  }
}

export async function selectTrustedContinuationCandidate(
  input: SelectTrustedContinuationCandidateInput,
): Promise<SelectedTrustedContinuationCandidate> {
  if (input.capacityStatus === 'observed') {
    return {
      candidate: await input.createCandidate(input.primaryTurn),
      usedLowerBudgetRetry: false,
    };
  }

  const now = input.now ?? Date.now;
  const deadlineAt = now() + (input.deadlineMs ?? HANDOFF_TRUSTED_CONTINUATION_DEADLINE_MS);
  const primary = await createBeforeDeadline(
    input, input.primaryTurn, deadlineAt, now, false,
  );
  const primaryAcceptance = await acceptanceBeforeDeadline(
    primary,
    input.closeCandidateBestEffort,
    deadlineAt,
    now,
    false,
  );
  if (primaryAcceptance.status === 'accepted') {
    return { candidate: primary, usedLowerBudgetRetry: false };
  }
  if (primaryAcceptance.reason !== 'context-window-exceeded') {
    return failRejectedCandidate(
      input, primary, 'target-provider-rejected', false, deadlineAt, now,
    );
  }
  try {
    await beforeDeadline(
      input.rollbackRejectedCandidate(primary.sessionId),
      deadlineAt,
      now,
    );
  } catch {
    throw new TrustedContinuationGateFailure(
      'The primary trusted continuation was rejected and rollback cleanup could not be proved',
      primary.sessionId,
      'failed',
      'target-rollback-failed',
      false,
    );
  }
  if (!input.lowerBudgetRetryTurn) {
    throw new TrustedContinuationGateFailure(
      'The primary trusted continuation exceeded the target context window and no lower candidate was prepared',
      primary.sessionId,
      'ok',
      'target-context-rejected',
      false,
    );
  }
  if (deadlineAt - now() <= 0) {
    throw new TrustedContinuationGateFailure(
      'The primary trusted continuation was removed but the shared readiness deadline expired before retry startup',
      primary.sessionId,
      'ok',
      'target-acceptance-timeout',
      false,
    );
  }

  const retry = await createBeforeDeadline(
    input,
    input.lowerBudgetRetryTurn,
    deadlineAt,
    now,
    true,
  );
  const retryAcceptance = await acceptanceBeforeDeadline(
    retry,
    input.closeCandidateBestEffort,
    deadlineAt,
    now,
    true,
  );
  if (retryAcceptance.status === 'accepted') {
    return { candidate: retry, usedLowerBudgetRetry: true };
  }
  return failRejectedCandidate(
    input, retry, 'target-retry-rejected', true, deadlineAt, now,
  );
}

async function createBeforeDeadline(
  input: SelectTrustedContinuationCandidateInput,
  turn: TrustedContinuationInitialTurn,
  deadlineAt: number,
  now: () => number,
  usedLowerBudgetRetry: boolean,
): Promise<TrustedContinuationSessionCandidate> {
  if (deadlineAt - now() <= 0) throw preCreationDeadlineFailure();
  let creation: Promise<TrustedContinuationSessionCandidate>;
  try {
    creation = input.createCandidate(turn);
  } catch (error) {
    if (!usedLowerBudgetRetry) throw error;
    throw retryStartupFailure(error);
  }
  try {
    return await beforeDeadline(creation, deadlineAt, now);
  } catch (error) {
    if (error instanceof ReadinessDeadlineError) {
      scheduleLateCandidateCleanup(creation, input.closeCandidateBestEffort);
      throw startupTimeoutFailure(usedLowerBudgetRetry);
    }
    if (usedLowerBudgetRetry) throw retryStartupFailure(error);
    throw error;
  }
}

function preCreationDeadlineFailure(): TrustedContinuationGateFailure {
  return new TrustedContinuationGateFailure(
    'Trusted continuation readiness expired before candidate startup began',
    null,
    'ok',
    'target-startup-timeout',
    false,
  );
}

function startupTimeoutFailure(
  usedLowerBudgetRetry: boolean,
): TrustedContinuationGateFailure {
  return new TrustedContinuationGateFailure(
    'Trusted continuation startup exceeded the shared readiness deadline before a stable session id was available',
    null,
    'pending',
    'target-startup-timeout',
    usedLowerBudgetRetry,
  );
}

function retryStartupFailure(error: unknown): TrustedContinuationGateFailure {
  logger.warn(
    '[handoff readiness] lower-budget candidate creation rejected before a stable session id',
    error,
  );
  return new TrustedContinuationGateFailure(
    'The lower-budget trusted continuation could not start before yielding a stable session id',
    null,
    'ok',
    'target-retry-startup-failed',
    true,
  );
}

function scheduleLateCandidateCleanup(
  creation: Promise<TrustedContinuationSessionCandidate>,
  close: (sessionId: string) => Promise<void>,
): void {
  void creation.then(
    async (late) => {
      try {
        await close(late.sessionId);
        logger.warn(
          `[handoff readiness] late startup candidate cleanup session=${late.sessionId} cleanup=ok`,
        );
      } catch (error) {
        logger.warn(
          `[handoff readiness] late startup candidate cleanup session=${late.sessionId} cleanup=failed`,
          error,
        );
      }
    },
    (error) => {
      logger.warn('[handoff readiness] candidate creation rejected after startup deadline', error);
    },
  );
}

async function acceptanceBeforeDeadline(
  candidate: TrustedContinuationSessionCandidate,
  close: (sessionId: string) => Promise<void>,
  deadlineAt: number,
  now: () => number,
  usedLowerBudgetRetry: boolean,
): Promise<TrustedContinuationAcceptance> {
  try {
    return await beforeDeadline(candidate.acceptance, deadlineAt, now);
  } catch (error) {
    if (!(error instanceof ReadinessDeadlineError)) throw error;
    const cleanup = await closeBestEffort(close, candidate.sessionId, deadlineAt, now);
    throw new TrustedContinuationGateFailure(
      'The trusted continuation produced no native model activity before the readiness deadline',
      candidate.sessionId,
      cleanup,
      'target-acceptance-timeout',
      usedLowerBudgetRetry,
    );
  }
}

async function failRejectedCandidate(
  input: SelectTrustedContinuationCandidateInput,
  candidate: TrustedContinuationSessionCandidate,
  reason: HandOffTrustedContinuationFailureReason,
  usedLowerBudgetRetry: boolean,
  deadlineAt: number,
  now: () => number,
): Promise<never> {
  const cleanup = await closeBestEffort(
    input.closeCandidateBestEffort,
    candidate.sessionId,
    deadlineAt,
    now,
  );
  throw new TrustedContinuationGateFailure(
    'The trusted continuation was rejected before native model activity',
    candidate.sessionId,
    cleanup,
    reason,
    usedLowerBudgetRetry,
  );
}

async function closeBestEffort(
  close: (sessionId: string) => Promise<void>,
  sessionId: string,
  deadlineAt: number,
  now: () => number,
): Promise<'ok' | 'failed'> {
  try {
    await beforeDeadline(close(sessionId), deadlineAt, now);
    return 'ok';
  } catch {
    return 'failed';
  }
}

async function beforeDeadline<T>(
  work: Promise<T>,
  deadlineAt: number,
  now: () => number,
): Promise<T> {
  const remainingMs = deadlineAt - now();
  if (remainingMs <= 0) {
    void work.catch(() => undefined);
    throw new ReadinessDeadlineError();
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ReadinessDeadlineError()), remainingMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
