import type { AgentEvent } from '@shared/types';
import log from '@main/utils/logger';
import { getProcessRunId } from '@main/utils/run-context';
import { runScopedCorrelationId } from '@main/utils/runtime-correlation';
import { safeDiagnostic, safeErrorSummary } from '@main/utils/safe-diagnostic';
import type { WorktreeTransitionRecord } from './types';

const logger = log.scope('worktree-transition');
const MAX_PENDING_FIRST_EVENTS = 256;
const FIRST_EVENT_RETENTION_MS = 10 * 60_000;
const FIRST_PROVIDER_EVENTS = new Set<AgentEvent['kind']>([
  'thinking',
  'message',
  'tool-use-start',
  'waiting-for-user',
  'context-compaction-start',
]);

interface PendingFirstEvent {
  completedAt: number;
  direction: WorktreeTransitionRecord['direction'];
  generation: number;
  sessionRef: string;
}

export class WorktreeTransitionTrace {
  private readonly finalizeStartedAt: number;
  private cwdSwitchedAt: number | null = null;
  private cwdPersistedAt: number | null = null;
  private cleanupStartedAt: number | null = null;
  private cleanupFinishedAt: number | null = null;
  private firstEventArmed = false;

  constructor(
    private readonly owner: WorktreeTransitionDiagnostics,
    private readonly initial: WorktreeTransitionRecord,
  ) {
    this.finalizeStartedAt = owner.currentTime();
  }

  markCwdSwitched(): void {
    this.cwdSwitchedAt = this.owner.currentTime();
  }

  markCwdPersisted(): void {
    this.cwdPersistedAt = this.owner.currentTime();
  }

  markCleanupStarted(): void {
    this.cleanupStartedAt = this.owner.currentTime();
  }

  markCleanupFinished(): void {
    this.cleanupFinishedAt = this.owner.currentTime();
  }

  markContinuationReady(): void {
    if (this.firstEventArmed) return;
    this.firstEventArmed = true;
    this.owner.trackFirstEvent(this.initial, this.owner.currentTime());
  }

  complete(
    record: WorktreeTransitionRecord,
    adapter: string,
    continuationAccepted: boolean,
    cleanupPending = false,
  ): void {
    const completedAt = this.owner.completeTrace({
      record,
      adapter,
      continuationAccepted,
      cleanupPending,
      toolResultObservedAt: this.initial.updatedAt,
      finalizeStartedAt: this.finalizeStartedAt,
      cwdSwitchedAt: this.cwdSwitchedAt,
      cwdPersistedAt: this.cwdPersistedAt,
      cleanupStartedAt: this.cleanupStartedAt,
      cleanupFinishedAt: this.cleanupFinishedAt,
    });
    if (!this.firstEventArmed) {
      this.firstEventArmed = true;
      this.owner.trackFirstEvent(record, completedAt);
    }
  }

  fail(error: unknown): void {
    if (this.firstEventArmed) this.owner.cancelFirstEvent(this.initial);
    this.owner.failTrace(this.initial, error, this.finalizeStartedAt);
  }
}

export class WorktreeTransitionDiagnostics {
  private readonly pendingFirstEvents = new Map<string, PendingFirstEvent>();

  constructor(private readonly now: () => number = Date.now) {}

  currentTime(): number {
    try {
      const value = this.now();
      return Number.isFinite(value) ? Math.max(0, value) : 0;
    } catch {
      return 0;
    }
  }

  start(record: WorktreeTransitionRecord): WorktreeTransitionTrace {
    return new WorktreeTransitionTrace(this, record);
  }

  observeToolResult(record: WorktreeTransitionRecord, accepted: boolean): void {
    try {
      const now = this.currentTime();
      const details = this.details(record, {
        stage: 'tool-result-observed',
        outcome: accepted ? 'accepted' : 'rejected',
        requestedToToolResultMs: duration(record.requestedAt, now),
      });
      if (accepted) logger.info('worktree cwd transition tool result observed', details);
      else logger.warn('worktree cwd transition tool result rejected', details);
    } catch {
      // Diagnostics cannot affect the transition state machine.
    }
  }

  observeEvent(event: AgentEvent): void {
    const pending = this.pendingFirstEvents.get(event.sessionId);
    if (!pending) return;
    const now = this.currentTime();
    if (now - pending.completedAt > FIRST_EVENT_RETENTION_MS) {
      this.pendingFirstEvents.delete(event.sessionId);
      return;
    }
    if (event.source !== 'sdk' || !FIRST_PROVIDER_EVENTS.has(event.kind)) return;
    this.pendingFirstEvents.delete(event.sessionId);
    try {
      logger.info(
        'worktree cwd continuation produced provider activity',
        safeDiagnostic({
          event: 'worktree-cwd-transition',
          runId: getProcessRunId(),
          sessionRef: pending.sessionRef,
          direction: pending.direction,
          generation: pending.generation,
          stage: 'first-provider-event',
          outcome: 'observed',
          eventKind: event.kind,
          continuationToFirstEventMs: duration(pending.completedAt, now),
        }),
      );
    } catch {
      // Diagnostics cannot affect provider event ingestion.
    }
  }

  completeTrace(input: {
    record: WorktreeTransitionRecord;
    adapter: string;
    continuationAccepted: boolean;
    cleanupPending: boolean;
    toolResultObservedAt: number;
    finalizeStartedAt: number;
    cwdSwitchedAt: number | null;
    cwdPersistedAt: number | null;
    cleanupStartedAt: number | null;
    cleanupFinishedAt: number | null;
  }): number {
    const completedAt = this.currentTime();
    try {
      const details = this.details(input.record, {
        adapter: input.adapter,
        stage: 'continuation-delivered',
        outcome: input.cleanupPending ? 'cleanup-pending' : 'completed',
        continuationAccepted: input.continuationAccepted,
        requestedToCompletedMs: duration(input.record.requestedAt, completedAt),
        toolResultToCompletedMs: duration(input.toolResultObservedAt, completedAt),
        finalizeDurationMs: duration(input.finalizeStartedAt, completedAt),
        cwdSwitchDurationMs: duration(input.finalizeStartedAt, input.cwdSwitchedAt),
        cwdPersistenceDurationMs: duration(input.cwdSwitchedAt, input.cwdPersistedAt),
        cwdPersistedToCompletionMs: duration(input.cwdPersistedAt, completedAt),
        cleanupDurationMs: duration(input.cleanupStartedAt, input.cleanupFinishedAt),
      });
      if (input.cleanupPending) logger.warn('worktree cwd transition cleanup pending', details);
      else logger.info('worktree cwd transition completed', details);
    } catch {
      // Diagnostics cannot affect transition completion.
    }
    return completedAt;
  }

  failTrace(record: WorktreeTransitionRecord, error: unknown, startedAt: number): void {
    try {
      logger.warn(
        'worktree cwd transition failed',
        this.details(record, {
          stage: 'finalize',
          outcome: 'failed',
          finalizeDurationMs: duration(startedAt, this.currentTime()),
          error: safeErrorSummary(error),
        }),
      );
    } catch {
      // Diagnostics cannot affect compensation or recovery.
    }
  }

  trackFirstEvent(record: WorktreeTransitionRecord, completedAt: number): void {
    try {
      if (this.pendingFirstEvents.size >= MAX_PENDING_FIRST_EVENTS) {
        const oldest = this.pendingFirstEvents.keys().next();
        if (!oldest.done) this.pendingFirstEvents.delete(oldest.value);
      }
      this.pendingFirstEvents.set(record.sessionId, {
        completedAt,
        direction: record.direction,
        generation: record.generation,
        sessionRef: runScopedCorrelationId('worktree', record.sessionId),
      });
    } catch {
      // Diagnostics cannot affect transition completion.
    }
  }

  cancelFirstEvent(record: WorktreeTransitionRecord): void {
    const pending = this.pendingFirstEvents.get(record.sessionId);
    if (pending?.generation === record.generation) {
      this.pendingFirstEvents.delete(record.sessionId);
    }
  }

  private details(
    record: WorktreeTransitionRecord,
    extra: Record<string, unknown>,
  ): ReturnType<typeof safeDiagnostic> {
    return safeDiagnostic({
      event: 'worktree-cwd-transition',
      runId: getProcessRunId(),
      sessionRef: runScopedCorrelationId('worktree', record.sessionId),
      direction: record.direction,
      generation: record.generation,
      ...extra,
    });
  }
}

function duration(start: number | null, end: number | null): number | null {
  if (start === null || end === null || !Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, end - start));
}

export const worktreeTransitionDiagnostics = new WorktreeTransitionDiagnostics();
