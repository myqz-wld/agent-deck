import log from '@main/utils/logger';
import { findSessionHandOffSuccessor } from '@main/store/session-handoff-alias-repo';

const logger = log.scope('handoff-cutover');
const HANDOFF_INGRESS_REDIRECT_TTL_MS = 5 * 60 * 1_000;
const ROLLBACK_REPLAY_MAX_DELAY_MS = 5_000;
const ROLLBACK_REPLAY_MAX_ATTEMPTS = 6;
const ROLLBACK_REPLAY_SETTLEMENT_TIMEOUT_MS = 30_000;
const MAX_BUFFERED_SOURCE_INPUTS = 100;
const MAX_HANDOFF_ALIAS_DEPTH = 1_024;

function replayDelay(attempt: number): Promise<void> {
  const delay = Math.min(ROLLBACK_REPLAY_MAX_DELAY_MS, 100 * 2 ** Math.min(attempt, 6));
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delay);
    timer.unref?.();
  });
}

class RollbackReplaySettlementTimeoutError extends Error {
  constructor(sourceSessionId: string) {
    super(`buffered input replay did not settle within ${ROLLBACK_REPLAY_SETTLEMENT_TIMEOUT_MS}ms for ${sourceSessionId}`);
    this.name = 'RollbackReplaySettlementTimeoutError';
  }
}

export function isRollbackReplaySettlementTimeout(error: unknown): boolean {
  return error instanceof RollbackReplaySettlementTimeoutError;
}

class RollbackReplayDetachedByReactivationError extends Error {
  readonly name = 'RollbackReplayDetachedByReactivationError';

  constructor(sourceSessionId: string) {
    super(`buffered input replay was detached by source reactivation for ${sourceSessionId}`);
  }
}

function replayWithSettlementTimeout(
  input: BufferedHandOffSourceInput,
  sourceSessionId: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new RollbackReplaySettlementTimeoutError(sourceSessionId)),
      ROLLBACK_REPLAY_SETTLEMENT_TIMEOUT_MS,
    );
    timer.unref?.();
  });
  return Promise.race([input.replay(sourceSessionId), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export interface HandOffCutoverLease {
  readonly sourceSessionId: string;
  /** Mark the ownership move durable so buffered source inputs are not replayed on release. */
  commit(successorSessionId: string): boolean;
  /** Prevent commit but keep the gate held until settlement after a terminal lifecycle change. */
  revoke(): void;
  /** True while commit is still permitted for this exact lease. */
  canCommit(): boolean;
  /** True only while this exact lease still owns the source ingress gate. */
  isHeld(): boolean;
  release(): void;
}

export type HandOffCutoverAcquireResult =
  | { ok: true; lease: HandOffCutoverLease }
  | {
      ok: false;
      reason: 'active' | 'sealed' | 'committed' | 'durable-lookup-failed';
      successorSessionId?: string;
      error?: unknown;
    };

export interface BufferedHandOffSourceInput {
  /** Persist the input as source evidence so continuation capture/cutover scanning can see it. */
  record(sourceSessionId: string): void;
  /** Restore execution on the source without emitting a duplicate history event after rollback. */
  replay(sourceSessionId: string): Promise<void>;
  /** Surface a permanent rollback failure after bounded retries. */
  onReplayFailed?(sourceSessionId: string, error: unknown): void;
}

interface ActiveCutover {
  token: symbol;
  sourceId: { value: string };
  committed: boolean;
  revoked: boolean;
  discardBufferedOnRelease: boolean;
  successorSessionId: string | null;
  bufferedInputs: BufferedHandOffSourceInput[];
  rollbackSettling: boolean;
  detachedByReactivation: boolean;
}

/**
 * Process-wide exclusion for the only handoff phase that may create a successor or move source
 * ownership. Tokens prevent a stale/idempotent release from unlocking a newer handoff.
 */
export class HandOffCutoverCoordinator {
  private readonly active = new Map<string, ActiveCutover>();
  private readonly sealedSources = new Set<string>();
  private readonly redirects = new Map<
    string,
    { successorSessionId: string; expiresAt: number; token: symbol }
  >();

  constructor(
    private readonly findDurableSuccessor: (sourceSessionId: string) => string | null =
      findSessionHandOffSuccessor,
  ) {}

  tryAcquire(sourceSessionId: string): HandOffCutoverLease | null {
    if (this.active.has(sourceSessionId) || this.sealedSources.has(sourceSessionId)) return null;
    return this.createLease(sourceSessionId);
  }

  /**
   * Production handoff acquisition. In addition to the process-local gate, this fails closed when
   * a durable predecessor alias proves that ownership already moved in an earlier process epoch.
   * Internal ingress tests and lifecycle probes use tryAcquire() when no durable ownership check is
   * intended; UI and MCP entry points must use this method.
   */
  acquire(sourceSessionId: string): HandOffCutoverAcquireResult {
    if (this.active.has(sourceSessionId)) return { ok: false, reason: 'active' };
    let durableSuccessor: string | null;
    try {
      durableSuccessor = this.findDurableSuccessor(sourceSessionId);
    } catch (error) {
      return { ok: false, reason: 'durable-lookup-failed', error };
    }
    if (durableSuccessor) {
      return {
        ok: false,
        reason: 'committed',
        successorSessionId: durableSuccessor,
      };
    }
    if (this.sealedSources.has(sourceSessionId)) return { ok: false, reason: 'sealed' };
    return { ok: true, lease: this.createLease(sourceSessionId) };
  }

  private reportReplayFailure(
    input: BufferedHandOffSourceInput,
    sourceSessionId: string,
    error: unknown,
  ): void {
    try {
      input.onReplayFailed?.(sourceSessionId, error);
    } catch (reportError) {
      logger.warn(
        `[handoff cutover] failed to report abandoned replay for ${sourceSessionId}`,
        reportError,
      );
    }
  }

  private createLease(sourceSessionId: string): HandOffCutoverLease {
    const token = Symbol(sourceSessionId);
    const cutover: ActiveCutover = {
      token,
      sourceId: { value: sourceSessionId },
      committed: false,
      revoked: false,
      discardBufferedOnRelease: false,
      successorSessionId: null,
      bufferedInputs: [],
      rollbackSettling: false,
      detachedByReactivation: false,
    };
    this.active.set(sourceSessionId, cutover);
    let released = false;
    return {
      get sourceSessionId() {
        return cutover.sourceId.value;
      },
      commit: (successorSessionId) => {
        const current = this.active.get(cutover.sourceId.value);
        if (!released && current?.token === token && !current.revoked) {
          current.committed = true;
          current.successorSessionId = successorSessionId;
          return true;
        }
        return false;
      },
      revoke: () => {
        const current = this.active.get(cutover.sourceId.value);
        if (!released && current?.token === token && !current.committed) {
          current.revoked = true;
          current.discardBufferedOnRelease = true;
        }
      },
      canCommit: () => {
        const current = this.active.get(cutover.sourceId.value);
        return !released && current?.token === token && !current.revoked && !current.committed;
      },
      isHeld: () =>
        !released && this.active.get(cutover.sourceId.value)?.token === token,
      release: () => {
        if (released) return;
        released = true;
        const currentSourceId = cutover.sourceId.value;
        const current = this.active.get(currentSourceId);
        if (current?.token !== token) return;
        if (current.revoked && current.discardBufferedOnRelease) {
          this.active.delete(currentSourceId);
          return;
        }
        if (current.committed && current.successorSessionId) {
          this.active.delete(currentSourceId);
          this.rememberRedirect(currentSourceId, current.successorSessionId);
          return;
        }
        if (current.bufferedInputs.length === 0) {
          this.active.delete(currentSourceId);
          return;
        }
        // Keep the gate active until every accepted input is restored. New ingress joins the end
        // of this same array, so it cannot overtake older buffered messages during rollback.
        current.rollbackSettling = true;
        void (async () => {
          while (current.bufferedInputs.length > 0) {
            if (current.discardBufferedOnRelease) break;
            // Remove before awaiting so rename/merge can migrate only entries that have not started.
            const input = current.bufferedInputs.shift()!;
            let failedAttempts = 0;
            for (;;) {
              try {
                await replayWithSettlementTimeout(input, current.sourceId.value);
                break;
              } catch (error) {
                if (current.discardBufferedOnRelease) {
                  if (current.detachedByReactivation) {
                    this.reportReplayFailure(input, current.sourceId.value, error);
                  }
                  break;
                }
                failedAttempts += 1;
                const settlementTimedOut = error instanceof RollbackReplaySettlementTimeoutError;
                logger.warn(
                  `[handoff cutover] buffered input replay failure ${failedAttempts} for ${current.sourceId.value}`,
                  error,
                );
                if (settlementTimedOut || failedAttempts >= ROLLBACK_REPLAY_MAX_ATTEMPTS) {
                  this.reportReplayFailure(input, current.sourceId.value, error);
                  break;
                }
                await replayDelay(failedAttempts);
                if (current.discardBufferedOnRelease) {
                  if (current.detachedByReactivation) {
                    this.reportReplayFailure(
                      input,
                      current.sourceId.value,
                      new RollbackReplayDetachedByReactivationError(current.sourceId.value),
                    );
                  }
                  break;
                }
              }
            }
            if (current.discardBufferedOnRelease) {
              current.bufferedInputs.length = 0;
              break;
            }
          }
          if (this.active.get(current.sourceId.value)?.token === token) {
            this.active.delete(current.sourceId.value);
          }
        })();
      },
    };
  }

  /**
   * Divert one source input while handoff owns ingress. record() runs synchronously before the
   * caller is acknowledged; rollback replays it to the source, while commit leaves execution to
   * the successor continuation/cutover tail.
   */
  tryBufferInput(sourceSessionId: string, input: BufferedHandOffSourceInput): boolean {
    const cutover = this.active.get(sourceSessionId);
    if (!cutover || cutover.committed) return false;
    if (cutover.revoked) {
      throw new Error('handoff source is closed or unavailable; input was not accepted');
    }
    if (cutover.bufferedInputs.length >= MAX_BUFFERED_SOURCE_INPUTS) {
      throw new Error(
        `handoff source input buffer reached ${MAX_BUFFERED_SOURCE_INPUTS} messages`,
      );
    }
    cutover.bufferedInputs.push(input);
    try {
      input.record(sourceSessionId);
    } catch (error) {
      const index = cutover.bufferedInputs.lastIndexOf(input);
      if (index >= 0) cutover.bufferedInputs.splice(index, 1);
      throw error;
    }
    return true;
  }

  isActive(sourceSessionId: string): boolean {
    return this.active.has(sourceSessionId);
  }

  /** Terminal source lifecycle events revoke either UI or MCP ownership without opening ingress. */
  revokeSource(sourceSessionId: string): boolean {
    const newlySealed = !this.sealedSources.has(sourceSessionId);
    this.sealedSources.add(sourceSessionId);
    const cutover = this.active.get(sourceSessionId);
    if (!cutover || cutover.committed) return newlySealed;
    cutover.revoked = true;
    cutover.discardBufferedOnRelease = true;
    if (cutover.rollbackSettling) {
      cutover.bufferedInputs.length = 0;
      this.active.delete(sourceSessionId);
    }
    return true;
  }

  /** Explicit session reactivation opens a new handoff epoch after an earlier close intent. */
  restoreSource(sourceSessionId: string): boolean {
    return this.sealedSources.delete(sourceSessionId);
  }

  /** Explicit user reactivation starts a new owner epoch and retires the short-lived redirect. */
  reactivateSource(sourceSessionId: string): boolean {
    this.redirects.delete(sourceSessionId);
    const cutover = this.active.get(sourceSessionId);
    if (cutover?.rollbackSettling) {
      cutover.detachedByReactivation = true;
      cutover.discardBufferedOnRelease = true;
      const detached = cutover.bufferedInputs.splice(0);
      const error = new RollbackReplayDetachedByReactivationError(sourceSessionId);
      for (const input of detached) this.reportReplayFailure(input, sourceSessionId, error);
      this.active.delete(sourceSessionId);
    }
    return this.restoreSource(sourceSessionId);
  }

  /** Reversible lifecycle changes abort commit but restore already accepted input on release. */
  abortSource(sourceSessionId: string): boolean {
    const cutover = this.active.get(sourceSessionId);
    if (!cutover || cutover.committed) return false;
    cutover.revoked = true;
    if (!this.sealedSources.has(sourceSessionId)) {
      cutover.discardBufferedOnRelease = false;
    }
    return true;
  }

  /** Abort on an identity migration, but replay already accepted input against the new id. */
  renameSource(fromSessionId: string, toSessionId: string): boolean {
    if (fromSessionId === toSessionId) return false;
    if (this.sealedSources.delete(fromSessionId)) this.sealedSources.add(toSessionId);
    const cutover = this.active.get(fromSessionId);
    if (!cutover) {
      this.renameRedirects(fromSessionId, toSessionId);
      return false;
    }
    const targetCutover = this.active.get(toSessionId);
    this.active.delete(fromSessionId);
    cutover.sourceId.value = toSessionId;
    if (!cutover.committed) {
      cutover.revoked = true;
      if (!this.sealedSources.has(toSessionId)) {
        cutover.discardBufferedOnRelease = false;
      }
    }
    if (targetCutover && targetCutover.token !== cutover.token) {
      // Two identities are being merged while both own ingress. Abort both preparations and let
      // the target lease replay every accepted input in FIFO batches against the surviving id.
      targetCutover.revoked = true;
      targetCutover.discardBufferedOnRelease =
        targetCutover.discardBufferedOnRelease ||
        cutover.discardBufferedOnRelease ||
        this.sealedSources.has(toSessionId);
      targetCutover.bufferedInputs.push(...cutover.bufferedInputs);
      cutover.bufferedInputs.length = 0;
    } else {
      this.active.set(toSessionId, cutover);
    }
    this.renameRedirects(fromSessionId, toSessionId);
    return true;
  }

  /** Route IPC work that started before commit but reaches adapter dispatch after source close. */
  successorFor(sourceSessionId: string, now = Date.now()): string | null {
    try {
      return this.resolveSuccessorFor(sourceSessionId, now, false);
    } catch {
      // Best-effort routing remains available during startup/shutdown when SQLite is unavailable.
      return null;
    }
  }

  /** Authorization resolver: durable lookup failure is distinct from a confirmed no-handoff row. */
  successorForStrict(sourceSessionId: string, now = Date.now()): string | null {
    return this.resolveSuccessorFor(sourceSessionId, now, true);
  }

  private resolveSuccessorFor(
    sourceSessionId: string,
    now: number,
    failOnDurableLookupError: boolean,
  ): string | null {
    let current = sourceSessionId;
    const seen = new Set([current]);
    for (let depth = 0; depth < MAX_HANDOFF_ALIAS_DEPTH; depth += 1) {
      const active = this.active.get(current);
      let next = active?.committed ? active.successorSessionId : null;
      if (!next) {
        const redirect = this.redirects.get(current);
        if (redirect && redirect.expiresAt <= now) {
          this.redirects.delete(current);
        } else {
          next = redirect?.successorSessionId ?? null;
        }
      }
      if (!next) {
        try {
          next = this.findDurableSuccessor(current);
        } catch (error) {
          if (failOnDurableLookupError) throw error;
          return current === sourceSessionId ? null : current;
        }
      }
      if (!next) return current === sourceSessionId ? null : current;
      if (seen.has(next)) throw new Error('handoff alias cycle detected');
      seen.add(next);
      current = next;
    }
    // Never return an arbitrary closed intermediate owner when a corrupt or extreme chain exceeds
    // the safety bound. Normal handoffs path-compress durable aliases during resource transfer.
    throw new Error('handoff alias chain exceeded the safety bound');
  }

  private rememberRedirect(sourceSessionId: string, successorSessionId: string): void {
    const token = Symbol(sourceSessionId);
    this.redirects.set(sourceSessionId, {
      successorSessionId,
      expiresAt: Date.now() + HANDOFF_INGRESS_REDIRECT_TTL_MS,
      token,
    });
    const timer = setTimeout(() => {
      if (this.redirects.get(sourceSessionId)?.token === token) {
        this.redirects.delete(sourceSessionId);
      }
    }, HANDOFF_INGRESS_REDIRECT_TTL_MS);
    timer.unref?.();
  }

  private renameRedirects(fromSessionId: string, toSessionId: string): void {
    const sourceRedirect = this.redirects.get(fromSessionId);
    this.redirects.delete(fromSessionId);
    // The destination is becoming a live identity. Its older handoff epoch must not survive the
    // rename; mirror session_handoff_aliases cleanup in the durable rename transaction.
    this.redirects.delete(toSessionId);
    if (sourceRedirect && sourceRedirect.successorSessionId !== toSessionId) {
      this.rememberRedirect(toSessionId, sourceRedirect.successorSessionId);
    }
    for (const redirect of this.redirects.values()) {
      if (redirect.successorSessionId === fromSessionId) {
        redirect.successorSessionId = toSessionId;
      }
    }
  }
}

/** Shared by the UI coordinator and the one-step MCP handoff handler. */
export const handOffCutoverCoordinator = new HandOffCutoverCoordinator();
