/**
 * SessionManager facade(Step 4.6 — plan deep-project-review-comprehensive-20260528)。
 *
 * **4 文件布局** (本 facade + 3 子模块):
 * - `manager.ts` (本) — facade class shell + sdk-claim 5 method + ensure + ingest + query 4 不拆 +
 *   lifecycle / rename / meta thin delegate → sub-module free function
 * - `manager/_deps.ts` — SessionCloseFn / SessionRenameHookFn type SSOT +
 *   SessionManagerInternalState interface + RECENTLY_DELETED_TTL_MS + isRecentlyDeletedImpl
 * - `manager/lifecycle.ts` — lifecycle 8 method + 黑名单 markRecentlyDeletedImpl + meta 2 method
 *   free function (~280 LOC)
 * - `manager/rename.ts` — renameSdkSessionImpl + updateCliSessionIdImpl free function (~140 LOC)
 *
 * **真私有 `#sdkOwned` 不拆约束**: ECMAScript private field 跨文件不可访问,sdk-claim 5 method
 * (claimAsSdk / releaseSdkClaim / hasSdkClaim / expectSdkSession / consumePendingSdkClaim) +
 * renameSdkSession `#sdkOwned` transfer 段都留在 class 内不出去。lifecycle / rename free function
 * 通过 SessionManagerInternalState interface 拿 recentlyDeleted Map ref (软私有 TS `private`)。
 *
 * **renameSdkSession callback 模式**: facade 通过 `transferSdkClaim` callback 让 free function
 * 在合适位置 (sessionRepo.rename 后 + 黑名单写前) 调 class method 内 `#sdkOwned` mutate,
 * 保 6 步顺序 byte-identical 与原 pre-split 实现一致。
 *
 * **byte-identical export**: sessionManager singleton / setSessionCloseFn / setSessionRenameHookFn /
 * UpsertOptions 全部从本 facade export,test / caller import path `@main/session/manager`
 * 零改动。
 */
import type {
  AgentEvent,
  SessionRecord,
  SessionSource,
} from '@shared/types';
import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import { isDbClosed } from '@main/store/db';
import { deriveTitle, normalizeCwd } from './manager-helpers';
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
  type SessionCloseFn,
  type SessionRenameHookFn,
  isRecentlyDeletedImpl,
  getCloseEpochImpl,
  bumpCloseEpochImpl,
} from './manager/_deps';
import {
  markRecentlyDeletedImpl,
  markDormantImpl,
  markClosedImpl,
  closeImpl,
  archiveImpl,
  unarchiveImpl,
  unarchiveOnUserSendImpl,
  reactivateImpl,
  recordCreatedPermissionModeImpl,
  notifyTeamMembershipChangedImpl,
  deleteImpl,
} from './manager/lifecycle';
import { renameSdkSessionImpl, updateCliSessionIdImpl } from './manager/rename';
import log from '@main/utils/logger';

const logger = log.scope('session-manager');

/**
 * SessionManager 不直接 import adapterRegistry(避免反向依赖 + 单职责),
 * 启动时 index.ts 通过 setSessionCloseFn 注入「按 sessionId 关 SDK 侧 live query」的 hook。
 * delete() 调用前者,让 SDK bridge 同步 abort + 清 internal session 与 pending Maps(CHANGELOG_20 / N2)。
 *
 * SessionCloseFn type 从 `./manager/_deps` SSOT re-export。
 */
let sessionCloseFn: SessionCloseFn | null = null;
export function setSessionCloseFn(fn: SessionCloseFn | null): void {
  sessionCloseFn = fn;
}

/**
 * plan codex-handoff-team-alignment-20260518 P2 Step 2.8 / 不变量 7:rename 同步必须在
 * `sessionManager.renameSdkSession` 函数体内统一调(与 sdkOwned 转移同款保证),不能让
 * caller(codex bridge thread-loop / sdk-bridge recoverer)各自调(漏调风险)。
 *
 * SessionManager 不直接 import 各 adapter bridge(避免反向依赖 + 单职责),main bootstrap
 * 通过 setSessionRenameHookFn 注入「按 agentId 派发 rename hook」回调,让 SessionManager
 * 在 renameSdkSession 函数体末尾同步调到 bridge.renameCodexInstance / 其他 adapter 的同款
 * method(claude adapter 走 in-process MCP transport,closure override,不需 token map rename,
 * hook 可以 noop)。
 *
 * 同步执行(不走事件订阅):renameSdkSession 调用方依赖 rename 完成后立即看到一致的
 * sdkOwned + token map + per-session bridge instance map 三处 key 同步迁移。
 *
 * SessionRenameHookFn type 从 `./manager/_deps` SSOT re-export。
 */
let sessionRenameHookFn: SessionRenameHookFn | null = null;
export function setSessionRenameHookFn(fn: SessionRenameHookFn | null): void {
  sessionRenameHookFn = fn;
}

/**
 * 创建 / 更新 SessionRecord 的入参契约。export 是为 manager-ingest-pipeline.ts
 * 的 IngestContext.ensure 签名共享类型(CHANGELOG_86 Step 4.3.3 facade 契约)。
 */
export interface UpsertOptions {
  agentId: string;
  cwd?: string;
  title?: string;
  source?: SessionSource;
}

/**
 * SessionManager 是 AgentEvent 的中央汇集点。所有 adapter 都通过 ingest()
 * 把事件灌入这里,由它统一更新数据库 + 推动状态机 + 广播给渲染端。
 *
 * activity 状态机由本类直接维护;lifecycle 由 LifecycleScheduler 负责(M5)。
 *
 * 去重:Claude Code 的会话可能同时被 SDK 通道(query AsyncGenerator)和
 * Hook 通道(settings.json 注入的 hook)观测到。SDK 通道粒度更细,因此
 * 一旦 ClaudeSdkBridge 调用 claimAsSdk(sessionId),后续来自 hook 的
 * 同 id 事件会被丢弃。
 */
class SessionManagerClass {
  /**
   * 由 SDK 通道接管的会话 id,hook 同 id 事件会被丢弃。
   *
   * ECMAScript `#private` 真私有(runtime 强制不可访问):cast `(this as any).#sdkOwned`
   * 与 `(sessionManager as any).sdkOwned` 都拿不到 raw Set,外部探查 / 测试反射统一走
   * 公开 `hasSdkClaim(sid)` API。任何 mutate 走 `claimAsSdk` / `releaseSdkClaim` / `renameSdkSession`
   * 三个公开入口(claim 单一入口不变量)。
   *
   * **Step 4.6 真私有跨文件不可访问约束**: 拆分后仍留 class 内不出去 — sub-module free function
   * 通过 `transferSdkClaim` callback (renameSdkSession 用) 间接 mutate;sdk-claim 5 method
   * 全留 class 内直接 mutate。
   */
  #sdkOwned = new Set<string>();

  /**
   * SDK 启动 CLI 子进程后到拿到真实 session_id 之前,hook 通道可能先一步上报。
   * 这段时间用 cwd 做"待领取"标记:hook 首次出现该 cwd 的新 session 时,
   * 把它主动 claim 为 SDK,并丢弃那条 hook 事件,避免出现「内/外」两份重复会话。
   */
  private pendingSdkCwds = new Map<string, number>(); // cwd → 失效时间戳

  /**
   * 最近被 delete 的 cli_session_id 黑名单(REVIEW_4 H1 兜底 + R5 HIGH-R5-1 / R6 MED-R6-1
   * + R5 MED-R5-1 黑名单分场景双写升级)。
   * SDK 已用 `intentionallyClosed` 屏蔽 close 后 catch 路径的 emit;这里再加一道:
   * 删除窗口内(60s)任何来源的尾包都直接丢弃,避免 ensureRecord 把 sessionRepo.get 已 null
   * 的 sessionId 当成首次见到 → 新建 record 复活成幽灵。60s 远大于任何 SDK 收尾延时,但又
   * 不长到无意义占内存。
   *
   * **plan reverse-rename-sid-stability-20260520 §A.3 / §D7 黑名单分场景升级**:
   * Map<string, number> 结构本身不动,key 语义按场景分:
   * - **updateCliSessionId 活跃路径** (反向 rename 6 处场景): 仅黑 OLD_CLI_ID
   *   (applicationSid 仍 active 不可拒,详 sessionManager.updateCliSessionId helper)
   * - **delete / close / markRecentlyDeleted 路径** (会话结束兜底场景): 双写
   *   `{applicationSid, cliSessionId}` 黑名单 (反向 rename 后 SDK 尾包用 appSid 来 /
   *   hook 尾包用 cliSid 来,黑名单必须双 key 覆盖才能挡住所有来源)
   *
   * **ingest 4 态分流** (本 facade ingest() 入口,详 plan §A.3):
   * - 3a: findByCliSessionId(eventSid) 命中 → 覆写 event.sessionId 走原 dedupOrClaim 5 段流程
   * - 3b: 不命中 + isRecentlyDeleted(eventSid) 命中 → drop 迟到 event
   * - 3c: 不命中 + 不在黑名单 + cwd 命中 pendingSdkCwds → 走原 dedupOrClaim 时序兜底 claim+skip (REVIEW_5 H1 / REVIEW_12 修法保留)
   * - 3d: 全没命中 → 走原 ensureRecord 建外部 CLI 会话 (现状 fallback 不变)
   */
  private recentlyDeleted = new Map<string, number>(); // cli_session_id (or applicationSid) → deletedAt

  /**
   * close-epoch 计数器 Map<sessionId, count>(REVIEW_99 R3 carry-forward cancellation-epoch)。
   * closeImpl / markClosedImpl / deleteImpl 在 close intent 起点自增;recover 入口 emit user
   * message 后捕 baseline,多检查点比对 getCloseEpoch !== baseline 判「恢复期间用户再次 close」。
   * 详 manager/_deps.ts SessionManagerInternalState.closeEpoch jsdoc。
   */
  private closeEpoch = new Map<string, number>();

  /**
   * Pipeline 看到的 facade(Object.freeze 的 5 方法对象)。
   * 闭包封装 raw state,pipeline 函数 cast `(ctx as any).sdkOwned` 返回 undefined
   * (cast 路径不可达),保护 claim 单一 mutating 入口不变量。CHANGELOG_86 Step 4.3.3。
   */
  private readonly ingestCtx: IngestContext;

  /**
   * sub-module free function 共享的 internal state ref(Step 4.6 拆分新增)。
   * 仅暴露 recentlyDeleted Map ref 给 lifecycle / rename 域 free function 写黑名单使用;
   * `#sdkOwned` 真私有 + pendingSdkCwds 不在此 interface(分别由 class method 直接 mutate /
   * sdk-claim 5 method 留 class 内消费)。
   */
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
    const key = normalizeCwd(cwd);
    const expiresAt = Date.now() + ttlMs;
    this.pendingSdkCwds.set(key, expiresAt);
    logger.info(`[session-mgr] expect sdk session @ ${key} (ttl ${ttlMs}ms)`);
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
    // 注:`/private/var ↔ /var` 这类 macOS 别名差异已经被 normalizeCwd 内的
    // realpathSync 解决(两端都返回 canonical 路径)。早期版本曾用「池子 size===1
    // 就 fuzzy 兜底」,但这条会把同时段在别的 cwd 跑的外部 CLI hook 误 claim
    // 进 sdkOwned,后续事件被静默吞掉,会话凭空消失。任何新别名场景都应在
    // normalizeCwd 内具体加规则,不要再回到全局 fuzzy。
  }

  /** 注册新会话或更新已有会话 */
  ensure(sessionId: string, opts: UpsertOptions): SessionRecord {
    const existing = sessionRepo.get(sessionId);
    if (existing) {
      // 收到新事件 → 复活:closed 推回 active。
      // 注意:归档(archivedAt)与 lifecycle 正交,是用户的主动隐藏意图,
      // 不能因为后续事件流就自动 unarchive,否则用户刚归档的 active 会话
      // 下一秒收到 hook 事件就被默默放回实时面板,违背 CLAUDE.md「正交」约定。
      // 取消归档必须由 unarchive() 显式调用。
      //
      // **REVIEW_83 HIGH (reviewer-claude + reviewer-codex 双方独立 + lead un-skip
      // manager-ingest.test.ts:267 实测复现 `expected 'active' to be 'closed'`)**:
      // closed→active 复活必须收口为 **仅 SDK 通道事件** (opts.source==='sdk' = 用户
      // resume 主路径,recover-and-send-impl.ts:154 emit sdk user message 触发)。原版无
      // source 守卫 → 非 sdk 的迟到事件 (shutdown_session 后 CLI 子进程 buffer 异步飞回的
      // 迟到 hook / 外部 cli 尾包) 也复活 closed → 把已关闭的 reviewer 假活回实时面板。
      // 而 manager-ingest-pipeline.ts:228 advanceState 的 REVIEW_49 R3 HIGH-2 closed 短路
      // 永远拦不到 —— 因为本 ensure() 在 advanceState 之前已先复活成 active(短路判 closed 恒
      // false)。修法:本 ensure() 加 source 守卫,让「非 sdk 迟到事件不复活 closed」收口在
      // 此处,advanceState 短路对非 sdk closed 事件才真正生效。
      // 同时要求 archivedAt === null:归档与 lifecycle 正交,事件流不应自动复活归档会话的
      // lifecycle(auto-unarchive 是 unarchiveOnUserSend 的显式职责,不是被动事件流;
      // 原版漏此守卫致 closed+archived 会话被事件流偷改 lifecycle='active' — claude HIGH 同源子问题)。
      if (
        existing.lifecycle === 'closed' &&
        existing.archivedAt === null &&
        opts.source === 'sdk'
      ) {
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
   * 入口:adapter 发来的所有 AgentEvent 都走这里。
   *
   * 拆 5 段(CHANGELOG_20 / B):dedupOrClaim → ensureRecord → persistEventRow →
   * persistFileChange → advanceState。每段单一职责、可单测。5 段实现 + IngestContext
   * facade 见 manager-ingest-pipeline.ts(CHANGELOG_86 Step 4.3.3)。
   *
   * **硬约束**:dedupOrClaim 必须留在最前 + 早返;否则 hook 首发竞争场景会先落一份假 CLI 会话
   * 再 claim,UI 会闪现「内/外两份」。CHANGELOG_16 / REVIEW_1 修过、payload-truncate 测试覆盖。
   */
  ingest(event: AgentEvent): void {
    // **shutdown race guard (issue shutdown-race-ingest-db-guard)**:before-quit finally 跑 closeDb() 后
    // (REVIEW_104 MED-B WAL checkpoint 不变量提前到 finally),adapter in-flight 尾包(shutdownAll drain
    // 完成前已 emit / 迟到 SDK 流尾包)仍会走到本入口 → 下方 findByCliSessionId → getDb() 在
    // dbInstance=null 上 throw → adapter async 流上变 unhandledRejection 落盘噪音(logger.ts 仅落盘
    // 不强退,非 crash 非数据丢失)。DB 已显式关闭时退出期事件本就无需持久化,直接 drop。
    // isDbClosed() 仅在「正常跑过 → closeDb」时为 true;启动期 init-never (dbInstance=null 但未 closeDb)
    // 返 false → 不在此短路,getDb() 照常 loud throw,不掩盖「漏 initDb」启动 bug(详 db.ts dbClosed jsdoc)。
    if (isDbClosed()) return;
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
    // token-usage 早返旁路（plan model-token-stats §Phase 1 A5 / §不变量 2/10）：
    // 不写 events 表 / 不进 activity 状态机 / 不 emit agent-event（避免污染活动流 + 卡片状态机）。
    // 放在 dedupOrClaim 后（黑名单 / sdkOwned 去重仍生效，§不变量 10：被删 session 60s 内尾包
    // token-usage 在 isRecentlyDeleted 处已 drop，是预期）、ensureRecord 前（不为 token-usage 建/
    // 复活 session row）。persistTokenUsage 自包裹 try/catch，失败不阻塞（§不变量 3）。
    // emit token-usage-changed 通知 renderer（daily 视图 debounce refetch；rates/topToday 走 poll）。
    if (event.kind === 'token-usage') {
      persistTokenUsage(event);
      eventBus.emit('token-usage-changed', { sessionId: event.sessionId, ts: event.ts });
      return;
    }
    const record = ensureRecord(this.ingestCtx, event);
    persistEventRow(event);
    persistFileChange(event);
    advanceState(record, event);
    // 4. 广播原始事件给渲染端
    eventBus.emit('agent-event', event);
  }

  /** 黑名单 TTL 检查 thin delegate → manager/_deps.isRecentlyDeletedImpl。 */
  private isRecentlyDeleted(sessionId: string): boolean {
    return isRecentlyDeletedImpl(this.internalState, sessionId);
  }

  /** thin delegate → manager/lifecycle.markRecentlyDeletedImpl (双写黑名单 R5 MED-R5-1)。 */
  markRecentlyDeleted(sessionId: string): void {
    markRecentlyDeletedImpl(this.internalState, sessionId);
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
    await closeImpl(sessionId, sessionCloseFn, this.internalState);
  }

  /**
   * 读 close-epoch 当前值(REVIEW_99 R3 cancellation-epoch,未 close 过返 0)。
   *
   * recover 入口(recover-and-send-impl 两端)在 emit user message **之后**捕获 baseline,
   * 多检查点(jsonl-fallback await 后 / createSession pre-registration await 后)比对
   * `getCloseEpoch(sid) !== baseline` 判「恢复期间用户再次 close / scheduler 衰减 / delete」。
   * 详 manager/_deps.ts getCloseEpochImpl jsdoc。
   */
  getCloseEpoch(sessionId: string): number {
    return getCloseEpochImpl(this.internalState, sessionId);
  }

  /**
   * 自增 close-epoch(REVIEW_99 R3 cancellation-epoch)— **scheduler 衰减 dormant→closed 专用入口**。
   *
   * closeImpl / markClosedImpl / deleteImpl 内部已自增(close intent 起点),但 LifecycleScheduler
   * 出于性能走 `batchSetLifecycle` + inline `applyClosedSideEffects`「第四入口」**绕过** markClosedImpl
   * (REVIEW_56 §F20 只统一了 side-effects,不走 markClosedImpl)→ 不会触发内部自增。本 public 方法让
   * scheduler 在 batched close loop 显式补一次 epoch++,与其他三入口对齐 close intent 信号,recover
   * await 期间 scheduler 衰减同样能 abort。结构上 active(刚被 entry emit revive)10-30s 内难达 closed,
   * 此入口是防御性补全(消除理论缝)而非热路径。
   */
  bumpCloseEpoch(sessionId: string): void {
    bumpCloseEpochImpl(this.internalState, sessionId);
  }

  /**
   * 删 close-epoch entry(REVIEW_99 R3 cancellation-epoch)— **scheduler 历史 purge 专用清理入口**。
   *
   * deleteImpl 内部已在删 row 后清 entry,但 LifecycleScheduler 历史超期 purge 走
   * `sessionRepo.batchDelete`「第四入口」**绕过** deleteImpl → 不清 closeEpoch entry。本 public 方法让
   * scheduler 在 batchDelete loop 显式清,防 closeEpoch Map 随 purge 的会话无界累积(与 recentlyDeleted
   * TTL 清理同款防泄漏纪律)。清后 getCloseEpoch 返 0,但 purged sid 永不会再被任何 recovery 引用
   * (sid 是 randomUUID 不复用),无correctness 影响纯内存回收。
   */
  forgetCloseEpoch(sessionId: string): void {
    this.closeEpoch.delete(sessionId);
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
    await deleteImpl(this.internalState, sessionId, sessionCloseFn);
  }

  /**
   * SDK 通道 sid 切换(tempKey → realId / fork OLD→NEW / bypass 冷切)。
   *
   * **真私有 `#sdkOwned` callback 模式** (Step 4.6 拆分):class method 自己处理 `#sdkOwned` mutate,
   * free function 通过 `transferSdkClaim` callback 在合适位置(sessionRepo.rename 后 + 黑名单写前)
   * 调用,保 6 步顺序 byte-identical 与原 pre-split 一致。
   *
   * 详 jsdoc 见 manager/rename.ts renameSdkSessionImpl。
   */
  renameSdkSession(fromId: string, toId: string): void {
    if (fromId === toId) return;
    renameSdkSessionImpl(this.internalState, fromId, toId, sessionRenameHookFn, {
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
    return enrichRecordsWithTeamsBatch(sessionRepo.listActiveAndDormant());
  }

  get(id: string): SessionRecord | null {
    const rec = sessionRepo.get(id);
    return rec ? enrichRecordWithTeams(rec) : null;
  }

  /**
   * 公共 API thin wrapper:把 universal team backend 的 active membership 拼装到
   * SessionRecord.teams 字段。实际逻辑搬到 manager-enrich.ts free function;class 方法
   * 保留是为外部 caller(src/main/index.ts:236 桥点 / ipc/sessions.ts / mcp/handlers/list.ts)
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
