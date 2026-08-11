import type {
  AgentEvent,
  LifecycleState,
  PermissionMode,
  SessionRecord,
} from '@shared/types';
import {
  deriveTitle,
  extractCwd,
  nextActivityState,
  normalizeCwd,
} from '@main/session/manager-helpers';
import type { SessionManagerHost } from '@main/session/manager/facade-core';
import type { UpsertOptions } from '@main/session/manager/_deps';
import type { ClosedSideEffectOptions } from '@main/session/manager/lifecycle-core';
const RECENTLY_DELETED_TTL_MS = 60_000;

export interface ServerCoreSessionRepositoryPort {
  get(sessionId: string): SessionRecord | null;
  findByCliSessionId(cliSessionId: string): SessionRecord | null;
  listLiveForUi(limit?: number): SessionRecord[];
  upsert(record: SessionRecord): void;
  setActivity(sessionId: string, activity: SessionRecord['activity'], at: number): void;
  setEventState(
    sessionId: string,
    activity: SessionRecord['activity'],
    lifecycle: SessionRecord['lifecycle'],
    at: number,
    options?: { clearPinned?: boolean },
  ): void;
  setLifecycle(
    sessionId: string,
    lifecycle: SessionRecord['lifecycle'],
    at: number,
    options?: { clearPinned?: boolean },
  ): void;
  setArchived(sessionId: string, archivedAt: number | null): void;
  setPinned(sessionId: string, pinnedAt: number | null): SessionRecord;
  setPermissionMode(sessionId: string, mode: PermissionMode | null): void;
  hideFromHistory(sessionId: string): void;
  setSpawnLink(sessionId: string, parentSessionId: string, depth: number): void;
  rename(fromId: string, toId: string): void;
  updateCliSessionId(sessionId: string, cliSessionId: string): void;
  delete(sessionId: string): void;
}

export interface ServerCoreEventRepositoryPort {
  insert(event: AgentEvent): number;
}

export interface ServerCoreSessionManagerObserver {
  eventPersisted(event: AgentEvent, eventId: number): void;
  tokenUsageObserved(event: AgentEvent): void;
  contextUsageObserved(event: AgentEvent): void;
  contextCompactionObserved(event: AgentEvent): void;
  sessionUpdated(session: SessionRecord): void;
  sessionRemoved(sessionId: string): void;
  sessionRenamed(fromId: string, toId: string): void;
  warning(message: string, error?: unknown): void;
}

export interface ServerCoreSessionManagerOptions {
  readonly sessions: ServerCoreSessionRepositoryPort;
  readonly events: ServerCoreEventRepositoryPort;
  readonly observer: ServerCoreSessionManagerObserver;
  readonly now?: () => number;
  readonly handOffLifecycle?: {
    revokeSource(sessionId: string): unknown;
    restoreSource(sessionId: string): unknown;
    abortSource(sessionId: string): unknown;
    reactivateSource(sessionId: string): unknown;
    renameSource(fromSessionId: string, toSessionId: string): unknown;
  };
}

type SessionClose = (agentId: string, sessionId: string) => Promise<void>;
type SessionRename = (agentId: string, fromId: string, toId: string) => void;

function explicitSdkUserMessage(event: AgentEvent): boolean {
  if (event.source !== 'sdk' || event.kind !== 'message') return false;
  return (event.payload as { role?: unknown } | null | undefined)?.role === 'user';
}

function initialSdkRegistration(event: AgentEvent): Pick<
  UpsertOptions,
  'hiddenFromHistory' | 'spawnDepth' | 'spawnedBy'
> {
  if (event.source !== 'sdk' || event.kind !== 'session-start') return {};
  const payload = event.payload as {
    initialHiddenFromHistory?: unknown;
    initialSpawnLink?: { depth?: unknown; parentSessionId?: unknown };
  } | null | undefined;
  const link = payload?.initialSpawnLink;
  if (
    typeof link?.parentSessionId !== 'string' ||
    link.parentSessionId.length === 0 ||
    !Number.isInteger(link.depth) ||
    Number(link.depth) <= 0
  ) {
    return { hiddenFromHistory: payload?.initialHiddenFromHistory === true };
  }
  return {
    hiddenFromHistory: payload?.initialHiddenFromHistory === true,
    spawnedBy: link.parentSessionId,
    spawnDepth: Number(link.depth),
  };
}

function isHandOffBuffered(event: AgentEvent): boolean {
  return event.kind === 'message' &&
    event.payload !== null &&
    typeof event.payload === 'object' &&
    (event.payload as { handOffBuffered?: unknown }).handOffBuffered === true;
}

/**
 * Provider-facing SessionManager for one Server Core process. It keeps desktop-only teams,
 * Browser, worktree, and renderer state outside the runtime while preserving durable session
 * identity, SDK claim fencing, lifecycle epochs, and event persistence.
 */
export class ServerCoreSessionManager implements SessionManagerHost {
  private readonly sdkOwned = new Set<string>();
  private readonly pendingSdkCwds = new Map<string, number>();
  private readonly recentlyDeleted = new Map<string, number>();
  private readonly closeEpoch = new Map<string, number>();
  private sessionClose: SessionClose | null = null;
  private sessionRename: SessionRename | null = null;
  private readonly now: () => number;

  constructor(private readonly options: ServerCoreSessionManagerOptions) {
    this.now = options.now ?? Date.now;
  }

  installSessionClose(handler: SessionClose): void {
    this.sessionClose = handler;
  }

  installSessionRename(handler: SessionRename): void {
    this.sessionRename = handler;
  }

  claimAsSdk(sessionId: string): void {
    this.sdkOwned.add(sessionId);
  }

  releaseSdkClaim(sessionId: string): void {
    this.sdkOwned.delete(sessionId);
  }

  hasSdkClaim(sessionId: string): boolean {
    return this.sdkOwned.has(sessionId);
  }

  expectSdkSession(cwd: string, ttlMs = 60_000): () => void {
    const key = normalizeCwd(cwd);
    const expiresAt = this.now() + Math.max(0, ttlMs);
    this.pendingSdkCwds.set(key, expiresAt);
    return () => {
      if (this.pendingSdkCwds.get(key) === expiresAt) this.pendingSdkCwds.delete(key);
    };
  }

  ensure(sessionId: string, input: UpsertOptions): SessionRecord {
    const existing = this.options.sessions.get(sessionId);
    if (existing) {
      let current = existing;
      if (input.hiddenFromHistory === true && !current.hiddenFromHistory) {
        if (current.lifecycle !== 'active' || current.archivedAt !== null) {
          throw new Error('Cannot hide a non-live Server Core session');
        }
        this.options.sessions.hideFromHistory(sessionId);
        current = this.requireSession(sessionId);
        this.options.observer.sessionUpdated(current);
      }
      if (input.spawnedBy && current.spawnedBy == null) {
        const depth = input.spawnDepth ?? 0;
        if (current.lifecycle !== 'active' || current.archivedAt !== null || depth <= 0) {
          throw new Error('Cannot attach a spawn link to a non-live Server Core session');
        }
        this.options.sessions.setSpawnLink(sessionId, input.spawnedBy, depth);
        current = this.requireSession(sessionId);
        this.options.observer.sessionUpdated(current);
      } else if (
        input.spawnedBy &&
        (current.spawnedBy !== input.spawnedBy || current.spawnDepth !== (input.spawnDepth ?? 0))
      ) {
        throw new Error('Cannot re-parent a Server Core session');
      }
      if (
        current.lifecycle === 'closed' &&
        current.archivedAt === null &&
        input.reviveClosed === true
      ) {
        current = { ...current, lifecycle: 'active', endedAt: null };
        this.options.sessions.upsert(current);
        this.options.observer.sessionUpdated(current);
      }
      return current;
    }

    if (input.spawnedBy && (input.spawnDepth ?? 0) <= 0) {
      throw new Error('Server Core spawn depth must be positive');
    }
    if (!input.spawnedBy && (input.spawnDepth ?? 0) !== 0) {
      throw new Error('Server Core spawn depth requires a parent session');
    }
    const createdAt = this.now();
    const record: SessionRecord = {
      id: sessionId,
      agentId: input.agentId,
      cwd: input.cwd ?? '',
      title: input.title ?? deriveTitle(input.cwd ?? sessionId),
      source: input.source ?? 'cli',
      lifecycle: 'active',
      activity: 'idle',
      startedAt: createdAt,
      lastEventAt: createdAt,
      endedAt: null,
      archivedAt: null,
      hiddenFromHistory: input.hiddenFromHistory === true,
      spawnedBy: input.spawnedBy ?? null,
      spawnDepth: input.spawnDepth ?? 0,
    };
    this.options.sessions.upsert(record);
    this.options.observer.sessionUpdated(record);
    return record;
  }

  ingest(input: AgentEvent): void {
    let event = input;
    const mapped = this.options.sessions.findByCliSessionId(event.sessionId);
    if (mapped && mapped.id !== event.sessionId) event = { ...event, sessionId: mapped.id };

    if (this.isRecentlyDeleted(event.sessionId)) {
      if (!explicitSdkUserMessage(event)) return;
      this.recentlyDeleted.delete(event.sessionId);
    }
    if (event.source === 'hook' && this.sdkOwned.has(event.sessionId)) return;
    if (event.source === 'hook') {
      const cwd = extractCwd(event);
      if (cwd && this.consumePendingSdkCwd(cwd)) {
        this.sdkOwned.add(event.sessionId);
        return;
      }
      if (event.hookOrigin === 'sdk') return;
    }
    if (event.kind === 'token-usage') {
      this.options.observer.tokenUsageObserved(event);
      return;
    }
    if (event.kind === 'context-usage') {
      this.options.observer.contextUsageObserved(event);
      return;
    }
    const record = this.ensure(event.sessionId, {
      agentId: event.agentId,
      cwd: extractCwd(event),
      source: event.source === 'sdk' ? 'sdk' : 'cli',
      reviveClosed: explicitSdkUserMessage(event),
      ...initialSdkRegistration(event),
    });
    const eventId = this.options.events.insert(event);
    this.advance(record, event);
    if (event.kind === 'context-compaction-start') {
      this.options.observer.contextCompactionObserved(event);
    }
    this.options.observer.eventPersisted(event, eventId);
  }

  markRecentlyDeleted(sessionId: string, cliSessionId?: string | null): void {
    const at = this.now();
    this.recentlyDeleted.set(sessionId, at);
    const cliId = cliSessionId ?? this.options.sessions.get(sessionId)?.cliSessionId;
    if (cliId && cliId !== sessionId) this.recentlyDeleted.set(cliId, at);
  }

  hasPendingCloseSideEffects(_sessionId: string): boolean {
    return false;
  }

  runClosedSideEffects(
    _sessionId: string,
    _options: ClosedSideEffectOptions,
  ): Promise<void> {
    return Promise.resolve();
  }

  markClosed(sessionId: string): void {
    const session = this.options.sessions.get(sessionId);
    if (!session || !['active', 'dormant'].includes(session.lifecycle)) return;
    this.bumpCloseEpoch(sessionId);
    this.options.sessions.setLifecycle(sessionId, 'closed', this.now(), { clearPinned: true });
    this.publishFresh(sessionId);
  }

  async close(sessionId: string): Promise<void> {
    const session = this.options.sessions.get(sessionId);
    if (!session) return;
    this.bumpCloseEpoch(sessionId);
    if (session.agentId && this.sessionClose) {
      try {
        await this.sessionClose(session.agentId, sessionId);
      } catch (error) {
        this.options.observer.warning('Server Core provider close failed', error);
      }
    }
    this.options.sessions.setLifecycle(sessionId, 'closed', this.now(), { clearPinned: true });
    this.publishFresh(sessionId);
  }

  getCloseEpoch(sessionId: string): number {
    return this.closeEpoch.get(sessionId) ?? 0;
  }

  bumpCloseEpoch(sessionId: string): void {
    this.closeEpoch.set(sessionId, this.getCloseEpoch(sessionId) + 1);
    this.options.handOffLifecycle?.revokeSource(sessionId);
  }

  forgetCloseEpoch(sessionId: string): void {
    this.closeEpoch.delete(sessionId);
    this.options.handOffLifecycle?.restoreSource(sessionId);
  }

  async archive(sessionId: string): Promise<void> {
    this.options.handOffLifecycle?.abortSource(sessionId);
    this.options.sessions.setArchived(sessionId, this.now());
    this.publishFresh(sessionId);
  }

  async unarchive(sessionId: string): Promise<void> {
    this.options.sessions.setArchived(sessionId, null);
    this.publishFresh(sessionId);
  }

  async unarchiveOnUserSend(sessionId: string): Promise<void> {
    const session = this.options.sessions.get(sessionId);
    if (session && session.archivedAt !== null) await this.unarchive(sessionId);
  }

  reactivate(sessionId: string): void {
    if (!this.options.sessions.get(sessionId)) return;
    this.options.handOffLifecycle?.reactivateSource(sessionId);
    this.options.sessions.setLifecycle(sessionId, 'active', this.now());
    this.publishFresh(sessionId);
  }

  setPinned(sessionId: string, pinned: boolean): SessionRecord {
    const updated = this.options.sessions.setPinned(sessionId, pinned ? this.now() : null);
    this.options.observer.sessionUpdated(updated);
    return updated;
  }

  recordCreatedPermissionMode(sessionId: string, mode: string | undefined): void {
    if (!mode || mode === 'default') return;
    this.options.sessions.setPermissionMode(sessionId, mode as PermissionMode);
    this.publishFresh(sessionId);
  }

  notifyTeamMembershipChanged(sessionId: string): void {
    this.publishFresh(sessionId);
  }

  async delete(sessionId: string): Promise<void> {
    const session = this.options.sessions.get(sessionId);
    if (!session) return;
    this.bumpCloseEpoch(sessionId);
    if (session.agentId && this.sessionClose) {
      try {
        await this.sessionClose(session.agentId, sessionId);
      } catch (error) {
        this.options.observer.warning('Server Core provider delete cleanup failed', error);
      }
    }
    this.options.sessions.delete(sessionId);
    this.sdkOwned.delete(sessionId);
    this.markRecentlyDeleted(sessionId, session.cliSessionId);
    this.closeEpoch.delete(sessionId);
    this.options.handOffLifecycle?.restoreSource(sessionId);
    this.options.observer.sessionRemoved(sessionId);
  }

  /** Removes durable state only after a provider-specific strict rollback already succeeded. */
  discardAfterProviderRollback(sessionId: string): void {
    const session = this.options.sessions.get(sessionId);
    if (!session) return;
    this.bumpCloseEpoch(sessionId);
    this.options.sessions.delete(sessionId);
    this.sdkOwned.delete(sessionId);
    this.markRecentlyDeleted(sessionId, session.cliSessionId);
    this.closeEpoch.delete(sessionId);
    this.options.handOffLifecycle?.restoreSource(sessionId);
    this.options.observer.sessionRemoved(sessionId);
  }

  renameSdkSession(fromId: string, toId: string): void {
    if (fromId === toId) return;
    this.options.sessions.rename(fromId, toId);
    if (this.sdkOwned.delete(fromId)) this.sdkOwned.add(toId);
    this.options.handOffLifecycle?.renameSource(fromId, toId);
    this.recentlyDeleted.set(fromId, this.now());
    const updated = this.options.sessions.get(toId);
    if (updated?.agentId && this.sessionRename) {
      this.sessionRename(updated.agentId, fromId, toId);
    }
    this.options.observer.sessionRenamed(fromId, toId);
    if (updated) this.options.observer.sessionUpdated(updated);
  }

  updateCliSessionId(sessionId: string, cliSessionId: string): void {
    const previous = this.options.sessions.get(sessionId)?.cliSessionId ?? null;
    this.options.sessions.updateCliSessionId(sessionId, cliSessionId);
    if (previous && previous !== cliSessionId) this.recentlyDeleted.set(previous, this.now());
  }

  list(): SessionRecord[] {
    return this.options.sessions.listLiveForUi();
  }

  get(sessionId: string): SessionRecord | null {
    return this.options.sessions.get(sessionId);
  }

  enrichWithTeams(session: SessionRecord): SessionRecord {
    return session;
  }

  enrichWithTeamsBatch(sessions: SessionRecord[]): SessionRecord[] {
    return sessions;
  }

  private consumePendingSdkCwd(cwd: string): boolean {
    const key = normalizeCwd(cwd);
    const expiresAt = this.pendingSdkCwds.get(key);
    if (expiresAt !== undefined) this.pendingSdkCwds.delete(key);
    return expiresAt !== undefined && this.now() <= expiresAt;
  }

  private isRecentlyDeleted(sessionId: string): boolean {
    const deletedAt = this.recentlyDeleted.get(sessionId);
    if (deletedAt === undefined) return false;
    if (this.now() - deletedAt <= RECENTLY_DELETED_TTL_MS) return true;
    this.recentlyDeleted.delete(sessionId);
    return false;
  }

  private advance(record: SessionRecord, event: AgentEvent): void {
    if (record.lifecycle === 'closed') return;
    if (record.archivedAt !== null) {
      if (event.kind === 'session-end') {
        const lifecycle: LifecycleState = event.source === 'sdk' ? 'dormant' : 'closed';
        this.options.sessions.setLifecycle(event.sessionId, lifecycle, event.ts, {
          clearPinned: true,
        });
      }
      return;
    }
    const nextActivity = isHandOffBuffered(event)
      ? record.activity
      : nextActivityState(record.activity, event.kind, event.payload);
    let nextLifecycle: LifecycleState = 'active';
    if (event.kind === 'session-end') {
      nextLifecycle = event.source === 'sdk' ? 'dormant' : 'closed';
      this.options.sessions.setEventState(
        event.sessionId,
        nextActivity,
        nextLifecycle,
        event.ts,
        { clearPinned: true },
      );
      this.publishFresh(event.sessionId);
      return;
    }
    if (nextActivity !== record.activity || nextLifecycle !== record.lifecycle) {
      const updated = {
        ...record,
        activity: nextActivity,
        lifecycle: nextLifecycle,
        lastEventAt: event.ts,
        endedAt: null,
      };
      this.options.sessions.upsert(updated);
      this.options.observer.sessionUpdated(updated);
    } else {
      this.options.sessions.setActivity(event.sessionId, nextActivity, event.ts);
    }
  }

  private requireSession(sessionId: string): SessionRecord {
    const record = this.options.sessions.get(sessionId);
    if (!record) throw new Error('Server Core session disappeared during registration');
    return record;
  }

  private publishFresh(sessionId: string): void {
    const record = this.options.sessions.get(sessionId);
    if (record) this.options.observer.sessionUpdated(record);
  }
}
