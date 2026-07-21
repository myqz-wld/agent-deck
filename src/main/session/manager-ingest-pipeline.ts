import type { AgentEvent, LifecycleState, SessionRecord, TokenUsagePayload } from '@shared/types';
import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import { eventRepo } from '@main/store/event-repo';
import { fileChangeRepo } from '@main/store/file-change-repo';
import { tokenUsageRepo } from '@main/store/token-usage-repo';
import { extractCwd, nextActivityState } from './manager-helpers';
import { buildFileChangeSnapshots } from './file-change-snapshots';
import type { UpsertOptions } from './manager/_deps';
import log from '@main/utils/logger';

const logger = log.scope('session-ingest');

/**
 * Ingest 5 段流水线 free function（拆自 manager.ts，CHANGELOG_86 Step 4.3.3）。
 *
 * SessionManagerClass.ingest() 入口仍在 manager.ts（保留 CHANGELOG_20 / B 架构 motivation
 * 与「dedupOrClaim 必须最前 + 早返」硬约束注释；本文件只放 5 段实现 + IngestContext 契约）。
 *
 * **5 段顺序硬约束**（与 manager.ts ingest() 入口注释对齐）：
   *   isRecentlyDeleted 条件早返（SDK user message 可清黑名单续聊）→ dedupOrClaim 早返 →
   *   ensureRecord → persistEventRow → persistFileChange → advanceState → emit('agent-event')
 *
 * dedupOrClaim 必须**第一**：hook 首发竞争场景（CHANGELOG_16 / REVIEW_1）若先落假 CLI
 * 会话再 claim，UI 闪现「内/外两份」。任何 DB / event 写入不得前置。
 *
 * IngestContext = SessionManagerClass 给 pipeline 看的 5 方法 facade（Object.freeze）。
 *
 * **为何选 facade 而不 implements**（SKILL R1 finding 整合裁决，HIGH-B1 取代原 implements 设计）：
 * - implements 让 pipeline 拿到 SessionManagerClass 实例，cast `(ctx as any).sdkOwned`
 *   直接访问 raw Set 绕过 claim 单一入口；facade 闭包封装 raw state，cast 路径不可达
 *   （`(ctx as any).sdkOwned === undefined`）。
 * - facade 让 SessionManagerClass 的 5 个 helper method（hasSdkClaim / claimAsSdk /
 *   consumePendingSdkClaim / ensure / isRecentlyDeleted）保持 `private`，class 只对外暴露
 *   public lifecycle API；闭包提供 pipeline 访问，不需要为接口公开化。
 * - pipeline 函数签名锁死 IngestContext，不接受 SessionManagerClass 实例（防误传）。
 *
 * sessionManager 现已用 ECMAScript `#sdkOwned` 真私有（H5 follow-up Phase 3 完成）+ 公开
 * `hasSdkClaim(sid)` API；`(sessionManager as any).sdkOwned === undefined`，cast 路径彻底封死。
 * 测试反射 `as { sdkOwned }` 不再可用，统一走 sessionManager.hasSdkClaim() 断言。
 */

/**
 * Ingest 流水线对 SessionManagerClass 的最小契约（5 个行为方法）。
 *
 * SessionManagerClass.constructor 内构造 Object.freeze<IngestContext>({...}) 的薄 facade，
 * 闭包转调对应 private state / private method；pipeline 函数只见 5 个方法签名，无 raw state
 * 暴露。任何新加的 ingest 阶段所需 helper 都应先加到本接口（设计协议入口），不得直接
 * cast SessionManagerClass 拿 raw 字段。
 */
export interface IngestContext {
  /** 查 sid 是否被 SDK 通道接管（替代 sdkOwned.has）。 */
  hasSdkClaim(sid: string): boolean;
  /** 唯一 mutate sdkOwned 入口（add 操作）；release 走 sessionManager.releaseSdkClaim 公开 API。 */
  claimAsSdk(sid: string): void;
  /** cwd 命中 pendingSdkCwds → 消费 + 返回 true；否则 false。realpath 已在 manager-helpers.normalizeCwd 内做。 */
  consumePendingSdkClaim(cwd: string): boolean;
  /** 取/建 SessionRecord；closed → revive 复活逻辑由 ensure 自己处理。 */
  ensure(sessionId: string, opts: UpsertOptions): SessionRecord;
  /**
   * 60s 黑名单 TTL 检查 + 自清。
   *
   * **plan reverse-rename-sid-stability-20260520 §A.3 黑名单语义**:
   * 入参 `sid` 维度按 caller 路径不同:
   * - **ingest 入口 (manager.ts:219 4 态分流)**: caller 传 event.sessionId (反向 rename 后已经过
   *   findByCliSessionId 反查覆写,可能是 applicationSid 或原始 cliSessionId — 黑名单双写后
   *   两 key 都能命中)
   * - **delete / close / markRecentlyDeleted 路径 (双写黑名单)**: 入参传 sid 写入,manager 内部
   *   再 sessionRepo.get 反查 cliSessionId 双写(R5 MED-R5-1 升级,详 manager.ts:103 jsdoc)
   * - **updateCliSessionId 活跃路径**: 仅写 OLD_CLI_ID(applicationSid 仍 active 不可拒)
   *
   * Map<string, number> 结构本身不动,key 语义按场景区分(详 manager.ts:103 jsdoc 双写规则)。
   */
  isRecentlyDeleted(sid: string): boolean;
}

/**
 * 第 1 段：去重 / 时序兜底 claim。skip=true 表示这条事件应被丢弃。
 *
 * 5 个分支顺序硬约束（与 manager.ts pre-split 实现完全等价；任何顺序调整都需重新走
 * REVIEW_5 H1 + REVIEW_12 Bug 5 + manager-ingest.test.ts 7 个 it 全套验证）：
 * 1. team-* hook 早返不 dedup（M3 数据流要求）
 * 2. sdkOwned + hook → skip
 * 3. 时序兜底 A（新 sid + cwd 命中 pendingSdkCwds → claim+skip）
 * 4. 时序兜底 B（已存在 sid + cwd 命中 → claim+skip，REVIEW_5 H1）
 * 5. 时序兜底 C（hookOrigin='sdk' 孤儿 → skip，REVIEW_12 Bug 5）
 */
export function dedupOrClaim(ctx: IngestContext, event: AgentEvent): { skip: boolean } {
  // M3 Agent Teams 事件家族（team-task-created / team-task-completed / team-teammate-idle）
  // 双源:
  // - hook 通道:CLI builtin TaskCreated/TaskCompleted/TeammateIdle hook 上报(CHANGELOG_40 设计)。
  //   实际接入路径在当前代码里未真实使用(grep 0 处 source='hook' 的 team-task-* ingest 来源),
  //   保留兜底以备未来恢复。
  // - sdk 通道:agent-deck-mcp `task_create` / `task_update`(status→completed) handler 主动 ingest
  //   (CHANGELOG_56 §A 落地)。
  // 两源都不走任何 dedup —— sdkOwned 的 lead session 是 SDK 接管的,若按 hook+sdkOwned 守卫吞掉
  // hook 源会让 M3 hook 路径整片失效;sdk 源本来就由 handler 主动 ingest,更不应被任何分支误吞。
  // 早返让 team-* event 直接进 ensureRecord / persistEventRow。
  // CHANGELOG_165 修法:去掉 `event.source === 'hook'` 限定(原 CHANGELOG_40 注释「SDK 通道不
  // emit 这些 kind」已与现实漂移 — CHANGELOG_56 §A 让 sdk 源也 ingest),让两源都走早返。
  if (
    event.kind === 'team-task-created' ||
    event.kind === 'team-task-completed' ||
    event.kind === 'team-teammate-idle'
  ) {
    return { skip: false };
  }
  // SDK 已接管的会话，丢弃 hook 通道事件（避免重复入库）
  if (event.source === 'hook' && ctx.hasSdkClaim(event.sessionId)) {
    return { skip: true };
  }
  // 时序竞争兜底 A（新 sessionId）：SDK 已注册要拉起这个 cwd 的会话，但真实 session_id
  // 还没到，hook 通道（CLI 子进程内部 hook）先一步上报。这时如果是该 cwd 上首次见到的
  // 新 sessionId，认作 SDK 派生：claim 它的 id，丢弃这条 hook 事件，等 SDK 通道事件来。
  if (event.source === 'hook' && !sessionRepo.get(event.sessionId)) {
    const cwd = extractCwd(event);
    if (cwd && ctx.consumePendingSdkClaim(cwd)) {
      logger.info(
        `[session-mgr] hook→sdk re-claim (new sid): sessionId=${event.sessionId} cwd=${cwd}`,
      );
      ctx.claimAsSdk(event.sessionId);
      return { skip: true };
    }
  }
  // REVIEW_5 H1：时序兜底 B（已存在 sessionId，resume 路径专用）：
  // SDK resume 启动 CLI 子进程后，CLI 内部 SessionStart hook 携带的 session_id 就是
  // 历史 OLD_ID（DB 里 closed/archived/dormant 一定 existing），上面 A 的 `!sessionRepo.get`
  // 守卫天然失效；hook 直接通过 → ensure 把 OLD_ID 复活成 active 但 source='cli'，与 SDK
  // 通道（30s fallback 或后续 first SDKMessage）造的同 cwd active 形成「两条 active」bug。
  //
  // 修法：cwd 命中 pendingSdkCwds 时即便 record 已存在也走 claim + skip，让 SDK 通道独享。
  // sdk-bridge.ts H4 修法已在 createSession 入口预先 claim opts.resume，本分支是双保险，
  // 应对 expectSdkSession 已注册但 sdk-bridge 还没来得及 claim 的极短窗口（理论上 < 1ms，
  // 但 microtask 调度无序，留这道防线兜底）。
  if (event.source === 'hook') {
    const cwd = extractCwd(event);
    if (cwd && ctx.consumePendingSdkClaim(cwd)) {
      logger.info(
        `[session-mgr] hook→sdk re-claim (existing sid): sessionId=${event.sessionId} cwd=${cwd}`,
      );
      ctx.claimAsSdk(event.sessionId);
      return { skip: true };
    }
  }
  // REVIEW_12 Bug 5：时序兜底 C（origin tag 兜底，覆盖 A/B 的盲区）：
  // hook event 带 hookOrigin='sdk' 表示该 CLI 子进程是本应用 SDK 派生（env 注入）。
  // 走到这里说明 sdkOwned / pendingSdkCwds / record 三层都没认出来 —— 典型场景：
  // - approve-bypass 冷切：OLD CLI 被 SIGTERM 后内部 fork 出新 sessionId Y + cwd 兜底
  //   到 home dir，飞回的迟到 SessionEnd hook 不命中黑名单（sessionId 是 Y 不是 OLD）也
  //   不命中 cwd claim（cwd 是 home dir 不是真实 cwd）。
  // - SDK 子进程提前飞 hook 但应用层 expectSdkSession 还没注册（理论无，留兜底）。
  // 既然 hookOrigin='sdk' 已经从源头标记此进程归属于 SDK，且未被任何 SDK 通道认领，
  // 这条 event 一定是 SDK-derived 进程的孤儿副产品，直接 skip 不创建 source='cli' record。
  // 用户独立终端跑 `claude` 没有 AGENT_DECK_ORIGIN env → header 走默认 'cli' → 不走本分支。
  if (event.source === 'hook' && event.hookOrigin === 'sdk') {
    logger.debug(
      `[session-mgr] drop sdk-derived orphan hook: sessionId=${event.sessionId} kind=${event.kind}`,
    );
    return { skip: true };
  }
  return { skip: false };
}

function shouldReviveClosedSession(event: AgentEvent): boolean {
  if (event.source !== 'sdk' || event.kind !== 'message') return false;
  const payload = event.payload as { role?: unknown } | null | undefined;
  return payload?.role === 'user';
}

/** 第 2 段：取/建 SessionRecord。closed→active 复活由 ensure 内部处理(仅 SDK user message
 * 用户 resume 才复活;SDK/hook 迟到尾包不复活 closed)。 */
export function ensureRecord(ctx: IngestContext, event: AgentEvent): SessionRecord {
  const registration =
    event.source === 'sdk' && event.kind === 'session-start'
      ? (event.payload as {
          initialSpawnLink?: { parentSessionId?: unknown; depth?: unknown };
          initialHiddenFromHistory?: unknown;
        } | null | undefined)?.initialSpawnLink
      : undefined;
  const hiddenFromHistory =
    event.source === 'sdk' &&
    event.kind === 'session-start' &&
    (event.payload as { initialHiddenFromHistory?: unknown } | null | undefined)
      ?.initialHiddenFromHistory === true;
  const validRegistration =
    registration &&
    typeof registration.parentSessionId === 'string' &&
    registration.parentSessionId.length > 0 &&
    Number.isInteger(registration.depth) &&
    Number(registration.depth) > 0
      ? { parentSessionId: registration.parentSessionId, depth: Number(registration.depth) }
      : null;
  return ctx.ensure(event.sessionId, {
    agentId: event.agentId,
    cwd: extractCwd(event),
    // SDK 通道发来的事件 → 应用内会话；hook 通道（含未标 source 的） → 外部 CLI 会话
    source: event.source === 'sdk' ? 'sdk' : 'cli',
    reviveClosed: shouldReviveClosedSession(event),
    spawnedBy: validRegistration?.parentSessionId,
    spawnDepth: validRegistration?.depth,
    hiddenFromHistory,
  });
}

/** 第 3 段：events 表落库。payload 截断由 event-repo 内部 safeStringifyPayload 处理（CHANGELOG_20 / N1）。 */
export function persistEventRow(event: AgentEvent): void {
  eventRepo.insert(event);
}

/** 第 4 段：file-changed 事件附带的文件 diff 落 file_changes 表（其它 kind 直接 return）。 */
export function persistFileChange(event: AgentEvent): void {
  if (event.kind !== 'file-changed') return;
  const p = event.payload as {
    filePath?: string;
    kind?: string;
    before?: unknown;
    after?: unknown;
    toolCallId?: string;
    metadata?: Record<string, unknown>;
    cwd?: string;
  };
  if (!p || typeof p.filePath !== 'string') return;
  // text 通道 before/after 是 string，原样存；image 通道是 ImageSource 对象，需 JSON.stringify。
  // file_changes.before_blob / after_blob 列是 TEXT，序列化后存得下（典型 < 200 chars）。
  const serialize = (v: unknown): string | null => {
    if (v == null) return null;
    if (typeof v === 'string') return v;
    return JSON.stringify(v);
  };
  const kind = typeof p.kind === 'string' ? p.kind : 'text';
  const metadata =
    p.metadata && typeof p.metadata === 'object' && !Array.isArray(p.metadata)
      ? p.metadata
      : {};
  const cwd = typeof p.cwd === 'string' ? p.cwd : sessionRepo.get(event.sessionId)?.cwd ?? null;
  const snapshots = buildFileChangeSnapshots({
    cwd,
    filePath: p.filePath,
    kind,
    before: p.before,
    after: p.after,
    metadata,
  });
  fileChangeRepo.insert({
    sessionId: event.sessionId,
    filePath: p.filePath,
    kind,
    beforeBlob: serialize(p.before),
    afterBlob: serialize(p.after),
    beforeSnapshot: snapshots.beforeSnapshot,
    afterSnapshot: snapshots.afterSnapshot,
    metadata,
    toolCallId: p.toolCallId ?? null,
    ts: event.ts,
  });
}

/**
 * 第 6 段（plan model-token-stats-and-dashboard-20260602 §Phase 1 A5）：token-usage 事件落
 * token_usage 表。
 *
 * **由 ingest 早返分支调用**（manager.ts ingest：dedupOrClaim 后、ensureRecord 前）——token-usage
 * 不走主事件流（不写 events 表 / 不进 activity 状态机 / 不 emit agent-event，§不变量 2），故不在
 * 5 段顺序内，是独立早返旁路。
 *
 * **整体 try/catch**（§不变量 3）：DB 异常（极端：表损坏 / 磁盘满）只 warn，绝不阻塞主事件流
 * （token 统计是旁路，失败不该影响会话功能）。与 persistFileChange 不同——它在 5 段内 throw 会
 * 中断 ingest，本函数在早返分支自包裹。
 *
 * bucket 归一在 tokenUsageRepo.insert 内部经 normalizeModel 算（SSOT，§不变量 4）。
 */
export function persistTokenUsage(event: AgentEvent): void {
  try {
    const p = event.payload as TokenUsagePayload | null | undefined;
    if (!p) return;
    tokenUsageRepo.insert({
      sessionId: event.sessionId,
      agentId: event.agentId,
      messageId: p.messageId ?? null,
      model: p.model ?? null,
      inputTokens: p.inputTokens ?? 0,
      outputTokens: p.outputTokens ?? 0,
      reasoningTokens: p.reasoningTokens ?? 0,
      cacheReadTokens: p.cacheReadTokens ?? 0,
      cacheCreationTokens: p.cacheCreationTokens ?? 0,
      ts: event.ts,
    });
  } catch (err) {
    logger.warn(`[session-ingest] persistTokenUsage failed (sid=${event.sessionId})`, err);
  }
}

/**
 * 第 5 段：activity 状态机推进 + lifecycle 复活 + emit。
 *
 * 「会话状态真的变了」走重 upsert + 广播 session-upserted（renderer store 同步整个 record）。
 * 「只是 lastEventAt 推进」走轻量 setActivity 单列 UPDATE，不再广播 —— renderer 通过
 * agent-event 事件已经知道有新动作；session-upserted 高频会话场景下会被联动放大成
 * IPC 风暴（每条事件一次 latestSummaries 重读 SQL，10 个活跃会话 = 50 IPC/s 全是浪费）。
 *
 * 不在判定里写 archivedAt：归档与 lifecycle 正交，归档的会话来事件不应自动 unarchive。
 *
 * **REVIEW_49 R3 followup HIGH-2 + REVIEW_83 HIGH/MED 修法**:**closed / archived 会话短路丢迟到 event**。
 * 触发链:closeSession 调 markClosed (manager.ts:349) 不写 recentlyDeleted 黑名单 +
 * shutdown_session 后 60s 黑名单 TTL 过 / hook 子进程内部 buffer 异步飞回 → ingest 走
 * dispatch (manager.ts:309 3a findByCliSessionId 命中已 closed row 覆写后) → advanceState
 * 旧版任何非 active lifecycle 都复活回 active → emit session-upserted → UI 看到
 * 「我刚 shutdown 的 reviewer 又活了」假活。short-circuit return —
 * persistEventRow + persistFileChange 仍会写 events/file_changes 子表(数据保留供审计),
 * 仅不更新 sessions.lastEventAt + 不复活 lifecycle + 不 emit session-upserted。
 * dormant 仍可正常复活成 active(user resume 走真路径)— 不在 short-circuit 范围。
 *
 * **REVIEW_83 收口要点**(deep-review-project-20260531 Batch E):
 * - closed→active 复活已收口到 ensure()(manager.ts:251,仅 SDK user message 用户 resume 才复活)。
 *   原版本短路被架空:ensure() 在 advanceState 之前对任何来源都复活 closed→active → 短路判
 *   closed 恒 false(REVIEW_83 HIGH,双方独立 + un-skip manager-ingest.test.ts:267 实测)。
 * - archived 会话短路新增 **session-end 终止例外**:archiveImpl 只写 archivedAt 不动 lifecycle,
 *   原版本对 archived 一律 return → archived active 会话收 session-end 后 lifecycle 永停 active
 *   (scheduler 又过滤 archived 不衰减)→ unarchive 后幽灵 active。修法:archived 仍落 session-end
 *   终态转换(active→dormant/closed + endedAt)但不 emit(REVIEW_83 MED,codex 单方 + lead 验证)。
 */
export function advanceState(record: SessionRecord, event: AgentEvent): void {
  // **REVIEW_49 R3 follow-up HIGH-2**: closed 短路 — 见函数 jsdoc 修法说明。
  // closed 是终态:任何事件都短路(不复活 / 不推进 / 不广播)。closed→active 复活已收口到
  // ensure()(manager.ts:251,仅 SDK user message 用户 resume 才复活;REVIEW_83 HIGH +
  // shutdown_session SDK 尾包 follow-up)。
  if (record.lifecycle === 'closed') {
    return;
  }
  // **REVIEW_83 MED (reviewer-codex 单方 + lead 代码链验证)**: archived(非 closed) 会话短路,
  // 但 **session-end 终止事件例外**。根因:archiveImpl(lifecycle.ts:178) 只写 archivedAt 不动
  // lifecycle;原版本分支对 archivedAt !== null 一律 return → archived 的 active 会话收到
  // session-end 时 lifecycle 永停 active(endedAt 也不写),且 scheduler findActive/DormantExpiring
  // 都过滤 archived_at IS NULL 不参与衰减 → unarchive 后该会话以幽灵 active 出现在实时面板
  // (实际早已结束)。修法:archived 会话仍落 session-end 的 lifecycle 终止转换(active→dormant/closed
  // + endedAt),但 **不 emit session-upserted**(archived 会话不作实时活动广播,codex 修复方向;
  // unarchive 时 unarchiveImpl 走 sessionRepo.get 读到 fresh lifecycle 再 emit)。非终止事件
  // (message / tool-use 等)仍一律短路防 phantom 活(与 REVIEW_49 archived 回归 test 一致)。
  if (record.archivedAt !== null) {
    if (event.kind === 'session-end') {
      const term: LifecycleState = event.source === 'sdk' ? 'dormant' : 'closed';
      if (term !== record.lifecycle) {
        sessionRepo.setLifecycle(event.sessionId, term, event.ts, { clearPinned: true });
      }
    }
    return;
  }
  const handOffBuffered =
    event.kind === 'message' &&
    event.payload !== null &&
    typeof event.payload === 'object' &&
    (event.payload as { handOffBuffered?: unknown }).handOffBuffered === true;
  // A handoff-buffered user event is durable history but has not started source execution. Keep the
  // source idle so the prepared UI cutover can accept and deliver that late input to the successor.
  const nextActivity = handOffBuffered
    ? record.activity
    : nextActivityState(record.activity, event.kind, event.payload);
  let nextLifecycle: LifecycleState = record.lifecycle;
  if (record.lifecycle !== 'active') {
    // 任意事件都让会话回到 active（复活）
    nextLifecycle = 'active';
  }
  if (event.kind === 'session-end') {
    // Hook 通道的 session-end = 终端里 CLI 真退出了，没法再续 → closed。
    // SDK 通道的 session-end = 我们这边 query 流终止（用户中断 / dev 重启 / 流出错），
    // 但 ~/.claude/projects 里的对话历史还在，用户随时可以 resume → 标 dormant 更合理。
    nextLifecycle = event.source === 'sdk' ? 'dormant' : 'closed';
    sessionRepo.setEventState(
      event.sessionId,
      nextActivity,
      nextLifecycle,
      event.ts,
      { clearPinned: true },
    );
    const updated = sessionRepo.get(event.sessionId);
    if (updated) eventBus.emit('session-upserted', updated);
    return;
  }

  if (nextActivity !== record.activity || nextLifecycle !== record.lifecycle) {
    const updated: SessionRecord = {
      ...record,
      activity: nextActivity,
      lifecycle: nextLifecycle,
      lastEventAt: event.ts,
      endedAt: null,
    };
    sessionRepo.upsert(updated);
    eventBus.emit('session-upserted', updated);
  } else {
    // 仅刷新 activity（即便没真变也顺便把 last_event_at 推进）。
    // 不广播 session-upserted —— renderer 不需要为「只是 lastEventAt 变了」重渲染整张卡。
    sessionRepo.setActivity(event.sessionId, nextActivity, event.ts);
  }
}
