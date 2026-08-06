import type { AgentEvent, SessionRecord } from '@shared/types';

import type { UpsertOptions } from './_deps';
import type { ClosedSideEffectOptions } from './lifecycle-core';

/**
 * Complete session-manager contract consumed by provider runtimes and desktop control surfaces.
 * The host owns repositories, event publication, provider processes, Browser cleanup, and any
 * platform-specific diagnostics; the facade is the stable injection boundary shared by them.
 */
export interface SessionManagerHost {
  claimAsSdk(sessionId: string): void;
  releaseSdkClaim(sessionId: string): void;
  hasSdkClaim(sessionId: string): boolean;
  expectSdkSession(cwd: string, ttlMs?: number): () => void;
  ensure(sessionId: string, options: UpsertOptions): SessionRecord;
  ingest(event: AgentEvent): void;
  markRecentlyDeleted(sessionId: string, cliSessionId?: string | null): void;
  hasPendingCloseSideEffects(sessionId: string): boolean;
  runClosedSideEffects(
    sessionId: string,
    options: ClosedSideEffectOptions,
  ): Promise<void>;
  markClosed(sessionId: string): void;
  close(sessionId: string): Promise<void>;
  getCloseEpoch(sessionId: string): number;
  bumpCloseEpoch(sessionId: string): void;
  forgetCloseEpoch(sessionId: string): void;
  archive(sessionId: string): Promise<void>;
  unarchive(sessionId: string): Promise<void>;
  unarchiveOnUserSend(sessionId: string): Promise<void>;
  reactivate(sessionId: string): void;
  setPinned(sessionId: string, pinned: boolean): SessionRecord;
  recordCreatedPermissionMode(sessionId: string, mode: string | undefined): void;
  notifyTeamMembershipChanged(sessionId: string): void;
  delete(sessionId: string): Promise<void>;
  renameSdkSession(fromId: string, toId: string): void;
  updateCliSessionId(applicationSessionId: string, cliSessionId: string): void;
  list(): SessionRecord[];
  get(sessionId: string): SessionRecord | null;
  enrichWithTeams(session: SessionRecord): SessionRecord;
  enrichWithTeamsBatch(sessions: SessionRecord[]): SessionRecord[];
}

/**
 * Host-neutral public facade. Keeping every call as an exact delegate preserves the legacy public
 * API while allowing a headless Core composition to provide its own repository/lifecycle host.
 */
export class SessionManagerFacade implements SessionManagerHost {
  constructor(private readonly host: SessionManagerHost) {}

  claimAsSdk(sessionId: string): void {
    this.host.claimAsSdk(sessionId);
  }

  releaseSdkClaim(sessionId: string): void {
    this.host.releaseSdkClaim(sessionId);
  }

  hasSdkClaim(sessionId: string): boolean {
    return this.host.hasSdkClaim(sessionId);
  }

  expectSdkSession(cwd: string, ttlMs?: number): () => void {
    return this.host.expectSdkSession(cwd, ttlMs);
  }

  ensure(sessionId: string, options: UpsertOptions): SessionRecord {
    return this.host.ensure(sessionId, options);
  }

  ingest(event: AgentEvent): void {
    this.host.ingest(event);
  }

  markRecentlyDeleted(sessionId: string, cliSessionId?: string | null): void {
    this.host.markRecentlyDeleted(sessionId, cliSessionId);
  }

  hasPendingCloseSideEffects(sessionId: string): boolean {
    return this.host.hasPendingCloseSideEffects(sessionId);
  }

  runClosedSideEffects(
    sessionId: string,
    options: ClosedSideEffectOptions,
  ): Promise<void> {
    return this.host.runClosedSideEffects(sessionId, options);
  }

  markClosed(sessionId: string): void {
    this.host.markClosed(sessionId);
  }

  close(sessionId: string): Promise<void> {
    return this.host.close(sessionId);
  }

  getCloseEpoch(sessionId: string): number {
    return this.host.getCloseEpoch(sessionId);
  }

  bumpCloseEpoch(sessionId: string): void {
    this.host.bumpCloseEpoch(sessionId);
  }

  forgetCloseEpoch(sessionId: string): void {
    this.host.forgetCloseEpoch(sessionId);
  }

  archive(sessionId: string): Promise<void> {
    return this.host.archive(sessionId);
  }

  unarchive(sessionId: string): Promise<void> {
    return this.host.unarchive(sessionId);
  }

  unarchiveOnUserSend(sessionId: string): Promise<void> {
    return this.host.unarchiveOnUserSend(sessionId);
  }

  reactivate(sessionId: string): void {
    this.host.reactivate(sessionId);
  }

  setPinned(sessionId: string, pinned: boolean): SessionRecord {
    return this.host.setPinned(sessionId, pinned);
  }

  recordCreatedPermissionMode(sessionId: string, mode: string | undefined): void {
    this.host.recordCreatedPermissionMode(sessionId, mode);
  }

  notifyTeamMembershipChanged(sessionId: string): void {
    this.host.notifyTeamMembershipChanged(sessionId);
  }

  delete(sessionId: string): Promise<void> {
    return this.host.delete(sessionId);
  }

  renameSdkSession(fromId: string, toId: string): void {
    this.host.renameSdkSession(fromId, toId);
  }

  updateCliSessionId(applicationSessionId: string, cliSessionId: string): void {
    this.host.updateCliSessionId(applicationSessionId, cliSessionId);
  }

  list(): SessionRecord[] {
    return this.host.list();
  }

  get(sessionId: string): SessionRecord | null {
    return this.host.get(sessionId);
  }

  enrichWithTeams(session: SessionRecord): SessionRecord {
    return this.host.enrichWithTeams(session);
  }

  enrichWithTeamsBatch(sessions: SessionRecord[]): SessionRecord[] {
    return this.host.enrichWithTeamsBatch(sessions);
  }
}
