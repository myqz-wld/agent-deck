import log from '@main/utils/logger';
import { findSessionHandOffSuccessor } from '@main/store/session-handoff-alias-repo';

const logger = log.scope('handoff-cutover');
const HANDOFF_INGRESS_REDIRECT_TTL_MS = 5 * 60 * 1_000;
const ROLLBACK_REPLAY_MAX_DELAY_MS = 5_000;
const ROLLBACK_REPLAY_MAX_ATTEMPTS = 6;
const MAX_BUFFERED_SOURCE_INPUTS = 100;
const MAX_HANDOFF_ALIAS_DEPTH = 1_024;

function durableSuccessorFor(sourceSessionId: string): string | null {
  try {
    return findSessionHandOffSuccessor(sourceSessionId);
  } catch {
    // Startup/shutdown and isolated unit tests can call routing while the DB is unavailable.
    return null;
  }
}

function replayDelay(attempt: number): Promise<void> {
  const delay = Math.min(ROLLBACK_REPLAY_MAX_DELAY_MS, 100 * 2 ** Math.min(attempt, 6));
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delay);
    timer.unref?.();
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
      durableSuccessorFor,
  ) {}

  tryAcquire(sourceSessionId: string): HandOffCutoverLease | null {
    if (this.active.has(sourceSessionId) || this.sealedSources.has(sourceSessionId)) return null;
    const token = Symbol(sourceSessionId);
    const cutover: ActiveCutover = {
      token,
      sourceId: { value: sourceSessionId },
      committed: false,
      revoked: false,
      discardBufferedOnRelease: false,
      successorSessionId: null,
      bufferedInputs: [],
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
        void (async () => {
          let index = 0;
          let failedAttempts = 0;
          while (index < current.bufferedInputs.length) {
            if (current.discardBufferedOnRelease) break;
            const input = current.bufferedInputs[index]!;
            try {
              await input.replay(current.sourceId.value);
              index += 1;
              failedAttempts = 0;
            } catch (error) {
              if (current.discardBufferedOnRelease) break;
              logger.warn(
                `[handoff cutover] buffered input replay retry ${failedAttempts + 1} for ${current.sourceId.value}`,
                error,
              );
              failedAttempts += 1;
              if (failedAttempts >= ROLLBACK_REPLAY_MAX_ATTEMPTS) {
                try {
                  input.onReplayFailed?.(current.sourceId.value, error);
                } catch (reportError) {
                  logger.warn(
                    `[handoff cutover] failed to report abandoned replay for ${current.sourceId.value}`,
                    reportError,
                  );
                }
                index += 1;
                failedAttempts = 0;
                continue;
              }
              await replayDelay(failedAttempts);
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
    return true;
  }

  /** Explicit session reactivation opens a new handoff epoch after an earlier close intent. */
  restoreSource(sourceSessionId: string): boolean {
    return this.sealedSources.delete(sourceSessionId);
  }

  /** Explicit user reactivation starts a new owner epoch and retires the short-lived redirect. */
  reactivateSource(sourceSessionId: string): boolean {
    this.redirects.delete(sourceSessionId);
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
      if (!next) next = this.findDurableSuccessor(current);
      if (!next) return current === sourceSessionId ? null : current;
      if (seen.has(next)) return null;
      seen.add(next);
      current = next;
    }
    // Never return an arbitrary closed intermediate owner when a corrupt or extreme chain exceeds
    // the safety bound. Normal handoffs path-compress durable aliases during resource transfer.
    return null;
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
