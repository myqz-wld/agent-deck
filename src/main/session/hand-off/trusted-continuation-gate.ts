import type {
  TrustedContinuationAcceptance,
  TrustedContinuationSessionCandidate,
} from '@main/adapters/trusted-continuation';
import type { SessionHandOffTrustedContinuationFailureReason } from '@shared/session-hand-off-execution';
import type { TrustedContinuationInitialTurn } from '../continuation-context/initial-turn';
import { reportHandOffWarning } from './diagnostics-core';

/** Platform-monotonic runtime budget; wall-clock changes do not affect it. */
export const HANDOFF_TRUSTED_CONTINUATION_DEADLINE_MS = 90_000;
const LATE_CANDIDATE_CLEANUP_MAX_ATTEMPTS = 3;
const REJECTED_CANDIDATE_CLEANUP_DEADLINE_MS = 5_000;

export type HandOffSuccessorCleanup = 'ok' | 'failed' | 'pending';

export type HandOffTrustedContinuationFailureReason =
  SessionHandOffTrustedContinuationFailureReason;

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

/** Safe pre-spawn failure: no stable id exists, so UI may retain its one-shot retry lease. */
export class TrustedContinuationStartupFailure extends Error {
  constructor() {
    super('Trusted continuation successor failed to start before yielding a stable session id');
    this.name = 'TrustedContinuationStartupFailure';
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
  /** Injectable monotonic clock for deterministic deadline tests. */
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

class PostDeadlineWorkRejectionError extends ReadinessDeadlineError {
  constructor(readonly rejection: unknown) {
    super();
    this.name = 'PostDeadlineWorkRejectionError';
  }
}

export async function selectTrustedContinuationCandidate(
  input: SelectTrustedContinuationCandidateInput,
): Promise<SelectedTrustedContinuationCandidate> {
  const now = input.now ?? (() => Math.floor(performance.now()));
  const deadlineAt = now() + (input.deadlineMs ?? HANDOFF_TRUSTED_CONTINUATION_DEADLINE_MS);
  const lowerBudgetRetryTurn = input.lowerBudgetRetryTurn;
  const primary = await createBeforeDeadline(
    input, input.primaryTurn, deadlineAt, now, false,
  );
  const primaryAcceptance = await acceptanceBeforeDeadline(
    input,
    primary,
    deadlineAt,
    now,
    false,
  );
  if (primaryAcceptance.status === 'accepted') {
    return { candidate: primary, usedLowerBudgetRetry: false };
  }
  if (primaryAcceptance.reason !== 'context-window-exceeded') {
    return failRejectedCandidate(
      input, primary, 'target-provider-rejected', false, now,
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
  if (!lowerBudgetRetryTurn) {
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
    lowerBudgetRetryTurn,
    deadlineAt,
    now,
    true,
  );
  const retryAcceptance = await acceptanceBeforeDeadline(
    input,
    retry,
    deadlineAt,
    now,
    true,
  );
  if (retryAcceptance.status === 'accepted') {
    return { candidate: retry, usedLowerBudgetRetry: true };
  }
  return failRejectedCandidate(
    input, retry, 'target-retry-rejected', true, now,
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
    if (!usedLowerBudgetRetry) throw primaryStartupFailure(error);
    throw retryStartupFailure(error);
  }
  try {
    return await beforeDeadline(creation, deadlineAt, now);
  } catch (error) {
    if (error instanceof PostDeadlineWorkRejectionError) {
      if (usedLowerBudgetRetry) throw retryStartupFailure(error.rejection);
      throw startupRejectedAfterDeadlineFailure(error.rejection);
    }
    if (error instanceof ReadinessDeadlineError) {
      scheduleLateCandidateCleanup(
        creation,
        input.rollbackRejectedCandidate,
        input.closeCandidateBestEffort,
        now,
      );
      throw startupTimeoutFailure(usedLowerBudgetRetry);
    }
    if (usedLowerBudgetRetry) throw retryStartupFailure(error);
    throw primaryStartupFailure(error);
  }
}

function primaryStartupFailure(error: unknown): TrustedContinuationStartupFailure {
  reportHandOffWarning(
    '[handoff readiness] primary candidate creation rejected before a stable session id',
    error,
  );
  return new TrustedContinuationStartupFailure();
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

function startupRejectedAfterDeadlineFailure(error: unknown): TrustedContinuationGateFailure {
  reportHandOffWarning(
    '[handoff readiness] primary candidate creation rejected after the startup deadline',
    error,
  );
  return new TrustedContinuationGateFailure(
    'Trusted continuation startup rejected after the shared readiness deadline without yielding a stable session id',
    null,
    'ok',
    'target-startup-timeout',
    false,
  );
}

function retryStartupFailure(error: unknown): TrustedContinuationGateFailure {
  reportHandOffWarning(
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
  rollback: (sessionId: string) => Promise<void>,
  close: (sessionId: string) => Promise<void>,
  now: () => number,
): void {
  void creation.then(
    (late) => cleanupLateCandidateWithRetry(late.sessionId, rollback, close, now),
    (error) => {
      reportHandOffWarning(
        '[handoff readiness] candidate creation rejected after startup deadline',
        error,
      );
    },
  );
}

async function cleanupLateCandidateWithRetry(
  sessionId: string,
  rollback: (sessionId: string) => Promise<void>,
  close: (sessionId: string) => Promise<void>,
  now: () => number,
): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= LATE_CANDIDATE_CLEANUP_MAX_ATTEMPTS; attempt += 1) {
    try {
      await beforeDeadline(
        rollback(sessionId),
        now() + REJECTED_CANDIDATE_CLEANUP_DEADLINE_MS,
        now,
      );
      reportHandOffWarning(
        `[handoff readiness] late startup candidate cleanup session=${sessionId} ` +
        `cleanup=removed attempt=${attempt}`,
      );
      return;
    } catch (error) {
      lastError = error;
    }
  }
  const closeResult = await closeBestEffort(
    close,
    sessionId,
    now() + REJECTED_CANDIDATE_CLEANUP_DEADLINE_MS,
    now,
  );
  if (closeResult === 'ok') {
    reportHandOffWarning(
      `[handoff readiness] late startup candidate cleanup session=${sessionId} ` +
      `cleanup=closed-row-retained rollbackAttempts=${LATE_CANDIDATE_CLEANUP_MAX_ATTEMPTS}`,
      lastError,
    );
    return;
  }
  reportHandOffWarning(
    `[handoff readiness] late startup candidate cleanup session=${sessionId} cleanup=failed ` +
    `rollbackAttempts=${LATE_CANDIDATE_CLEANUP_MAX_ATTEMPTS}`,
    lastError,
  );
}

async function acceptanceBeforeDeadline(
  input: SelectTrustedContinuationCandidateInput,
  candidate: TrustedContinuationSessionCandidate,
  deadlineAt: number,
  now: () => number,
  usedLowerBudgetRetry: boolean,
): Promise<TrustedContinuationAcceptance> {
  try {
    return await beforeDeadline(candidate.acceptance, deadlineAt, now);
  } catch (error) {
    if (!(error instanceof ReadinessDeadlineError)) throw error;
    const cleanup = await cleanupRejectedCandidate(input, candidate.sessionId, now);
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
  now: () => number,
): Promise<never> {
  const cleanup = await cleanupRejectedCandidate(input, candidate.sessionId, now);
  throw new TrustedContinuationGateFailure(
    'The trusted continuation was rejected before native model activity',
    candidate.sessionId,
    cleanup,
    reason,
    usedLowerBudgetRetry,
  );
}

async function cleanupRejectedCandidate(
  input: SelectTrustedContinuationCandidateInput,
  sessionId: string,
  now: () => number,
): Promise<'ok' | 'failed'> {
  const cleanupDeadlineAt = now() + REJECTED_CANDIDATE_CLEANUP_DEADLINE_MS;
  try {
    await beforeDeadline(
      input.rollbackRejectedCandidate(sessionId),
      cleanupDeadlineAt,
      now,
    );
    return 'ok';
  } catch {
    await closeBestEffort(
      input.closeCandidateBestEffort,
      sessionId,
      cleanupDeadlineAt,
      now,
    );
    return 'failed';
  }
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
  const checkedWork = work.then(
    (value) => {
      assertBeforeDeadline(deadlineAt, now);
      return value;
    },
    (error: unknown) => {
      if (deadlineAt - now() <= 0) {
        throw new PostDeadlineWorkRejectionError(error);
      }
      throw error;
    },
  );
  const remainingMs = deadlineAt - now();
  if (remainingMs <= 0) {
    return await Promise.race([checkedWork, deadlineAfterSettlementTag()]);
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      checkedWork,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ReadinessDeadlineError()), remainingMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function deadlineAfterSettlementTag(): Promise<never> {
  return Promise.resolve().then(() => {
    throw new ReadinessDeadlineError();
  });
}

function assertBeforeDeadline(deadlineAt: number, now: () => number): void {
  if (deadlineAt - now() <= 0) throw new ReadinessDeadlineError();
}
