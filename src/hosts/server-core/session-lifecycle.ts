import type { LifecycleComponent } from '@composition/index';
import type { SessionRecord } from '@shared/types';
import {
  LIFECYCLE_BATCH_SIZE,
  type HistoryLifecycleCandidate,
  type HistoryLifecycleCursor,
} from '@main/store/session-repo/lifecycle';

import type { ServerCoreRuntimeDiagnostics } from './repository-host';
import type { ServerCoreSessionManager } from './session-manager';
import type { ServerCoreSessionManagerObserver } from './session-manager';
import type { ServerCoreSessionLifecycleSettings } from './session-lifecycle-options';

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_CATCH_UP_DELAY_MS = 1_000;

export interface ServerCoreLifecycleRepositoryPort {
  findActiveExpiring(threshold: number, limit: number): SessionRecord[];
  findDormantExpiring(threshold: number, limit: number): SessionRecord[];
  batchAdvanceLifecycle(
    ids: readonly string[],
    from: 'active' | 'dormant',
    to: 'dormant' | 'closed',
    at: number,
    threshold: number,
  ): SessionRecord[];
  findHistoryOlderThan(
    threshold: number,
    cursor: HistoryLifecycleCursor | null,
    limit: number,
  ): HistoryLifecycleCandidate[];
  batchDeleteHistory(
    candidates: readonly HistoryLifecycleCandidate[],
    threshold: number,
  ): HistoryLifecycleCandidate[];
}

export interface ServerCoreSessionLifecycleOptions extends ServerCoreSessionLifecycleSettings {
  sessions: ServerCoreLifecycleRepositoryPort;
  manager: Pick<ServerCoreSessionManager,
    'bumpCloseEpoch' | 'forgetCloseEpoch' | 'hasPendingCloseSideEffects' |
    'hasSdkClaim' | 'markRecentlyDeleted' | 'runClosedSideEffects'>;
  observer: Pick<ServerCoreSessionManagerObserver, 'sessionRemoved' | 'sessionUpdated' | 'warning'>;
  diagnostics: ServerCoreRuntimeDiagnostics;
  now?: () => number;
  intervalMs?: number;
  catchUpDelayMs?: number;
}

interface PhaseResult {
  needsCatchUp: boolean;
}

/** Electron-free authoritative lifecycle advancement for Full Core and Relay Worker. */
export class ServerCoreSessionLifecycle implements LifecycleComponent {
  readonly name = 'server-core-session-lifecycle';
  private interval: NodeJS.Timeout | null = null;
  private catchUp: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly options: ServerCoreSessionLifecycleOptions) {
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.interval) return;
    this.scan();
    this.interval = setInterval(
      () => this.scan(),
      this.options.intervalMs ?? DEFAULT_INTERVAL_MS,
    );
    this.interval.unref?.();
  }

  async stop(_reason: string): Promise<void> {
    if (this.interval) clearInterval(this.interval);
    if (this.catchUp) clearTimeout(this.catchUp);
    this.interval = null;
    this.catchUp = null;
  }

  scan(): void {
    if (this.catchUp) clearTimeout(this.catchUp);
    this.catchUp = null;
    this.runTick(null);
  }

  private runTick(historyCursor: HistoryLifecycleCursor | null): void {
    const now = this.now();
    const active = this.activePhase(now);
    const dormant = this.dormantPhase(now);
    const history = this.historyPhase(now, historyCursor);
    if (active.needsCatchUp || dormant.needsCatchUp || history.needsCatchUp) {
      this.scheduleCatchUp(history.needsCatchUp ? history.cursor : null);
    }
  }

  private activePhase(now: number): PhaseResult {
    try {
      const threshold = now - this.options.activeWindowMs;
      const rows = this.options.sessions.findActiveExpiring(threshold, LIFECYCLE_BATCH_SIZE);
      const updated = this.options.sessions.batchAdvanceLifecycle(
        rows.map((row) => row.id), 'active', 'dormant', now, threshold,
      );
      for (const record of updated) this.options.observer.sessionUpdated(record);
      return {
        needsCatchUp: rows.length >= LIFECYCLE_BATCH_SIZE && updated.length > 0,
      };
    } catch (error) {
      this.warn('active-to-dormant', error);
      return { needsCatchUp: false };
    }
  }

  private dormantPhase(now: number): PhaseResult {
    try {
      const threshold = now - this.options.closeAfterMs;
      const rows = this.options.sessions.findDormantExpiring(threshold, LIFECYCLE_BATCH_SIZE);
      const updated = this.options.sessions.batchAdvanceLifecycle(
        rows.map((row) => row.id), 'dormant', 'closed', now, threshold,
      );
      for (const record of updated) {
        this.options.manager.bumpCloseEpoch(record.id);
        this.options.observer.sessionUpdated(record);
        void this.options.manager.runClosedSideEffects(record.id, {}).catch((error) => {
          this.warn('closed-side-effects', error);
        });
      }
      return {
        needsCatchUp: rows.length >= LIFECYCLE_BATCH_SIZE && updated.length > 0,
      };
    } catch (error) {
      this.warn('dormant-to-closed', error);
      return { needsCatchUp: false };
    }
  }

  private historyPhase(
    now: number,
    cursor: HistoryLifecycleCursor | null,
  ): PhaseResult & { cursor: HistoryLifecycleCursor | null } {
    if (this.options.historyRetentionDays === 0) {
      return { needsCatchUp: false, cursor: null };
    }
    try {
      const threshold = now - this.options.historyRetentionDays * 24 * 60 * 60 * 1_000;
      const rows = this.options.sessions.findHistoryOlderThan(
        threshold, cursor, LIFECYCLE_BATCH_SIZE,
      );
      const nextCursor = rows.length > 0
        ? { id: rows.at(-1)!.id, lastEventAt: rows.at(-1)!.lastEventAt }
        : cursor;
      const deletable = rows.filter((row) =>
        !this.options.manager.hasPendingCloseSideEffects(row.id) &&
        !this.options.manager.hasSdkClaim(row.id) &&
        !(row.cliSessionId && this.options.manager.hasSdkClaim(row.cliSessionId)));
      const removed = this.options.sessions.batchDeleteHistory(deletable, threshold);
      for (const row of removed) {
        this.options.manager.markRecentlyDeleted(row.id, row.cliSessionId);
        this.options.manager.forgetCloseEpoch(row.id);
        this.options.observer.sessionRemoved(row.id);
      }
      const cursorMoved = nextCursor !== null && (
        cursor === null || nextCursor.id !== cursor.id || nextCursor.lastEventAt !== cursor.lastEventAt
      );
      return {
        needsCatchUp: rows.length >= LIFECYCLE_BATCH_SIZE &&
          (removed.length > 0 || cursorMoved),
        cursor: nextCursor,
      };
    } catch (error) {
      this.warn('history-purge', error);
      return { needsCatchUp: false, cursor };
    }
  }

  private scheduleCatchUp(cursor: HistoryLifecycleCursor | null): void {
    if (this.catchUp) return;
    this.catchUp = setTimeout(() => {
      this.catchUp = null;
      this.runTick(cursor);
    }, this.options.catchUpDelayMs ?? DEFAULT_CATCH_UP_DELAY_MS);
    this.catchUp.unref?.();
  }

  private warn(phase: string, error: unknown): void {
    try {
      this.options.diagnostics.warn('Server Core session lifecycle phase failed', { phase }, error);
    } catch {
      // Diagnostics never change lifecycle progression.
    }
    try {
      this.options.observer.warning('Server Core session lifecycle phase failed', error);
    } catch {
      // Observer diagnostics never change lifecycle progression.
    }
  }
}
