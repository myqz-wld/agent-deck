import type {
  AgentEvent,
  SessionRecord,
  SessionSource,
} from '@shared/types';
import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
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
 * plan codex-handoff-team-alignment-20260518 P2 Step 2.8 / 不变量 7：rename 同步必须在
 * `sessionManager.renameSdkSession` 函数体内统一调（与 sdkOwned 转移同款保证），不能让
 * caller（codex bridge thread-loop / sdk-bridge recoverer）各自调（漏调风险）。
 *
 * SessionManager 不直接 import 各 adapter bridge（避免反向依赖 + 单职责），main bootstrap
 * 通过 setSessionRenameHookFn 注入「按 agentId 派发 rename hook」回调，让 SessionManager
 * 在 renameSdkSession 函数体末尾同步调到 bridge.renameCodexInstance / 其他 adapter 的同款
 * method（claude adapter 走 in-process MCP transport,closure override,不需 token map rename,
 * hook 可以 noop）。
 *
 * 同步执行（不走事件订阅）：renameSdkSession 调用方依赖 rename 完成后立即看到一致的
 * sdkOwned + token map + per-session bridge instance map 三处 key 同步迁移。
 */
type SessionRenameHookFn = (agentId: string, fromId: string, toId: string) => void;
let sessionRenameHookFn: SessionRenameHookFn | null = null;
export function setSessionRenameHookFn(fn: SessionRenameHookFn | null): void {
  sessionRenameHookFn = fn;
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
  /**
   * 最近被 delete 的 cli_session_id 黑名单（REVIEW_4 H1 兜底 + R5 HIGH-R5-1 / R6 MED-R6-1
   * + R5 MED-R5-1 黑名单分场景双写升级)。
   * SDK 已用 `intentionallyClosed` 屏蔽 close 后 catch 路径的 emit；这里再加一道：
   * 删除窗口内（60s）任何来源的尾包都直接丢弃，避免 ensureRecord 把 sessionRepo.get 已 null
   * 的 sessionId 当成首次见到 → 新建 record 复活成幽灵。
   * 60s 远大于任何 SDK 收尾延时，但又不长到无意义占内存。
   *
   * **plan reverse-rename-sid-stability-20260520 §A.3 / §D7 黑名单分场景升级**:
   * Map<string, number> 结构本身不动,key 语义按场景分:
   * - **updateCliSessionId 活跃路径** (反向 rename 6 处场景): 仅黑 OLD_CLI_ID
   *   (applicationSid 仍 active 不可拒,详 sessionManager.updateCliSessionId helper)
   * - **delete / close / markRecentlyDeleted 路径** (会话结束兜底场景): 双写
   *   `{applicationSid, cliSessionId}` 黑名单 (反向 rename 后 SDK 尾包用 appSid 来 /
   *   hook 尾包用 cliSid 来,黑名单必须双 key 覆盖才能挡住所有来源)
   *
   * **ingest 4 态分流** (manager.ts:219 入口,详 plan §A.3):
   * - 3a: findByCliSessionId(eventSid) 命中 → 覆写 event.sessionId 走原 dedupOrClaim 5 段流程
   * - 3b: 不命中 + isRecentlyDeleted(eventSid) 命中 → drop 迟到 event
   * - 3c: 不命中 + 不在黑名单 + cwd 命中 pendingSdkCwds → 走原 dedupOrClaim 时序兜底 claim+skip (REVIEW_5 H1 / REVIEW_12 修法保留)
   * - 3d: 全没命中 → 走原 ensureRecord 建外部 CLI 会话 (现状 fallback 不变)
   */
  private recentlyDeleted = new Map<string, number>(); // cli_session_id (or applicationSid) → deletedAt
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
    // plan reverse-rename-sid-stability-20260520 §A.3 / §D7 / §不变量 5 修订:
    // ingest 入口 4 态分流 — hook event sessionId 是 CLI thread sid 维度 (translate.ts:31
    // sessionId: p.session_id 来自 hook payload),反向 rename 后 cli_session_id 与
    // sessions.id (applicationSid) 解耦,需先 findByCliSessionId 反查覆写为 appSid。
    //
    // 3a: findByCliSessionId(eventSid) 命中 → 覆写 event.sessionId 走原 dedupOrClaim 5 段
    // 3b: 不命中 + isRecentlyDeleted(originalEventSid) 命中 → drop 迟到 event
    // 3c: 不命中 + 不在黑名单 + cwd 命中 pendingSdkCwds → 走原 dedupOrClaim 时序兜底 claim+skip
    //     (REVIEW_5 H1 / REVIEW_12 修法保留,在 dedupOrClaim 内部分支处理)
    // 3d: 全没命中 → 走原 ensureRecord 建外部 CLI 会话 (现状 fallback,不变)
    //
    // **不变量 5 (黑名单链)**: 反向 rename 后 SDK 尾包用 appSid 来 / hook 尾包用 cliSid 来,
    // delete/close 路径黑名单双写 {appSid, cliSid} 才能挡住所有来源 (R5 MED-R5-1 修订)。
    // 检查 originalEventSid (而非反查后的 appSid) — 因为黑名单双写后两 key 都能命中。

    // **3a**: findByCliSessionId 反查 — 反向 rename 后命中场景才覆写
    const appSession = sessionRepo.findByCliSessionId(event.sessionId);
    if (appSession && appSession.id !== event.sessionId) {
      // 反向 rename 后 cliSid 与 appSid 不同 — 覆写 event.sessionId 走应用 sid 维度
      event = { ...event, sessionId: appSession.id };
    }
    // 注:appSession === null 或 appSession.id === event.sessionId (历史 row backfill cli_session_id == id 场景)
    // 时不需覆写,直接走原路径

    // **3b**: 黑名单检查 — 用原始 event.sessionId 维度 (黑名单双写后 cliSid 和 appSid 都能命中)
    // 注:覆写后 event.sessionId 已是 appSid,但 isRecentlyDeleted 双写黑名单两个 key 都能命中,
    // 用 event.sessionId (覆写后 appSid 或未覆写 cliSid) 都正确
    if (this.isRecentlyDeleted(event.sessionId)) return;

    // **3c + 3d**: dedupOrClaim 内部时序兜底 (REVIEW_5 H1 / REVIEW_12 修法保留) → ensureRecord 建会话
    // 与原 ingest 5 段流程保持不变 (dedupOrClaim 必须留在最前 + 早返硬约束)
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
   *
   * **plan reverse-rename-sid-stability-20260520 §A.3 / R5 MED-R5-1 双写升级**:
   * 反向 rename 后 SDK 尾包用 appSid 来 / hook 尾包用 cliSid 来,黑名单必须**双写**
   * `{applicationSid, cliSessionId}` 才能挡住所有来源。caller 入参 sessionId 通常是
   * applicationSid (sdk-bridge.ts closeSession 路径),但鲁棒兼容传 cliSid 也能写入。
   *
   * caller 不存在 sessions row 时(已删) → rec=null,只 set sessionId 入参一个 key
   * (兜底防御:行已不存在但 caller 仍主动加黑名单,典型 closeSession 时 sessions row
   * 已被 sessionRepo.delete 清的边角)。
   */
  markRecentlyDeleted(sessionId: string): void {
    const now = Date.now();
    this.recentlyDeleted.set(sessionId, now);
    // R5 MED-R5-1 双写:从 sessionRepo 反查 cliSessionId,与 sessionId 不同时也写入黑名单
    // (反向 rename 后 sessionId 通常是 appSid,cliSid 是另一 key 维度,需双写覆盖)
    const rec = sessionRepo.get(sessionId);
    const cliSid = rec?.cliSessionId;
    if (cliSid && cliSid !== sessionId) {
      this.recentlyDeleted.set(cliSid, now);
    }
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
    // plan codex-handoff-team-alignment-20260518 P5 Round 1 reviewer-claude MED-4 修法:
    // 联动清 cwd_release_marker (worktree 持有标记是 transient session state,close 后必清避免
    // 被 SDK 隐式 fork rename 路径复制到新 sid 触发 archive_plan 状态 4 误 reject)。
    // 三入口 (markClosed / close / archive) 统一 — 详 v020 SQL 注释。
    sessionRepo.clearCwdReleaseMarker(sessionId);
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
    // plan codex-handoff-team-alignment-20260518 P5 Round 1 reviewer-claude MED-4 修法:
    // 联动清 cwd_release_marker (与 markClosed 同款,详 markClosed 处注释)。
    sessionRepo.clearCwdReleaseMarker(sessionId);
    const updated = sessionRepo.get(sessionId);
    if (updated) eventBus.emit('session-upserted', updated);
    // plan codex-handoff-team-alignment-20260518 P2 Step 2.9：释放 per-session mcp token map
    // entry(双向 map 双 entry 同步清)。codex bridge.closeSession 已经在 sub-step 2.5d 内做过
    // mcpSessionTokenMap.release 一次,这里再做一次走 noop fast-path(token map 不在则静默退出),
    // 不影响幂等。手动 close (从 IPC / Detail UI 触发) 而非 codex bridge.closeSession 走的路径
    // 也保证 token map 清干净 (若 close 没经 adapter.closeSession ⇒ token leak)。
    mcpSessionTokenMap.release(sessionId);
    // plan team-cohesion-fix-20260513 Phase F D6：与 markClosed 同款被动清理。await 而非
    // fire-and-forget（close 已 async，等 leaveTeam 完成再返回让 caller 拿到稳定状态：
    // 比如 IPC TeamShutdownAllTeammates 串行调多个 close 期望每个 close 完后该 sid 已离 team）。
    await leaveTeamsAndAutoArchive(sessionId, 'closed');
  }

  async archive(sessionId: string): Promise<void> {
    // 只设归档标记，不动 lifecycle —— 这样取消归档可以恢复原本的生命周期。
    sessionRepo.setArchived(sessionId, Date.now());
    // R2 reviewer-codex MED 修法:archive() 同步清 cwd_release_marker。
    // 推理链:hand_off_session / archive_plan baton phase 2 调本 archive(callerSid) →
    // 仅打 archived_at 不清 marker → caller 后续被 unarchiveOnUserSend 复活 → 仍带旧 worktree
    // marker(指向 archive_plan 已删的 worktree path,marker 指向 stale 路径)→ 复活后调
    // archive_plan / 4 态 cwd dispatch 走 cwdReleaseMarker thunk(archive-plan-impl.ts:627)
    // 拿 stale marker 撞 cross-worktree warning / cwd invalid reject。
    // archive 语义 = caller 使命终结;复活时 marker 应已清空(unarchive 后 caller 应重新
    // EnterWorktree 才能再次 hold worktree state),清 marker 是符合预期的副作用。
    sessionRepo.clearCwdReleaseMarker(sessionId);
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
    // R3.E0 ADR §2.5 + plan linked-swimming-platypus (v017)：
    // v017 起 agent_deck_team_members.session_id FK 改 ON DELETE CASCADE，
    // sessions DELETE 自动级联清 team_members rows，不再需要 leaveTeam pre-check 绕 FK。
    // 历史 v010-v016 期间靠 leaveTeam 写 left_at 然后 sessionRepo.delete「兜底」实际**失效**
    // （RESTRICT 不在乎 left_at 是否非空，DELETE 仍撞 FK，bug 隐藏未触发）—— v017 修正。
    //
    // leaveTeamsAndAutoArchive 仍 await 调用是为了正确顺序：
    // 1. 写 left_at + emit 'agent-deck-team-member-changed' 让 TeamHub / TeamDetail 立刻刷新
    // 2. 0-active-lead 触发 team auto-archive + emit 'agent-deck-team-updated'
    // 3. 然后 sessionRepo.delete 走 CASCADE 物理清 row（作为 archive 之后的清理收尾）
    // 顺序颠倒（先 delete 再 leaveTeamsAndAutoArchive）会让 CASCADE 已删 member rows，
    // leaveTeam 找不到 active row → 不 emit member-changed → UI 不刷新；同时 archive
    // 联动也跑空。await 顺序是 UX 正确性而非 FK 绕行。
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
    // plan reverse-rename-sid-stability-20260520 §A.3 / R5 MED-R5-1 黑名单双写升级:
    // 在 sessionRepo.delete 之前先反查 cliSessionId(DELETE 后 row 不在),
    // 让 SessionManager.delete 路径与 markRecentlyDeleted 同款双写 {appSid, cliSid}。
    // 反向 rename 后 SDK 尾包用 appSid 来 / hook 尾包用 cliSid 来,双写才挡得住所有来源。
    const recBeforeDelete = sessionRepo.get(sessionId);
    const cliSidBeforeDelete = recBeforeDelete?.cliSessionId;
    sessionRepo.delete(sessionId);
    // REVIEW_4 H1：把 id 加入「最近删除黑名单」60s，ingest 看到该 id 直接丢弃，
    // 防 SDK 流终止 / 异常 stream 的尾包在 sessionRepo.delete 后到达 ensureRecord。
    // R5 MED-R5-1 双写:applicationSid + cliSessionId 双 key 入黑名单
    const now = Date.now();
    this.recentlyDeleted.set(sessionId, now);
    if (cliSidBeforeDelete && cliSidBeforeDelete !== sessionId) {
      this.recentlyDeleted.set(cliSidBeforeDelete, now);
    }
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

    // plan codex-handoff-team-alignment-20260518 P2 Step 2.8 / 不变量 7：rename per-session
    // mcp token map(原 sid → 新 sid 的 token 一致迁移)。claude adapter 路径走 in-process MCP
    // transport closure override 不消费 token map,但 mcpSessionTokenMap.rename 内 oldSid 不在
    // map 时 noop 静默,不影响 claude 路径。
    mcpSessionTokenMap.rename(fromId, toId);

    eventBus.emit('session-renamed', { from: fromId, to: toId });
    const updated = sessionRepo.get(toId);
    if (updated) {
      eventBus.emit('session-upserted', updated);
      // plan P2 Step 2.8 / 不变量 7：按 agentId 派发 rename hook 到 adapter bridge
      // (codex 走 bridge.renameCodexInstance 同步 rename codexBySession Map key,确保
      // codex per-session 实例 / sessions Map / sdkOwned / token map 四处 key 同步迁移)。
      // claude bridge 不需要 hook(in-process MCP transport 不消费 token map),hook 注册时
      // 按 agentId 分流即可。
      //
      // **P5 Round 1 reviewer-codex M2 修法 (4-key 原子性加固)**：
      // hook 缺失或抛错时 sessions Map / sdkOwned / token map 已迁移完 + DB rename 已成,但
      // codexBySession Map key 仍指向 fromId — 后续 sendMessage(toId) 走 ensureCodex 命中
      // miss → 重建 Codex 实例;旧 Codex 实例 stale 在 codexBySession[fromId] 等下次 close
      // 清。属轻微 leak 不致命,但 codex agent session 必须经 hook 才能保 4 keys 一致。
      // codex agent + hook 缺失 = 严重 bug → console.error prominent 让 operator 看到
      // (而非 silently warn)。claude agent 不需 hook → silent 跳过保留语义。
      if (updated.agentId === 'codex-cli' && !sessionRenameHookFn) {
        console.error(
          `[sessionManager] CRITICAL: rename(${fromId} → ${toId}) for codex-cli agent but sessionRenameHookFn not registered. ` +
            `codexBySession Map will be stale (entry kept under fromId). main/index.ts bootstrap step 5.1.1 must call setSessionRenameHookFn before any codex spawn. ` +
            `Continuing with 3-key rename (DB / sdkOwned / token map) — codex Codex instance leak until session closeSession.`,
        );
      }
      if (updated.agentId && sessionRenameHookFn) {
        try {
          sessionRenameHookFn(updated.agentId, fromId, toId);
        } catch (err) {
          console.error(
            `[sessionManager] rename hook for ${updated.agentId} ${fromId} → ${toId} threw — ` +
              `4-key sync degraded to 3 keys (DB / sdkOwned / token map migrated, codexBySession stale). ` +
              `Stale codex instance leaked until next closeSession; downstream sendMessage(${toId}) will rebuild via ensureCodex.`,
            err,
          );
        }
      }
    }
  }

  /**
   * 反向 rename:仅 UPDATE sessions.cli_session_id 单列(不动 sessions.id 应用稳定身份)。
   * plan reverse-rename-sid-stability-20260520 §A.4 / §设计决策 D5 / §不变量 2 + 5。
   *
   * **关键 invariant** (与 renameSdkSession 跨表事务复杂迁移**完全不同**):
   * - sessions.id 不变(applicationSid 是应用稳定身份,不变量 1)
   * - 仅 cli_session_id 列变化(允许 6 处反向 rename 路径,不变量 2)
   * - **不**触发 session-renamed event(D6 line 92 反向 rename 不 emit,renderer listener 不触发)
   * - **不**调 mcpSessionTokenMap.rename(token map 用 sessions.id 做 key,sessions.id 不变 → token 永远稳定)
   * - **不**触发 sessions Map / SDK claim mutate(applicationSid 不变,bridge S3 isNewSpawn 分支保护已让 fork detect 路径只 update internal.cliSessionId)
   *
   * **黑名单链** (R5 HIGH-R5-1 + R6 MED-R6-1 修订):
   * - 读 oldCliSid = sessionRepo.get(applicationSid)?.cliSessionId ?? applicationSid (兜底防 null)
   * - 调 sessionRepo.updateCliSessionId(applicationSid, newCliSid) 单列 UPDATE
   * - 调 recentlyDeleted.set(oldCliSid, Date.now()) 加 OLD_CLI 黑名单 60s
   *   防迟到 hook event 携带 OLD_CLI 时撞 D7 3b miss 复活幽灵 record
   *
   * **caller 必须经本 helper 包装,不能直接调 sessionRepo.updateCliSessionId** (否则黑名单链断,
   * R7 MED-R7-2 test 6 已加断言 verify)。
   *
   * **spawn-path no-op 短路** (REVIEW_49 R3 follow-up LOW): spawn 主路径下 oldCliSid ===
   * applicationSid === newCliSessionId,L632 `oldCliSid !== newCliSessionId` 判断不写黑名单 →
   * 行为等价直调 sessionRepo.updateCliSessionId。统一走 wrapper 是契约层硬约束 SSOT;不要因
   * 「spawn 路径反正等价」而在 caller 处直调 sessionRepo,会让未来 fork 路径误传不同
   * cliSessionId 时静默跳过黑名单写入(blame radius 隐蔽 + 复活 ghost record 风险)。
   *
   * 调用方 (6 处反向 rename 路径,详 plan §D2 表):
   * - recoverer.ts:466 jsonl-missing fallback (claude)
   * - codex/recoverer.ts:339 jsonl-missing fallback (codex)
   * - stream-processor.ts:313 fork detect (claude)
   * - codex/thread-loop.ts:263 case 3 post-resume fork (codex,future-proof)
   * - restart-controller.ts:189 restartWithPermissionMode (claude)
   * - restart-controller.ts:341 restartWithClaudeCodeSandbox (claude)
   *
   * 调用方 (spawn 主路径,新增 R2 reviewer-claude MED 修法):
   * - claude-code/sdk-bridge/session-finalize.ts:98 spawn 主路径 cli_session_id 写入
   *   (spawn 时 oldCliSid === newCliSessionId === applicationSid,wrapper 内 L632 不写
   *   黑名单语义等价直调 sessionRepo;统一走 wrapper 让契约层硬约束 SSOT 不被绕过)
   */
  updateCliSessionId(applicationSid: string, newCliSessionId: string): void {
    const rec = sessionRepo.get(applicationSid);
    const oldCliSid = rec?.cliSessionId ?? applicationSid;
    sessionRepo.updateCliSessionId(applicationSid, newCliSessionId);
    // OLD_CLI 进黑名单 60s — 防迟到 hook event 携带 OLD_CLI 复活幽灵 record (D7 3b ingest drop)
    if (oldCliSid && oldCliSid !== newCliSessionId) {
      this.recentlyDeleted.set(oldCliSid, Date.now());
    }
    // 不 emit session-renamed (D6 反向 rename 不 emit)
    // 不调 mcpSessionTokenMap.rename (token map key = sessions.id 不变)
    // 不调 sessionRenameHookFn (codex bridge 不需 rename codexBySession Map key — applicationSid 不变)
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
