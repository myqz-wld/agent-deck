import type {
  AgentEvent,
  SessionRecord,
  SessionSource,
} from '@shared/types';
import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import { deriveTitle, normalizeCwd } from './manager-helpers';
import { enrichRecordWithTeams, enrichRecordsWithTeamsBatch } from './manager-enrich';
import {
  leaveTeamsAndAutoArchive,
  archiveTeamsIfOrphaned,
  unarchiveTeamsForRevivedLead,
} from './manager-team-coordinator';
import {
  type IngestContext,
  dedupOrClaim,
  ensureRecord,
  persistEventRow,
  persistFileChange,
  advanceState,
} from './manager-ingest-pipeline';

/**
 * SessionManager 不直接 import adapterRegistry（避免反向依赖 + 单职责），
 * 启动时 index.ts 通过 setSessionCloseFn 注入「按 sessionId 关 SDK 侧 live query」的 hook。
 * delete() 调用前者，让 SDK bridge 同步 abort + 清 internal session 与 pending Maps（CHANGELOG_20 / N2）。
 */
type SessionCloseFn = (agentId: string, sessionId: string) => Promise<void>;
let sessionCloseFn: SessionCloseFn | null = null;
export function setSessionCloseFn(fn: SessionCloseFn | null): void {
  sessionCloseFn = fn;
}

/**
 * 创建 / 更新 SessionRecord 的入参契约。export 是为 manager-ingest-pipeline.ts
 * 的 IngestContext.ensure 签名共享类型（CHANGELOG_86 Step 4.3.3 facade 契约）。
 */
export interface UpsertOptions {
  agentId: string;
  cwd?: string;
  title?: string;
  source?: SessionSource;
}

/**
 * SessionManager 是 AgentEvent 的中央汇集点。所有 adapter 都通过 ingest()
 * 把事件灌入这里，由它统一更新数据库 + 推动状态机 + 广播给渲染端。
 *
 * activity 状态机由本类直接维护；lifecycle 由 LifecycleScheduler 负责（M5）。
 *
 * 去重：Claude Code 的会话可能同时被 SDK 通道（query AsyncGenerator）和
 * Hook 通道（settings.json 注入的 hook）观测到。SDK 通道粒度更细，因此
 * 一旦 ClaudeSdkBridge 调用 claimAsSdk(sessionId)，后续来自 hook 的
 * 同 id 事件会被丢弃。
 */
class SessionManagerClass {
  /**
   * 由 SDK 通道接管的会话 id，hook 同 id 事件会被丢弃。
   *
   * ECMAScript `#private` 真私有（runtime 强制不可访问）：cast `(this as any).#sdkOwned`
   * 与 `(sessionManager as any).sdkOwned` 都拿不到 raw Set，外部探查 / 测试反射统一走
   * 公开 `hasSdkClaim(sid)` API。任何 mutate 走 `claimAsSdk` / `releaseSdkClaim` / `renameSdkSession`
   * 三个公开入口（claim 单一入口不变量）。
   */
  #sdkOwned = new Set<string>();

  /**
   * SDK 启动 CLI 子进程后到拿到真实 session_id 之前，hook 通道可能先一步上报。
   * 这段时间用 cwd 做"待领取"标记：hook 首次出现该 cwd 的新 session 时，
   * 把它主动 claim 为 SDK，并丢弃那条 hook 事件，避免出现「内/外」两份重复会话。
   */
  private pendingSdkCwds = new Map<string, number>(); // cwd → 失效时间戳

  /**
   * 最近被 delete 的 sessionId 黑名单（REVIEW_4 H1 兜底）。
   * SDK 已用 `intentionallyClosed` 屏蔽 close 后 catch 路径的 emit；这里再加一道：
   * 删除窗口内（60s）任何来源的尾包都直接丢弃，避免 ensureRecord 把 sessionRepo.get 已 null
   * 的 sessionId 当成首次见到 → 新建 record 复活成幽灵。
   * 60s 远大于任何 SDK 收尾延时，但又不长到无意义占内存。
   */
  private recentlyDeleted = new Map<string, number>(); // sessionId → deletedAt
  private static readonly RECENTLY_DELETED_TTL_MS = 60_000;

  /**
   * Pipeline 看到的 facade（Object.freeze 的 5 方法对象）。
   * 闭包封装 raw state，pipeline 函数 cast `(ctx as any).sdkOwned` 返回 undefined
   * （cast 路径不可达），保护 claim 单一 mutating 入口不变量。CHANGELOG_86 Step 4.3.3。
   */
  private readonly ingestCtx: IngestContext;

  constructor() {
    this.ingestCtx = Object.freeze<IngestContext>({
      hasSdkClaim: (sid) => this.hasSdkClaim(sid),
      claimAsSdk: (sid) => this.claimAsSdk(sid),
      consumePendingSdkClaim: (cwd) => this.consumePendingSdkClaim(cwd),
      ensure: (sid, opts) => this.ensure(sid, opts),
      isRecentlyDeleted: (sid) => this.isRecentlyDeleted(sid),
    });
  }

  claimAsSdk(sessionId: string): void {
    this.#sdkOwned.add(sessionId);
  }

  releaseSdkClaim(sessionId: string): void {
    this.#sdkOwned.delete(sessionId);
  }

  /**
   * 查 sid 是否被 SDK 通道接管（公开 API；test 反射 `as { sdkOwned }` 不再可用，
   * `#sdkOwned` 真私有强制走本 method）。与 IngestContext.hasSdkClaim 同源。
   */
  hasSdkClaim(sessionId: string): boolean {
    return this.#sdkOwned.has(sessionId);
  }

  /** SDK 即将拉起 cwd 上的会话；ttl 内任何 hook 通道首发的新 session 自动归 SDK 所有。
   *  cwd 经过 realpath + normalize，避免符号链接 / 尾斜杠差异导致漏匹配。 */
  expectSdkSession(cwd: string, ttlMs = 60_000): () => void {
    const key = normalizeCwd(cwd);
    const expiresAt = Date.now() + ttlMs;
    this.pendingSdkCwds.set(key, expiresAt);
    console.log(`[session-mgr] expect sdk session @ ${key} (ttl ${ttlMs}ms)`);
    return () => {
      if (this.pendingSdkCwds.get(key) === expiresAt) {
        this.pendingSdkCwds.delete(key);
      }
    };
  }

  private consumePendingSdkClaim(cwd: string): boolean {
    const key = normalizeCwd(cwd);
    const expiresAt = this.pendingSdkCwds.get(key);
    if (expiresAt && Date.now() <= expiresAt) {
      this.pendingSdkCwds.delete(key);
      return true;
    }
    if (expiresAt) this.pendingSdkCwds.delete(key);
    return false;
    // 注：`/private/var ↔ /var` 这类 macOS 别名差异已经被 normalizeCwd 内的
    // realpathSync 解决（两端都返回 canonical 路径）。早期版本曾用「池子 size===1
    // 就 fuzzy 兜底」，但这条会把同时段在别的 cwd 跑的外部 CLI hook 误 claim
    // 进 sdkOwned，后续事件被静默吞掉，会话凭空消失。任何新别名场景都应在
    // normalizeCwd 内具体加规则，不要再回到全局 fuzzy。
  }

  /** 注册新会话或更新已有会话 */
  ensure(sessionId: string, opts: UpsertOptions): SessionRecord {
    const existing = sessionRepo.get(sessionId);
    if (existing) {
      // 收到新事件 → 复活：closed 推回 active。
      // 注意：归档（archivedAt）与 lifecycle 正交，是用户的主动隐藏意图，
      // 不能因为后续事件流就自动 unarchive，否则用户刚归档的 active 会话
      // 下一秒收到 hook 事件就被默默放回实时面板，违背 CLAUDE.md「正交」约定。
      // 取消归档必须由 unarchive() 显式调用。
      if (existing.lifecycle === 'closed') {
        const revived: SessionRecord = {
          ...existing,
          lifecycle: 'active',
          endedAt: null,
        };
        sessionRepo.upsert(revived);
        eventBus.emit('session-upserted', revived);
        return revived;
      }
      return existing;
    }
    const now = Date.now();
    const rec: SessionRecord = {
      id: sessionId,
      agentId: opts.agentId,
      cwd: opts.cwd ?? '',
      title: opts.title ?? deriveTitle(opts.cwd ?? sessionId),
      source: opts.source ?? 'cli',
      lifecycle: 'active',
      activity: 'idle',
      startedAt: now,
      lastEventAt: now,
      endedAt: null,
      archivedAt: null,
    };
    sessionRepo.upsert(rec);
    eventBus.emit('session-upserted', rec);
    return rec;
  }

  /**
   * 入口：adapter 发来的所有 AgentEvent 都走这里。
   *
   * 拆 5 段（CHANGELOG_20 / B）：dedupOrClaim → ensureRecord → persistEventRow →
   * persistFileChange → advanceState。每段单一职责、可单测。5 段实现 + IngestContext
   * facade 见 manager-ingest-pipeline.ts（CHANGELOG_86 Step 4.3.3）。
   *
   * **硬约束**：dedupOrClaim 必须留在最前 + 早返；否则 hook 首发竞争场景会先落一份假 CLI 会话
   * 再 claim，UI 会闪现「内/外两份」。CHANGELOG_16 / REVIEW_1 修过、payload-truncate 测试覆盖。
   */
  ingest(event: AgentEvent): void {
    // REVIEW_4 H1 兜底：删除窗口内的尾包（无论 sdk/hook）一律静默丢弃，
    // 避免已删 session 在 ensureRecord 里复活成幽灵 record。
    // sdk-bridge 的 intentionallyClosed 标记是第一道防线（屏蔽 catch 路径 emit），
    // 这里是第二道（防御 stream 已经 emit 但还没到 ingest 的 in-flight 事件）。
    if (this.isRecentlyDeleted(event.sessionId)) return;
    if (dedupOrClaim(this.ingestCtx, event).skip) return;
    const record = ensureRecord(this.ingestCtx, event);
    persistEventRow(event);
    persistFileChange(event);
    advanceState(record, event);
    // 4. 广播原始事件给渲染端
    eventBus.emit('agent-event', event);
  }

  /** 黑名单 TTL 检查：超时自动从 Map 删，避免 ingest 路径累积无效 entry。 */
  private isRecentlyDeleted(sessionId: string): boolean {
    const at = this.recentlyDeleted.get(sessionId);
    if (at === undefined) return false;
    if (Date.now() - at > SessionManagerClass.RECENTLY_DELETED_TTL_MS) {
      this.recentlyDeleted.delete(sessionId);
      return false;
    }
    return true;
  }

  /**
   * REVIEW_12 Bug 5 双保险：把 sessionId 加进 recentlyDeleted 黑名单，覆盖
   * 「closeSession 主动关闭后，OLD CLI 子进程异步飞回的迟到 hook event 仍带 OLD_ID」窗口。
   *
   * 设计上与 SessionManager.delete + renameSdkSession 对称——三个入口任一关掉某 sessionId
   * 都应保证后续 60s 内同 sessionId 的 hook event 被 ingest 入口 isRecentlyDeleted 直接丢弃。
   * sdk-bridge.ts:closeSession 调本方法 + 内部已配 hookOrigin='sdk' 兜底（REVIEW_12 主修法），
   * 双保险确保 origin tag 升级前的老 hook 命令（settings.json 残留）路径也能挡住。
   */
  markRecentlyDeleted(sessionId: string): void {
    this.recentlyDeleted.set(sessionId, Date.now());
  }

  /** lifecycle scheduler 用：把 active 推到 dormant */
  markDormant(sessionId: string): void {
    const r = sessionRepo.get(sessionId);
    if (!r || r.lifecycle !== 'active') return;
    sessionRepo.setLifecycle(sessionId, 'dormant', Date.now());
    const updated = sessionRepo.get(sessionId);
    if (updated) eventBus.emit('session-upserted', updated);
  }

  /** lifecycle scheduler 用：把 dormant 推到 closed */
  markClosed(sessionId: string): void {
    const r = sessionRepo.get(sessionId);
    if (!r || (r.lifecycle !== 'dormant' && r.lifecycle !== 'active')) return;
    sessionRepo.setLifecycle(sessionId, 'closed', Date.now());
    const updated = sessionRepo.get(sessionId);
    if (updated) eventBus.emit('session-upserted', updated);
    // plan team-cohesion-fix-20260513 Phase F D6：被动清理 — closed session 自动 leave
    // 所有 active team membership（否则 universal team backend 仍把 closed session 算
    // active member，UI 看到一堆「已 closed 但仍在 team」的幽灵成员）。fire-and-forget
    // 异步跑，不阻塞 markClosed 的同步语义。helper 实现见 manager-team-coordinator.ts。
    void leaveTeamsAndAutoArchive(sessionId, 'closed').catch((err) => {
      console.warn(`[session-mgr] leaveTeamsAndAutoArchive failed during markClosed(${sessionId}):`, err);
    });
  }

  /**
   * 主动 close（R2 / B'0 ADR §6.5.2 #7）：与 `delete` 不同，不删 DB 行，仅：
   * - 调 adapter.closeSession（abort SDK live query/turn + 清 pending Maps）
   * - sessionRepo.setLifecycle(id, 'closed')
   * - emit `session-upserted`（让 renderer 显示 closed 标记，不消失）
   *
   * 用途：MCP `shutdown_session` tool。**不调 sessionRepo.delete** 避免 ON DELETE
   * CASCADE 把 events / file_changes / summaries 全部级联删掉（reviewer 双对抗
   * HIGH-4 修法：deep-code-review 场景 lead 需要 reviewer shutdown 后引用其输出
   * 做三态裁决，hard-delete 致命）。
   *
   * 与 LifecycleScheduler.markClosed 的区别：markClosed 仅 setLifecycle，**不**调
   * adapter.closeSession（scheduler 是「时间到自然衰减」，session 仍在跑就让它跑完
   * 自己结束）；close(id) 是「立即终止」语义，必须把 SDK 子进程也关掉。
   */
  async close(sessionId: string): Promise<void> {
    const session = sessionRepo.get(sessionId);
    if (!session) return; // 已删 / 从未存在 → noop
    if (session.agentId && sessionCloseFn) {
      try {
        await sessionCloseFn(session.agentId, sessionId);
      } catch (err) {
        console.warn(`[session-mgr] adapter close failed during close(): ${sessionId}`, err);
      }
    }
    sessionRepo.setLifecycle(sessionId, 'closed', Date.now());
    const updated = sessionRepo.get(sessionId);
    if (updated) eventBus.emit('session-upserted', updated);
    // plan team-cohesion-fix-20260513 Phase F D6：与 markClosed 同款被动清理。await 而非
    // fire-and-forget（close 已 async，等 leaveTeam 完成再返回让 caller 拿到稳定状态：
    // 比如 IPC TeamShutdownAllTeammates 串行调多个 close 期望每个 close 完后该 sid 已离 team）。
    await leaveTeamsAndAutoArchive(sessionId, 'closed');
  }

  async archive(sessionId: string): Promise<void> {
    // 只设归档标记，不动 lifecycle —— 这样取消归档可以恢复原本的生命周期。
    sessionRepo.setArchived(sessionId, Date.now());
    const updated = sessionRepo.get(sessionId);
    if (updated) eventBus.emit('session-upserted', updated);
    // bug 修复（plan deep-review-and-split-20260513）：lead session 被归档后，
    // 联动检查所属 active team 是否已无 active lead → auto-archive team。
    // membership 不动（lead 没真离开），countActiveLeads 已加 INNER JOIN sessions
    // archived_at IS NULL 过滤，本 sid 自动从计数中去除。helper 实现见 manager-team-coordinator.ts。
    await archiveTeamsIfOrphaned(sessionId);
  }

  async unarchive(sessionId: string): Promise<void> {
    // 取消归档：清掉 archived_at，lifecycle 保留不变，
    // 会话自动按真实 lifecycle 出现在对应面板（active/dormant→实时，closed→历史）。
    sessionRepo.setArchived(sessionId, null);
    const updated = sessionRepo.get(sessionId);
    if (updated) eventBus.emit('session-upserted', updated);
    // bug 修复（unarchive 联动）：lead session 复活时，所有该 session 还是 active member
    // 且已 archived 的 team 一并 unarchive（覆盖 archive 联动的反向）。helper 实现见
    // manager-team-coordinator.ts；REVIEW_32 MED-7 守门只复活 'last-lead-archived'。
    await unarchiveTeamsForRevivedLead(sessionId);
  }

  /**
   * plan mcp-bug-and-feature-batch-20260513 N bug fix: 用户主动 sendMessage / resume 触发的
   * 「显式信号」自动 unarchive 入口。与「事件流被动到达 → archived 不动」（manager.ts:152-156
   * 正交约定）严格区分。
   *
   * - 已 archived（archivedAt 非 null）→ 调 unarchive() 清 archived_at + emit upsert + team
   *   unarchive 联动
   * - 未 archived（archivedAt = null）→ noop（不 emit / 不跑 team coordinator 多余工作）
   * - 不存在的 sid → noop（caller 自己处理 not-found）
   *
   * lifecycle 与 unarchive() 同款不动：dormant 仍 dormant、active 仍 active；
   * closed 也保持（caller 后续 ingest event 会走 ensure() closed→active 复活路径，正交）。
   *
   * **唯一调用入口**：IPC AdapterSendMessage handler（src/main/ipc/adapters.ts），是
   * 用户从 UI / CLI 显式 sendMessage 的桥点。mcp tool send_message 走 universal-message-watcher
   * 不经此 API（cross-session 程序化通信不算「用户主动续聊归档会话」UX 信号）。
   */
  async unarchiveOnUserSend(sessionId: string): Promise<void> {
    const r = sessionRepo.get(sessionId);
    if (!r || r.archivedAt === null) return;
    await this.unarchive(sessionId);
  }

  reactivate(sessionId: string): void {
    const r = sessionRepo.get(sessionId);
    if (!r) return;
    sessionRepo.setLifecycle(sessionId, 'active', Date.now());
    const updated = sessionRepo.get(sessionId);
    if (updated) eventBus.emit('session-upserted', updated);
  }

  /**
   * 创建会话后把用户选过的 permissionMode 持久化到 sessions 列。
   * IPC 路径（renderer 新建对话框）和 CLI 路径（agent-deck new --permission-mode ...）
   * 都要调用，否则两条入口语义会飘：UI 显示 default 但 SDK 实际是 plan，
   * 或者反过来，跟实际状态对不上。'default' 等价于不设（不污染 CLI 通道列），
   * 其他值（acceptEdits / plan / bypassPermissions）才写入。
   */
  recordCreatedPermissionMode(sessionId: string, mode: string | undefined): void {
    if (!mode || mode === 'default') return;
    sessionRepo.setPermissionMode(
      sessionId,
      mode as Parameters<typeof sessionRepo.setPermissionMode>[1],
    );
    const updated = sessionRepo.get(sessionId);
    if (updated) eventBus.emit('session-upserted', updated);
  }

  /**
   * plan team-cohesion-fix-20260513 Phase A：universal team backend 写入（addMember /
   * leaveTeam / setRole）后调用，触发被影响 session 的 session-upserted → 桥点重新 enrich →
   * renderer 立即看到 teams[] 变化（chip 出现 / 消失 / 角色切换）。
   *
   * 不在 agentDeckTeamRepo.addMember 内自动 emit（repo 层职责单一，不知道 eventBus）；
   * 也不在 mcp/tools.ts handler 内直接 import eventBus（避免 mcp 模块依赖 main event 系统）。
   * 走 sessionManager facade 是干净中间层。
   */
  notifyTeamMembershipChanged(sessionId: string): void {
    const rec = sessionRepo.get(sessionId);
    if (rec) eventBus.emit('session-upserted', rec);
  }

  async delete(sessionId: string): Promise<void> {
    // R3.E0 ADR §2.5：pre-check + 自动 leaveTeam（agent_deck_team_members.session_id ON DELETE
    // RESTRICT FK 拦下 sessions DELETE，必须先 leaveTeam）。**必须 await** —— 后续
    // sessionRepo.delete 依赖 leaveTeam 已写 left_at，否则 FK 抛错 → DB 半态。
    // 实现合并到 manager-team-coordinator.ts 的 leaveTeamsAndAutoArchive(sid, 'deleted')，
    // 与 close/markClosed 路径共享同一逻辑入口；archive reason 由 'deleted' 参数 explicit 区分
    // ('last-lead-deleted' vs 'last-lead-closed'，事件流 / DB 投影 100% 等价于原 _leaveAllActiveTeams
    //  + delete 段 1 双段实现）。
    await leaveTeamsAndAutoArchive(sessionId, 'deleted');
    // REVIEW_4 H1：必须 **await** close 完成再删 DB 行 + 广播。
    // 旧版 fire-and-forget close → DB 同步 delete 后，SDK 侧 abort 触发的尾包
    // `finished{subtype:interrupted}` 仍会到达 ingest → ensureRecord 把已删 session
    // 复活成 lifecycle:active 的幽灵 record + 多通知一条「Agent 完成」。
    // 现在 close 内部已用 `intentionallyClosed` 标记屏蔽 runTurnLoop catch 的 emit
    // （sdk-bridge 层），manager 这边 await 是双保险：确保 abort + close 路径都跑完
    // 才删行 + 广播 'session-removed'，renderer 不会先看到「已删」再看到尾包复活。
    //
    // close 抛错只 warn —— DB 行不能因为 SDK 回收失败留着，孤儿状态更糟。
    const session = sessionRepo.get(sessionId);
    if (session?.agentId && sessionCloseFn) {
      try {
        await sessionCloseFn(session.agentId, sessionId);
      } catch (err) {
        console.warn(`[session-mgr] close on delete failed: ${sessionId}`, err);
      }
    }
    sessionRepo.delete(sessionId);
    // REVIEW_4 H1：把 id 加入「最近删除黑名单」60s，ingest 看到该 id 直接丢弃，
    // 防 SDK 流终止 / 异常 stream 的尾包在 sessionRepo.delete 后到达 ensureRecord。
    this.recentlyDeleted.set(sessionId, Date.now());
    eventBus.emit('session-removed', sessionId);
  }

  /**
   * 把 fromId 的 sessions 行 + 子表引用整体迁到 toId（保留所有事件 / 文件改动 / 总结），
   * 然后通知 renderer 同步迁移 selectedId / by-session 状态。
   * 用于 SDK fallback 路径：tempKey 占位 → 真实 session_id 出现后无损切换，
   * 用户保持在 detail，不被踢回主界面。
   *
   * REVIEW_7 M3：sdkOwned claim 由本函数原子转移（fromId → toId），调用方不再手工管。
   * 旧版调用方需在 rename 前后自己 release(fromId) + claim(toId)；fork 路径只 release
   * 不 claim 时 NEW_ID 未被 sdkOwned 覆盖，window 期间 hook 通道抢先 NEW_ID 事件会走
   * 「未 claim」分支造另一条 record（虽然概率极低）。内聚后所有调用方拿到同一保证。
   */
  renameSdkSession(fromId: string, toId: string): void {
    if (fromId === toId) return;
    sessionRepo.rename(fromId, toId);
    if (this.#sdkOwned.has(fromId)) {
      this.#sdkOwned.delete(fromId);
      this.#sdkOwned.add(toId);
    }
    // rename 走 INSERT NEW + DELETE OLD 路径，OLD_ID 在 DB 已不存在。把 OLD_ID 加进
    // 「最近删除黑名单」60s，跟 SessionManager.delete 同等对待——OLD CLI 子进程在
    // close 后异步飞的迟到 hook event（典型：approve-bypass 冷切场景下 SIGTERM 后
    // 还在飞 SessionEnd hook）会被 ingest 入口 isRecentlyDeleted 直接丢弃，
    // 不会进 ensureRecord 复活成一条 source='cli' 的孤儿会话。覆盖所有 rename 场景：
    // SDK fallback 的 tempKey→realId、CLI 隐式 fork 的 OLD→NEW、bypass 冷切的 close+restart。
    this.recentlyDeleted.set(fromId, Date.now());
    eventBus.emit('session-renamed', { from: fromId, to: toId });
    const updated = sessionRepo.get(toId);
    if (updated) eventBus.emit('session-upserted', updated);
  }

  list(): SessionRecord[] {
    return enrichRecordsWithTeamsBatch(sessionRepo.listActiveAndDormant());
  }

  get(id: string): SessionRecord | null {
    const rec = sessionRepo.get(id);
    return rec ? enrichRecordWithTeams(rec) : null;
  }

  /**
   * 公共 API thin wrapper：把 universal team backend 的 active membership 拼装到
   * SessionRecord.teams 字段。实际逻辑搬到 manager-enrich.ts free function；class 方法
   * 保留是为外部 caller（src/main/index.ts:236 桥点 / ipc/sessions.ts / mcp/handlers/list.ts）
   * 公共 API 签名不变。CHANGELOG_86 Step 4.3.1。
   */
  enrichWithTeams(rec: SessionRecord): SessionRecord {
    return enrichRecordWithTeams(rec);
  }

  enrichWithTeamsBatch(recs: SessionRecord[]): SessionRecord[] {
    return enrichRecordsWithTeamsBatch(recs);
  }
}

export const sessionManager = new SessionManagerClass();
