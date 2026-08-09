import type { PermissionMode, SessionRecord } from '@shared/types';

import {
  bumpCloseEpochImpl,
  type SessionCloseFn,
  type SessionManagerInternalState,
} from './_deps';

export interface ClosedSideEffectOptions {
  logPrefix?: string;
  onClearedBeforeLeave?: () => void;
}

export interface SessionLifecycleRepositoryPort {
  get(sessionId: string): SessionRecord | null;
  setLifecycle(
    sessionId: string,
    lifecycle: SessionRecord['lifecycle'],
    at: number,
    options?: { clearPinned?: boolean },
  ): void;
  setArchived(sessionId: string, archivedAt: number | null): void;
  setPinned(sessionId: string, pinnedAt: number | null): SessionRecord;
  setPermissionMode(sessionId: string, mode: PermissionMode | null): void;
  delete(sessionId: string): void;
}

export interface SessionLifecycleCoreHost {
  readonly repository: SessionLifecycleRepositoryPort;
  now(): number;
  disposeSessionBrowser(sessionId: string): Promise<void>;
  applyClosedSideEffects(
    sessionId: string,
    options: ClosedSideEffectOptions & { awaitLeave: true },
  ): Promise<void>;
  archiveTeamsIfOrphaned(sessionId: string): Promise<void>;
  unarchiveTeamsForRevivedLead(sessionId: string): Promise<void>;
  leaveTeamsAndAutoArchive(sessionId: string, reason: 'deleted'): Promise<void>;
  revokeHandOffSource(sessionId: string): void;
  abortHandOffSource(sessionId: string): void;
  restoreHandOffSource(sessionId: string): void;
  reactivateHandOffSource(sessionId: string, persist: () => void): void;
  assertDeleteAllowed(sessionId: string): void;
  releaseSessionToken(sessionId: string): void;
  publishSessionUpserted(session: SessionRecord): void;
  publishSessionRemoved(sessionId: string): void;
  warn(message: string, error: unknown): void;
}

/** Host-neutral session lifecycle state machine shared by desktop and headless compositions. */
export class SessionLifecycleCore {
  private readonly pendingCloseSideEffects = new Map<string, number>();

  constructor(private readonly host: SessionLifecycleCoreHost) {}

  hasPendingCloseSideEffects(sessionId: string): boolean {
    return (this.pendingCloseSideEffects.get(sessionId) ?? 0) > 0;
  }

  runClosedSideEffects(
    sessionId: string,
    options: ClosedSideEffectOptions,
  ): Promise<void> {
    this.pendingCloseSideEffects.set(
      sessionId,
      (this.pendingCloseSideEffects.get(sessionId) ?? 0) + 1,
    );
    return this.host.applyClosedSideEffects(sessionId, {
      ...options,
      awaitLeave: true,
    }).finally(() => {
      const remaining = (this.pendingCloseSideEffects.get(sessionId) ?? 1) - 1;
      if (remaining > 0) this.pendingCloseSideEffects.set(sessionId, remaining);
      else this.pendingCloseSideEffects.delete(sessionId);
    });
  }

  markRecentlyDeleted(
    state: SessionManagerInternalState,
    sessionId: string,
    cliSessionId?: string | null,
  ): void {
    const now = this.host.now();
    state.recentlyDeleted.set(sessionId, now);
    const cliId = cliSessionId ?? this.host.repository.get(sessionId)?.cliSessionId;
    if (cliId && cliId !== sessionId) state.recentlyDeleted.set(cliId, now);
  }

  markClosed(state: SessionManagerInternalState, sessionId: string): void {
    const session = this.host.repository.get(sessionId);
    if (!session || !['active', 'dormant'].includes(session.lifecycle)) return;
    this.host.revokeHandOffSource(sessionId);
    bumpCloseEpochImpl(state, sessionId);
    this.host.repository.setLifecycle(sessionId, 'closed', this.host.now(), {
      clearPinned: true,
    });
    void this.host.disposeSessionBrowser(sessionId).catch((error) => {
      this.host.warn(`[session-mgr] browser disposal failed during markClosed(): ${sessionId}`, error);
    });
    void this.runClosedSideEffects(sessionId, {
      logPrefix: '[session-mgr] markClosed',
      onClearedBeforeLeave: () => this.publishFresh(sessionId),
    }).catch(() => undefined);
  }

  async close(
    sessionId: string,
    sessionClose: SessionCloseFn | null,
    state: SessionManagerInternalState,
  ): Promise<void> {
    const session = this.host.repository.get(sessionId);
    if (!session) return;
    this.host.revokeHandOffSource(sessionId);
    bumpCloseEpochImpl(state, sessionId);
    if (session.agentId && sessionClose) {
      try {
        await sessionClose(session.agentId, sessionId);
      } catch (error) {
        this.host.warn(`[session-mgr] adapter close failed during close(): ${sessionId}`, error);
      }
    }
    this.host.repository.setLifecycle(sessionId, 'closed', this.host.now(), {
      clearPinned: true,
    });
    await this.host.disposeSessionBrowser(sessionId);
    await this.runClosedSideEffects(sessionId, {
      logPrefix: '[session-mgr] close',
      onClearedBeforeLeave: () => {
        this.publishFresh(sessionId);
        this.host.releaseSessionToken(sessionId);
      },
    });
  }

  async archive(sessionId: string): Promise<void> {
    this.host.repository.setArchived(sessionId, this.host.now());
    this.host.abortHandOffSource(sessionId);
    this.publishFresh(sessionId);
    await this.host.archiveTeamsIfOrphaned(sessionId);
  }

  async unarchive(sessionId: string): Promise<void> {
    this.host.repository.setArchived(sessionId, null);
    this.publishFresh(sessionId);
    await this.host.unarchiveTeamsForRevivedLead(sessionId);
  }

  async unarchiveOnUserSend(
    sessionId: string,
    unarchive: (id: string) => Promise<void>,
  ): Promise<void> {
    const session = this.host.repository.get(sessionId);
    if (!session || session.archivedAt === null) return;
    await unarchive(sessionId);
  }

  reactivate(sessionId: string): void {
    if (!this.host.repository.get(sessionId)) return;
    this.host.reactivateHandOffSource(sessionId, () => {
      this.host.repository.setLifecycle(sessionId, 'active', this.host.now());
    });
    this.publishFresh(sessionId);
  }

  setPinned(sessionId: string, pinned: boolean): SessionRecord {
    const updated = this.host.repository.setPinned(
      sessionId,
      pinned ? this.host.now() : null,
    );
    this.host.publishSessionUpserted(updated);
    return updated;
  }

  recordCreatedPermissionMode(sessionId: string, mode: string | undefined): void {
    if (!mode || mode === 'default') return;
    this.host.repository.setPermissionMode(sessionId, mode as PermissionMode);
    this.publishFresh(sessionId);
  }

  notifyTeamMembershipChanged(sessionId: string): void {
    this.publishFresh(sessionId);
  }

  async delete(
    state: SessionManagerInternalState,
    sessionId: string,
    sessionClose: SessionCloseFn | null,
  ): Promise<void> {
    this.host.assertDeleteAllowed(sessionId);
    if (this.host.repository.get(sessionId)) this.host.revokeHandOffSource(sessionId);
    bumpCloseEpochImpl(state, sessionId);
    await this.host.leaveTeamsAndAutoArchive(sessionId, 'deleted');
    const session = this.host.repository.get(sessionId);
    if (session?.agentId && sessionClose) {
      try {
        await sessionClose(session.agentId, sessionId);
      } catch (error) {
        this.host.warn(`[session-mgr] close on delete failed: ${sessionId}`, error);
      }
    }
    await this.host.disposeSessionBrowser(sessionId);
    const cliSessionId = this.host.repository.get(sessionId)?.cliSessionId;
    this.host.repository.delete(sessionId);
    this.host.restoreHandOffSource(sessionId);
    this.markRecentlyDeleted(state, sessionId, cliSessionId);
    state.closeEpoch.delete(sessionId);
    this.host.publishSessionRemoved(sessionId);
  }

  private publishFresh(sessionId: string): void {
    const updated = this.host.repository.get(sessionId);
    if (updated) this.host.publishSessionUpserted(updated);
  }
}
