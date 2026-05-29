/**
 * SessionManager lifecycle / 黑名单 / meta 域 free function(拆自 manager.ts — Step 4.6
 * plan deep-project-review-comprehensive-20260528)。
 *
 * 11 个 free function 对应 SessionManagerClass 同名 method:
 *
 * **lifecycle 域** (8 method):
 * - markDormantImpl — active → dormant 推进 (LifecycleScheduler 用)
 * - markClosedImpl — dormant/active → closed 推进 + applyClosedSideEffects fire-and-forget
 * - closeImpl (async) — 主动 close: sessionCloseFn + setLifecycle('closed') + applyClosedSideEffects
 *   (awaitLeave: true)
 * - archiveImpl (async) — setArchived + clearCwdReleaseMarker + archiveTeamsIfOrphaned 联动
 * - unarchiveImpl (async) — setArchived(null) + unarchiveTeamsForRevivedLead 联动
 * - unarchiveOnUserSendImpl (async) — IPC AdapterSendMessage 用户主动信号 → 已 archived 才调 unarchive
 * - reactivateImpl — closed → active 强制复活
 * - deleteImpl (async) — leaveTeamsAndAutoArchive('deleted') + sessionCloseFn + sessionRepo.delete +
 *   黑名单双写 + emit 'session-removed'
 *
 * **黑名单域** (1 method,与 _deps.ts isRecentlyDeletedImpl 配对):
 * - markRecentlyDeletedImpl — 双写 {applicationSid, cliSessionId}(R5 MED-R5-1 升级)
 *
 * **meta 域** (2 method):
 * - recordCreatedPermissionModeImpl — 创建会话后持久化 permission_mode (IPC + CLI 两路入口)
 * - notifyTeamMembershipChangedImpl — universal team backend 写入后触发 session-upserted enrich
 *
 * **Deps capture 模式**: facade class method 调本 free function 时直接传 module-level
 * `sessionCloseFn` 当前 value(closeImpl / deleteImpl)。setSessionCloseFn 只在 main bootstrap
 * 调一次,运行期不变,无 race 风险。
 */
import type { SessionRecord } from '@shared/types';
import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import {
  leaveTeamsAndAutoArchive,
  archiveTeamsIfOrphaned,
  unarchiveTeamsForRevivedLead,
  applyClosedSideEffects,
} from '../manager-team-coordinator';
import type { SessionCloseFn, SessionManagerInternalState } from './_deps';

/**
 * 把 sessionId 加进黑名单,覆盖「主动关闭后 OLD CLI 子进程异步飞回的迟到 hook event 仍带 OLD_ID」窗口。
 *
 * 拆自 manager.ts:308 SessionManagerClass.markRecentlyDeleted public method。设计上与
 * SessionManager.delete + renameSdkSession 对称——三个入口任一关掉某 sessionId 都应保证后续 60s 内
 * 同 sessionId 的 hook event 被 ingest 入口 isRecentlyDeleted 直接丢弃。sdk-bridge.ts:closeSession
 * 调本方法 + 内部已配 hookOrigin='sdk' 兜底(REVIEW_12 主修法),双保险确保 origin tag 升级前的老
 * hook 命令(settings.json 残留)路径也能挡住。
 *
 * **plan reverse-rename-sid-stability-20260520 §A.3 / R5 MED-R5-1 双写升级**:
 * 反向 rename 后 SDK 尾包用 appSid 来 / hook 尾包用 cliSid 来,黑名单必须**双写**
 * `{applicationSid, cliSessionId}` 才能挡住所有来源。caller 入参 sessionId 通常是 applicationSid
 * (sdk-bridge.ts closeSession 路径),但鲁棒兼容传 cliSid 也能写入。
 *
 * caller 不存在 sessions row 时(已删) → rec=null,只 set sessionId 入参一个 key
 * (兜底防御:行已不存在但 caller 仍主动加黑名单,典型 closeSession 时 sessions row
 * 已被 sessionRepo.delete 清的边角)。
 */
export function markRecentlyDeletedImpl(
  state: SessionManagerInternalState,
  sessionId: string,
): void {
  const now = Date.now();
  state.recentlyDeleted.set(sessionId, now);
  // R5 MED-R5-1 双写:从 sessionRepo 反查 cliSessionId,与 sessionId 不同时也写入黑名单
  // (反向 rename 后 sessionId 通常是 appSid,cliSid 是另一 key 维度,需双写覆盖)
  const rec = sessionRepo.get(sessionId);
  const cliSid = rec?.cliSessionId;
  if (cliSid && cliSid !== sessionId) {
    state.recentlyDeleted.set(cliSid, now);
  }
}

/** lifecycle scheduler 用:把 active 推到 dormant(拆自 manager.ts:321 markDormant)。 */
export function markDormantImpl(sessionId: string): void {
  const r = sessionRepo.get(sessionId);
  if (!r || r.lifecycle !== 'active') return;
  sessionRepo.setLifecycle(sessionId, 'dormant', Date.now());
  const updated = sessionRepo.get(sessionId);
  if (updated) eventBus.emit('session-upserted', updated);
}

/**
 * lifecycle scheduler 用:把 dormant 推到 closed(拆自 manager.ts:330 markClosed)。
 *
 * REVIEW_56 §F20 修法 (Plan-Review Round 1 + spike 决策, DRY): 三入口 (markClosed / close /
 * lifecycle-scheduler purge) 副作用统一抽 applyClosedSideEffects helper。
 * 顺序: sync clearMarker → sync onClearedBeforeLeave callback (emit upserted) → async
 * fire-and-forget leave。三入口 invariant 显式声明 ("clear marker + leave + auto-archive
 * 三联动") — 详 manager-team-coordinator.ts §applyClosedSideEffects jsdoc。
 */
export function markClosedImpl(sessionId: string): void {
  const r = sessionRepo.get(sessionId);
  if (!r || (r.lifecycle !== 'dormant' && r.lifecycle !== 'active')) return;
  sessionRepo.setLifecycle(sessionId, 'closed', Date.now());
  void applyClosedSideEffects(sessionId, {
    awaitLeave: false,
    logPrefix: '[session-mgr] markClosed',
    onClearedBeforeLeave: () => {
      const updated = sessionRepo.get(sessionId);
      if (updated) eventBus.emit('session-upserted', updated);
    },
  });
}

/**
 * 主动 close(拆自 manager.ts:364 close)。
 *
 * R2 / B'0 ADR §6.5.2 #7:与 `delete` 不同,不删 DB 行,仅:
 * - 调 adapter.closeSession(abort SDK live query/turn + 清 pending Maps)
 * - sessionRepo.setLifecycle(id, 'closed')
 * - emit `session-upserted`(让 renderer 显示 closed 标记,不消失)
 *
 * 用途:MCP `shutdown_session` tool。**不调 sessionRepo.delete** 避免 ON DELETE CASCADE 把
 * events / file_changes / summaries 全部级联删掉(reviewer 双对抗 HIGH-4 修法:deep-code-review
 * 场景 lead 需要 reviewer shutdown 后引用其输出做三态裁决,hard-delete 致命)。
 *
 * 与 LifecycleScheduler.markClosed 的区别:markClosed 仅 setLifecycle,**不**调 adapter.closeSession
 * (scheduler 是「时间到自然衰减」,session 仍在跑就让它跑完自己结束);close(id) 是「立即终止」
 * 语义,必须把 SDK 子进程也关掉。
 *
 * REVIEW_56 §F20 修法 (Plan-Review Round 1 + spike 决策, DRY): 三入口副作用统一抽 helper。
 * 顺序: sync clearMarker → sync onClearedBeforeLeave callback (emit upserted + token release)
 * → await leave (close 是 async,等 leave 完让 caller 拿稳定状态)。
 * 历史顺序与 helper 完全等价: clearMarker → emit upserted → token release → await leave。
 */
export async function closeImpl(
  sessionId: string,
  sessionCloseFn: SessionCloseFn | null,
): Promise<void> {
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
  await applyClosedSideEffects(sessionId, {
    awaitLeave: true,
    logPrefix: '[session-mgr] close',
    onClearedBeforeLeave: () => {
      const updated = sessionRepo.get(sessionId);
      if (updated) eventBus.emit('session-upserted', updated);
      // plan codex-handoff-team-alignment-20260518 P2 Step 2.9:释放 per-session mcp token map
      // entry。codex bridge.closeSession 已经做过一次走 noop fast-path,这里再做一次双保护
      // (手动 close 没经 adapter.closeSession 路径也保证 token map 清干净 → 避免 token leak)。
      mcpSessionTokenMap.release(sessionId);
    },
  });
}

/**
 * 归档(拆自 manager.ts:394 archive)。
 *
 * 只设归档标记,不动 lifecycle —— 这样取消归档可以恢复原本的生命周期。
 *
 * R2 reviewer-codex MED 修法:archive() 同步清 cwd_release_marker。
 * 推理链:hand_off_session / archive_plan baton phase 2 调本 archive(callerSid) →
 * 仅打 archived_at 不清 marker → caller 后续被 unarchiveOnUserSend 复活 → 仍带旧 worktree
 * marker(指向 archive_plan 已删的 worktree path,marker 指向 stale 路径)→ 复活后调
 * archive_plan / 4 态 cwd dispatch 走 cwdReleaseMarker thunk(archive-plan-impl.ts:627)
 * 拿 stale marker 撞 cross-worktree warning / cwd invalid reject。
 * archive 语义 = caller 使命终结;复活时 marker 应已清空(unarchive 后 caller 应重新
 * EnterWorktree 才能再次 hold worktree state),清 marker 是符合预期的副作用。
 *
 * bug 修复(plan deep-review-and-split-20260513):lead session 被归档后,联动检查所属 active team
 * 是否已无 active lead → auto-archive team。membership 不动(lead 没真离开),countActiveLeads
 * 已加 INNER JOIN sessions archived_at IS NULL 过滤,本 sid 自动从计数中去除。helper 实现见
 * manager-team-coordinator.ts。
 */
export async function archiveImpl(sessionId: string): Promise<void> {
  sessionRepo.setArchived(sessionId, Date.now());
  sessionRepo.clearCwdReleaseMarker(sessionId);
  const updated = sessionRepo.get(sessionId);
  if (updated) eventBus.emit('session-upserted', updated);
  await archiveTeamsIfOrphaned(sessionId);
}

/**
 * 取消归档(拆自 manager.ts:415 unarchive)。
 *
 * 清掉 archived_at,lifecycle 保留不变,会话自动按真实 lifecycle 出现在对应面板
 * (active/dormant→实时,closed→历史)。
 *
 * bug 修复(unarchive 联动):lead session 复活时,所有该 session 还是 active member 且已 archived
 * 的 team 一并 unarchive(覆盖 archive 联动的反向)。helper 实现见 manager-team-coordinator.ts;
 * REVIEW_32 MED-7 守门只复活 'last-lead-archived'。
 */
export async function unarchiveImpl(sessionId: string): Promise<void> {
  sessionRepo.setArchived(sessionId, null);
  const updated = sessionRepo.get(sessionId);
  if (updated) eventBus.emit('session-upserted', updated);
  await unarchiveTeamsForRevivedLead(sessionId);
}

/**
 * 用户主动 sendMessage / resume 触发的「显式信号」自动 unarchive 入口
 * (拆自 manager.ts:444 unarchiveOnUserSend)。
 *
 * plan mcp-bug-and-feature-batch-20260513 N bug fix:与「事件流被动到达 → archived 不动」
 * (manager.ts:152-156 正交约定)严格区分。
 *
 * - 已 archived(archivedAt 非 null)→ 调 unarchive() 清 archived_at + emit upsert + team
 *   unarchive 联动
 * - 未 archived(archivedAt = null)→ noop(不 emit / 不跑 team coordinator 多余工作)
 * - 不存在的 sid → noop(caller 自己处理 not-found)
 *
 * lifecycle 与 unarchive() 同款不动:dormant 仍 dormant、active 仍 active;closed 也保持
 * (caller 后续 ingest event 会走 ensure() closed→active 复活路径,正交)。
 *
 * **唯一调用入口**:IPC AdapterSendMessage handler(src/main/ipc/adapters.ts),是用户从
 * UI / CLI 显式 sendMessage 的桥点。mcp tool send_message 走 universal-message-watcher
 * 不经此 API(cross-session 程序化通信不算「用户主动续聊归档会话」UX 信号)。
 */
export async function unarchiveOnUserSendImpl(
  sessionId: string,
  unarchive: (sid: string) => Promise<void>,
): Promise<void> {
  const r = sessionRepo.get(sessionId);
  if (!r || r.archivedAt === null) return;
  await unarchive(sessionId);
}

/** 复活到 active(拆自 manager.ts:450 reactivate)。 */
export function reactivateImpl(sessionId: string): void {
  const r = sessionRepo.get(sessionId);
  if (!r) return;
  sessionRepo.setLifecycle(sessionId, 'active', Date.now());
  const updated = sessionRepo.get(sessionId);
  if (updated) eventBus.emit('session-upserted', updated);
}

/**
 * 创建会话后把用户选过的 permissionMode 持久化到 sessions 列
 * (拆自 manager.ts:465 recordCreatedPermissionMode)。
 *
 * IPC 路径(renderer 新建对话框)和 CLI 路径(agent-deck new --permission-mode ...) 都要调用,
 * 否则两条入口语义会飘:UI 显示 default 但 SDK 实际是 plan,或者反过来,跟实际状态对不上。
 * 'default' 等价于不设(不污染 CLI 通道列),其他值(acceptEdits / plan / bypassPermissions)才写入。
 */
export function recordCreatedPermissionModeImpl(sessionId: string, mode: string | undefined): void {
  if (!mode || mode === 'default') return;
  sessionRepo.setPermissionMode(
    sessionId,
    mode as Parameters<typeof sessionRepo.setPermissionMode>[1],
  );
  const updated = sessionRepo.get(sessionId);
  if (updated) eventBus.emit('session-upserted', updated);
}

/**
 * universal team backend 写入后触发被影响 session 的 session-upserted → 桥点重新 enrich
 * (拆自 manager.ts:484 notifyTeamMembershipChanged)。
 *
 * plan team-cohesion-fix-20260513 Phase A:addMember / leaveTeam / setRole 调用后调用,
 * 触发 session-upserted → 桥点重新 enrich → renderer 立即看到 teams[] 变化(chip 出现 /
 * 消失 / 角色切换)。
 *
 * 不在 agentDeckTeamRepo.addMember 内自动 emit(repo 层职责单一,不知道 eventBus);也不在
 * mcp/tools.ts handler 内直接 import eventBus(避免 mcp 模块依赖 main event 系统)。走
 * sessionManager facade 是干净中间层。
 */
export function notifyTeamMembershipChangedImpl(sessionId: string): void {
  const rec = sessionRepo.get(sessionId);
  if (rec) eventBus.emit('session-upserted', rec);
}

/**
 * 删 session(拆自 manager.ts:489 delete)。
 *
 * R3.E0 ADR §2.5 + plan linked-swimming-platypus (v017):
 * v017 起 agent_deck_team_members.session_id FK 改 ON DELETE CASCADE,sessions DELETE 自动级联
 * 清 team_members rows,不再需要 leaveTeam pre-check 绕 FK。历史 v010-v016 期间靠 leaveTeam 写
 * left_at 然后 sessionRepo.delete「兜底」实际**失效**(RESTRICT 不在乎 left_at 是否非空,DELETE
 * 仍撞 FK,bug 隐藏未触发)—— v017 修正。
 *
 * leaveTeamsAndAutoArchive 仍 await 调用是为了正确顺序:
 * 1. 写 left_at + emit 'agent-deck-team-member-changed' 让 TeamHub / TeamDetail 立刻刷新
 * 2. 0-active-lead 触发 team auto-archive + emit 'agent-deck-team-updated'
 * 3. 然后 sessionRepo.delete 走 CASCADE 物理清 row(作为 archive 之后的清理收尾)
 * 顺序颠倒(先 delete 再 leaveTeamsAndAutoArchive)会让 CASCADE 已删 member rows,leaveTeam 找不到
 * active row → 不 emit member-changed → UI 不刷新;同时 archive 联动也跑空。await 顺序是 UX 正确性
 * 而非 FK 绕行。
 *
 * REVIEW_4 H1:必须 **await** close 完成再删 DB 行 + 广播。旧版 fire-and-forget close → DB 同步 delete
 * 后,SDK 侧 abort 触发的尾包 `finished{subtype:interrupted}` 仍会到达 ingest → ensureRecord 把已删
 * session 复活成 lifecycle:active 的幽灵 record + 多通知一条「Agent 完成」。现在 close 内部已用
 * `intentionallyClosed` 标记屏蔽 runTurnLoop catch 的 emit(sdk-bridge 层),manager 这边 await 是
 * 双保险:确保 abort + close 路径都跑完才删行 + 广播 'session-removed',renderer 不会先看到「已删」
 * 再看到尾包复活。
 *
 * close 抛错只 warn —— DB 行不能因为 SDK 回收失败留着,孤儿状态更糟。
 *
 * **plan reverse-rename-sid-stability-20260520 §A.3 / R5 MED-R5-1 黑名单双写升级**:
 * 在 sessionRepo.delete 之前先反查 cliSessionId(DELETE 后 row 不在),让 SessionManager.delete 路径
 * 与 markRecentlyDeleted 同款双写 {appSid, cliSid}。反向 rename 后 SDK 尾包用 appSid 来 / hook 尾包
 * 用 cliSid 来,双写才挡得住所有来源。
 *
 * REVIEW_4 H1:把 id 加入「最近删除黑名单」60s,ingest 看到该 id 直接丢弃,防 SDK 流终止 / 异常 stream
 * 的尾包在 sessionRepo.delete 后到达 ensureRecord。
 */
export async function deleteImpl(
  state: SessionManagerInternalState,
  sessionId: string,
  sessionCloseFn: SessionCloseFn | null,
): Promise<void> {
  await leaveTeamsAndAutoArchive(sessionId, 'deleted');
  const session = sessionRepo.get(sessionId);
  if (session?.agentId && sessionCloseFn) {
    try {
      await sessionCloseFn(session.agentId, sessionId);
    } catch (err) {
      console.warn(`[session-mgr] close on delete failed: ${sessionId}`, err);
    }
  }
  // R5 MED-R5-1 双写:applicationSid + cliSessionId 双 key 入黑名单
  const recBeforeDelete = sessionRepo.get(sessionId);
  const cliSidBeforeDelete = recBeforeDelete?.cliSessionId;
  sessionRepo.delete(sessionId);
  const now = Date.now();
  state.recentlyDeleted.set(sessionId, now);
  if (cliSidBeforeDelete && cliSidBeforeDelete !== sessionId) {
    state.recentlyDeleted.set(cliSidBeforeDelete, now);
  }
  eventBus.emit('session-removed', sessionId);
}

// re-export SessionRecord type 让本文件 import 链不挂(虽然本文件未直接用,但 lifecycle 域典型
// caller 多用 SessionRecord,导出符合 sub-module 设计意图)
export type { SessionRecord };
