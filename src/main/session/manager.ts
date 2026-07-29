/**
 * SessionManager facade. Lifecycle and rename details live in sibling modules while this class
 * retains SDK ownership because the runtime-private `#sdkOwned` set cannot cross module boundaries.
 * Public exports remain centralized here.
 */
import type { AgentEvent, SessionRecord } from '@shared/types';
import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import { isDbClosed } from '@main/store/db';
import { enrichRecordWithTeams, enrichRecordsWithTeamsBatch } from './manager-enrich';
import {
  type IngestContext,
  dedupOrClaim,
  ensureRecord,
  persistEventRow,
  persistFileChange,
  advanceState,
  persistTokenUsage,
} from './manager-ingest-pipeline';
import {
  type SessionManagerInternalState,
  type UpsertOptions,
  isRecentlyDeletedImpl,
  getCloseEpochImpl,
  bumpCloseEpochImpl,
} from './manager/_deps';
export type { UpsertOptions } from './manager/_deps';
import { isExplicitSdkUserMessage } from './manager/explicit-user-message';
import {
  getSessionCloseFn,
  getSessionRenameHookFn,
} from './manager/hooks';
export {
  setSessionCloseFn,
  setSessionRenameHookFn,
} from './manager/hooks';
import {
  markRecentlyDeletedImpl,
  markDormantImpl,
  markClosedImpl,
  closeImpl,
  archiveImpl,
  unarchiveImpl,
  unarchiveOnUserSendImpl,
  reactivateImpl,
  setPinnedImpl,
  recordCreatedPermissionModeImpl,
  notifyTeamMembershipChangedImpl,
  deleteImpl,
  hasPendingCloseSideEffectsImpl,
  runClosedSideEffectsImpl,
  type ClosedSideEffectOptions,
} from './manager/lifecycle';
import { renameSdkSessionImpl, updateCliSessionIdImpl } from './manager/rename';
import {
  buildInitialSessionRecord,
  materializeInitialRegistration,
} from './manager/session-registration';
import {
  consumePendingSdkClaim as consumePendingSdkClaimImpl,
  expectPendingSdkSession,
} from './manager/sdk-pending-claim';
import { handOffCutoverCoordinator } from './hand-off/cutover-coordinator';
import { reactivateHandOffSource } from './hand-off/source-reactivation';

/**
 * Central AgentEvent ingress: persist, advance state, and notify the renderer. SDK ownership wins
 * over duplicate hook observation; time-based lifecycle advancement belongs to LifecycleScheduler.
 */
class SessionManagerClass {
  /** SDK-owned ids suppress duplicate hook events. Mutations use the public claim/release/rename APIs. */
  #sdkOwned = new Set<string>();

  /**
   * SDK 启动 CLI 子进程后到拿到真实 session_id 之前,hook 通道可能先一步上报。
   * 这段时间用 cwd 做"待领取"标记:hook 首次出现该 cwd 的新 session 时,
   * 把它主动 claim 为 SDK,并丢弃那条 hook 事件,避免出现「内/外」两份重复会话。
   */
  private pendingSdkCwds = new Map<string, number>(); // cwd → 失效时间戳

  /**
   * Short-lived deletion fence. Terminal deletion writes both application and CLI/native ids so
   * late SDK or hook events cannot recreate a row. A live CLI-id update fences only the retired CLI
   * id because the stable application id remains valid.
   *
   * Ingest first resolves CLI id → application id, then drops fenced tails, then applies pending-cwd
   * ownership claiming, and finally treats an unmatched event as an external session.
   */
  private recentlyDeleted = new Map<string, number>(); // cli_session_id (or applicationSid) → deletedAt

  /** Close intents increment an epoch so in-flight recovery aborts when terminal state changes. */
  private closeEpoch = new Map<string, number>();

  /** Frozen pipeline facade keeps SDK ownership behind its approved mutation methods. */
  private readonly ingestCtx: IngestContext;

  /** Shared lifecycle state excludes runtime-private SDK and pending-cwd ownership. */
  private readonly internalState: SessionManagerInternalState;

  constructor() {
    this.ingestCtx = Object.freeze<IngestContext>({
      hasSdkClaim: (sid) => this.hasSdkClaim(sid),
      claimAsSdk: (sid) => this.claimAsSdk(sid),
      consumePendingSdkClaim: (cwd) => this.consumePendingSdkClaim(cwd),
      ensure: (sid, opts) => this.ensure(sid, opts),
      isRecentlyDeleted: (sid) => this.isRecentlyDeleted(sid),
    });
    this.internalState = {
      recentlyDeleted: this.recentlyDeleted,
      closeEpoch: this.closeEpoch,
    };
  }

  claimAsSdk(sessionId: string): void {
    this.#sdkOwned.add(sessionId);
  }

  releaseSdkClaim(sessionId: string): void {
    this.#sdkOwned.delete(sessionId);
  }

  /**
   * 查 sid 是否被 SDK 通道接管(公开 API;test 反射 `as { sdkOwned }` 不再可用,
   * `#sdkOwned` 真私有强制走本 method)。与 IngestContext.hasSdkClaim 同源。
   */
  hasSdkClaim(sessionId: string): boolean {
    return this.#sdkOwned.has(sessionId);
  }

  /** SDK 即将拉起 cwd 上的会话;ttl 内任何 hook 通道首发的新 session 自动归 SDK 所有。
   *  cwd 经过 realpath + normalize,避免符号链接 / 尾斜杠差异导致漏匹配。 */
  expectSdkSession(cwd: string, ttlMs = 60_000): () => void {
    return expectPendingSdkSession(this.pendingSdkCwds, cwd, ttlMs);
  }

  private consumePendingSdkClaim(cwd: string): boolean {
    return consumePendingSdkClaimImpl(this.pendingSdkCwds, cwd);
  }

  /** 注册新会话或更新已有会话 */
  ensure(sessionId: string, opts: UpsertOptions): SessionRecord {
    const existing = sessionRepo.get(sessionId);
    if (existing) {
      const current = materializeInitialRegistration(sessionId, existing, opts);
      // Only an explicit SDK user message may reactivate a closed, unarchived session.
      // Terminal tails and passive hook/CLI events must not revive it; archive remains orthogonal.
      if (
        current.lifecycle === 'closed' &&
        current.archivedAt === null &&
        opts.reviveClosed === true
      ) {
        const revived: SessionRecord = {
          ...current,
          lifecycle: 'active',
          endedAt: null,
        };
        reactivateHandOffSource(sessionId, () => sessionRepo.upsert(revived));
        eventBus.emit('session-upserted', revived);
        return revived;
      }
      return current;
    }
    const rec = buildInitialSessionRecord(sessionId, opts, Date.now());
    sessionRepo.upsert(rec);
    eventBus.emit('session-upserted', rec);
    return rec;
  }

  /**
   * All adapter events enter here. Ownership deduplication must remain first and may return early;
   * otherwise a racing hook can materialize a duplicate external session before SDK claim.
   */
  ingest(event: AgentEvent): void {
    // Drop shutdown tails after an explicit DB close. An uninitialized DB still fails loudly so
    // startup wiring bugs are not hidden.
    if (isDbClosed()) return;
    // Hook ids are CLI/native identities. Resolve them to the stable application id before
    // ownership deduplication; deletion fencing covers both identities.
    const appSession = sessionRepo.findByCliSessionId(event.sessionId);
    if (appSession && appSession.id !== event.sessionId) {
      event = { ...event, sessionId: appSession.id };
    }

    // Explicit SDK user continuation may clear the short deletion fence; all other tails drop.
    if (this.isRecentlyDeleted(event.sessionId)) {
      if (!isExplicitSdkUserMessage(event)) return;
      this.clearRecentlyDeleted(event.sessionId);
    }

    if (dedupOrClaim(this.ingestCtx, event).skip) return;
    // Usage telemetry observes ownership/fencing but bypasses session creation, events, and activity.
    if (event.kind === 'token-usage') {
      persistTokenUsage(event);
      eventBus.emit('token-usage-changed', { sessionId: event.sessionId, ts: event.ts });
      return;
    }
    const record = ensureRecord(this.ingestCtx, event);
    persistEventRow(event);
    persistFileChange(event);
    advanceState(record, event);
    eventBus.emit('agent-event', event);
  }

  /** 黑名单 TTL 检查 thin delegate → manager/_deps.isRecentlyDeletedImpl。 */
  private isRecentlyDeleted(sessionId: string): boolean {
    return isRecentlyDeletedImpl(this.internalState, sessionId);
  }

  /**
   * 用户显式续聊应能打穿 close 路径的短 TTL 尾包黑名单。清理时同步覆盖
   * applicationSid + cliSessionId，避免后续同一轮恢复里的 assistant/tool 事件继续被 60s 黑名单误吞。
   */
  private clearRecentlyDeleted(sessionId: string): void {
    this.recentlyDeleted.delete(sessionId);
    const cliSid = sessionRepo.get(sessionId)?.cliSessionId;
    if (cliSid && cliSid !== sessionId) this.recentlyDeleted.delete(cliSid);
  }

  /** Fence both application and CLI/native identities after terminal deletion. */
  markRecentlyDeleted(sessionId: string, cliSessionId?: string | null): void {
    markRecentlyDeletedImpl(this.internalState, sessionId, cliSessionId);
  }

  hasPendingCloseSideEffects(sessionId: string): boolean {
    return hasPendingCloseSideEffectsImpl(sessionId);
  }

  runClosedSideEffects(
    sessionId: string,
    opts: ClosedSideEffectOptions,
  ): Promise<void> {
    return runClosedSideEffectsImpl(sessionId, opts);
  }

  /** thin delegate → manager/lifecycle.markDormantImpl (active → dormant)。 */
  markDormant(sessionId: string): void {
    markDormantImpl(sessionId);
  }

  /** thin delegate → manager/lifecycle.markClosedImpl (dormant/active → closed + side effects + close-epoch++)。 */
  markClosed(sessionId: string): void {
    markClosedImpl(this.internalState, sessionId);
  }

  /** thin delegate → manager/lifecycle.closeImpl (主动 close 含 adapter.closeSession + close-epoch++)。 */
  async close(sessionId: string): Promise<void> {
    await closeImpl(sessionId, getSessionCloseFn(), this.internalState);
  }

  /** Recovery compares this epoch with its baseline to detect a concurrent close or delete. */
  getCloseEpoch(sessionId: string): number {
    return getCloseEpochImpl(this.internalState, sessionId);
  }

  /** Scheduler batched close path: align its cancellation epoch with explicit close paths. */
  bumpCloseEpoch(sessionId: string): void {
    handOffCutoverCoordinator.revokeSource(sessionId);
    bumpCloseEpochImpl(this.internalState, sessionId);
  }

  /** Scheduler history purge path: release its per-session cancellation epoch. */
  forgetCloseEpoch(sessionId: string): void {
    this.closeEpoch.delete(sessionId);
    handOffCutoverCoordinator.restoreSource(sessionId);
  }

  /** thin delegate → manager/lifecycle.archiveImpl (setArchived + clearCwdReleaseMarker + team 联动)。 */
  async archive(sessionId: string): Promise<void> {
    await archiveImpl(sessionId);
  }

  /** thin delegate → manager/lifecycle.unarchiveImpl (clearArchived + team 联动)。 */
  async unarchive(sessionId: string): Promise<void> {
    await unarchiveImpl(sessionId);
  }

  /**
   * thin delegate → manager/lifecycle.unarchiveOnUserSendImpl (IPC AdapterSendMessage 主动信号
   * 仅当 archived 才调 unarchive)。
   */
  async unarchiveOnUserSend(sessionId: string): Promise<void> {
    await unarchiveOnUserSendImpl(sessionId, (sid) => this.unarchive(sid));
  }

  /** thin delegate → manager/lifecycle.reactivateImpl (closed → active 强制复活)。 */
  reactivate(sessionId: string): void {
    reactivateImpl(sessionId);
  }

  setPinned(sessionId: string, pinned: boolean): SessionRecord {
    return setPinnedImpl(sessionId, pinned);
  }

  /** thin delegate → manager/lifecycle.recordCreatedPermissionModeImpl (持久化 permission_mode)。 */
  recordCreatedPermissionMode(sessionId: string, mode: string | undefined): void {
    recordCreatedPermissionModeImpl(sessionId, mode);
  }

  /** thin delegate → manager/lifecycle.notifyTeamMembershipChangedImpl (universal team backend 写后 emit)。 */
  notifyTeamMembershipChanged(sessionId: string): void {
    notifyTeamMembershipChangedImpl(sessionId);
  }

  /** thin delegate → manager/lifecycle.deleteImpl (leaveTeams + sessionCloseFn + sessionRepo.delete + 黑名单双写)。 */
  async delete(sessionId: string): Promise<void> {
    await deleteImpl(this.internalState, sessionId, getSessionCloseFn());
  }

  /** Rename persistent identity first, then transfer the runtime-private SDK claim via callback. */
  renameSdkSession(fromId: string, toId: string): void {
    if (fromId === toId) return;
    renameSdkSessionImpl(this.internalState, fromId, toId, getSessionRenameHookFn(), {
      transferSdkClaim: () => {
        if (this.#sdkOwned.has(fromId)) {
          this.#sdkOwned.delete(fromId);
          this.#sdkOwned.add(toId);
        }
      },
    });
  }

  /** thin delegate → manager/rename.updateCliSessionIdImpl (反向 rename cli_session_id 单列 UPDATE)。 */
  updateCliSessionId(applicationSid: string, newCliSessionId: string): void {
    updateCliSessionIdImpl(this.internalState, applicationSid, newCliSessionId);
  }

  list(): SessionRecord[] {
    return enrichRecordsWithTeamsBatch(sessionRepo.listLiveForUi());
  }

  get(id: string): SessionRecord | null {
    const rec = sessionRepo.get(id);
    return rec ? enrichRecordWithTeams(rec) : null;
  }

  /** Public facade for attaching active universal-team membership to a session record. */
  enrichWithTeams(rec: SessionRecord): SessionRecord {
    return enrichRecordWithTeams(rec);
  }

  enrichWithTeamsBatch(recs: SessionRecord[]): SessionRecord[] {
    return enrichRecordsWithTeamsBatch(recs);
  }
}

export const sessionManager = new SessionManagerClass();
