/**
 * closeSession cleanup 链 — pending cancel + sdkOwned release + zombie row 兜底
 *（CHANGELOG_85 Step 3.2）。
 *
 * 抽自 ClaudeSdkBridge.closeSession 内 step 2-5（cancel 三段 / sessions.delete /
 * releaseSdkClaim / markRecentlyDeleted / notify wakeup）。把整套 close cleanup 链
 * 收口到一处，让 facade closeSession 只关心 sessionId resolve + interrupt 主路径。
 *
 * 行为（保持原 closeSession step 2-5 内联实现等价）：
 * - cancelPendingAndEmit：清三 pending Map + emit *-cancelled（顺序：emit → clear）
 * - sessions.delete(key)：consume() 内 createUserMessageStream 检查 sessions.has(key)
 *   决定是否 return，delete 后 stream 在下一次 notify 后自然终止
 * - releaseSdkClaim：避免后续同 sessionId 的 hook 事件被误吞（删了 = 不再接管）
 * - markRecentlyDeleted：REVIEW_12 Bug 5 双保险，60s 黑名单挡迟到 hook event
 * - notify wakeup：唤醒 createUserMessageStream 的 await，让它走到 sessions.has(key)
 *   === false 后 return
 */

import type { AgentEvent } from '@shared/types';
import { sessionManager } from '@main/session/manager';
import { AGENT_ID } from './constants';
import type { InternalSession } from './types';

/**
 * 清掉 internal 上的三个 pending Maps + emit *-cancelled 事件 + best-effort resolve SDK promise。
 *
 * @param internal 待 close 的 session 内部 state
 * @param realIdForEmit emit 用的 sessionId（caller 传 internal.applicationSid；
 *   wait 之前 close 罕见路径用 sessionId 兜底）
 * @param emit AgentEvent dispatcher（注入避免直接 import event-bus）
 *
 * **REVIEW_78 MED 防御性 hardening（reviewer-codex 提 + lead 裁 LOW→仍 fix）**：每条 entry emit
 * cancelled 后**额外调 entry.resolver** best-effort 释放 canUseTool 的 await。修前依赖 closeSession
 * 先 `await query.interrupt()` 同步驱动 can-use-tool.ts abort listener resolve（reviewer-claude
 * 论证此时序通常成立），但 SDK interrupt() 的 ctx.signal abort 同步性**未契约保证**：若 abort 在
 * `await interrupt()` 返回后才 async fire，则 cancelPendingAndEmit 先 clear Map → abort listener
 * 与 consume() finally（stream-processor.ts:422-440）都 iterate 空 Map → canUseTool promise 不被
 * resolve（GC 时悬挂，非资源泄漏但语义不洁）。此处主动 resolve 让释放责任不依赖 interrupt 同步性。
 * **幂等安全**：Promise resolve 首次 settle 后续 no-op，与 abort listener / consume finally 任一
 * 先 resolve 不冲突（与 can-use-tool.ts 三方 delete 竞争同款幂等论证）。resolver 语义对齐 consume
 * finally：permission→deny+interrupt / ask→__session_ended__ / exitPlan→keep-planning。
 */
export function cancelPendingAndEmit(
  internal: InternalSession,
  realIdForEmit: string,
  emit: (e: AgentEvent) => void,
): void {
  for (const entry of internal.pendingPermissions.values()) {
    emit({
      sessionId: realIdForEmit,
      agentId: AGENT_ID,
      kind: 'waiting-for-user',
      payload: { type: 'permission-cancelled', requestId: entry.payload.requestId },
      ts: Date.now(),
      source: 'sdk',
    });
    if (entry.timer) clearTimeout(entry.timer);
    // best-effort resolve（幂等）：不依赖 interrupt() 同步驱动 abort listener
    entry.resolver({ behavior: 'deny', message: 'session ended', interrupt: true });
  }
  internal.pendingPermissions.clear();
  for (const entry of internal.pendingAskUserQuestions.values()) {
    emit({
      sessionId: realIdForEmit,
      agentId: AGENT_ID,
      kind: 'waiting-for-user',
      payload: { type: 'ask-question-cancelled', requestId: entry.payload.requestId },
      ts: Date.now(),
      source: 'sdk',
    });
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolver({
      answers: [{ question: '__session_ended__', selected: [], other: '会话已结束' }],
    });
  }
  internal.pendingAskUserQuestions.clear();
  for (const entry of internal.pendingExitPlanModes.values()) {
    emit({
      sessionId: realIdForEmit,
      agentId: AGENT_ID,
      kind: 'waiting-for-user',
      payload: { type: 'exit-plan-cancelled', requestId: entry.payload.requestId },
      ts: Date.now(),
      source: 'sdk',
    });
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolver({ decision: 'keep-planning', feedback: '会话已结束' });
  }
  internal.pendingExitPlanModes.clear();
}

/**
 * closeSession 的 step 2-5 整套 cleanup 链。
 *
 * facade closeSession 内调用顺序（与原 inline 实现 100% 一致）：
 * 1. emit `*-cancelled` + best-effort resolve + clear 三 pending Map（cancelPendingAndEmit）
 * 2. sessions.delete(key) — consume() stream 下次 notify 后自然终止
 * 3. releaseSdkClaim 三面（sessionId / applicationSid / cliSessionId，互不相等时各释放一次）
 * 4. markRecentlyDeleted 三面（sessionId / applicationSid / cliSessionId，REVIEW_12 Bug 5 +
 *    R5 MED-R5-1 升级 60s 黑名单兜底，挡反向 rename 后 SDK 尾包(appSid) / hook 尾包(cliSid)）
 * 5. notify wakeup（唤醒 createUserMessageStream 的 await）
 */
export function runCloseSessionCleanup(args: {
  sessions: Map<string, InternalSession>;
  internal: InternalSession;
  key: string;
  sessionId: string;
  emit: (e: AgentEvent) => void;
  markRecentlyDeleted?: boolean;
}): void {
  const { sessions, internal, key, sessionId, emit, markRecentlyDeleted = true } = args;

  // step 2 + 顺手修：先 emit 后 clear，避免 store 端 zombie row 残留
  // **plan reverse-rename-sid-stability-20260520 §A.4-pre S4b R5 MED-R5-1 修订**:
  // realIdForEmit 改用 internal.applicationSid (替代 internal.realSessionId ?? sessionId) —
  // S4b 弹窗初始 emit (can-use-tool.ts:139/219/349 走 getSessionId() = internal.applicationSid 维度)
  // 必须与 cancellation event 维度对齐,PendingTab(appSid) 路由 cancellation 才能清掉 pending 项;
  // 反向 rename 后 internal.cliSessionId 是 cli sid 维度,close cleanup 用 cli sid 发 cancellation
  // event 会让 PendingTab 漂浮 pending 项无人清 (R4 HIGH-H 13 同款 PendingTab 路由错位)。
  const realIdForEmit = internal.applicationSid;
  cancelPendingAndEmit(internal, realIdForEmit, emit);
  internal.pendingUserMessages.length = 0;
  internal.acceptedEnqueueFingerprints?.clear();

  // step 3：从 sessions map 移除
  if (sessions.get(key) === internal) {
    sessions.delete(key);
  }

  // step 4：释放 sdkOwned (sessionId + applicationSid + cliSessionId 三面 — applicationSid 总是
  // 与 sessionId 同款维度但显式 release 一份保险;cliSessionId 与 applicationSid 不同时释放 cli sid claim)
  sessionManager.releaseSdkClaim(sessionId);
  if (internal.applicationSid !== sessionId) {
    sessionManager.releaseSdkClaim(internal.applicationSid);
  }
  if (internal.cliSessionId && internal.cliSessionId !== sessionId && internal.cliSessionId !== internal.applicationSid) {
    sessionManager.releaseSdkClaim(internal.cliSessionId);
  }

  // REVIEW_12 Bug 5 双保险 + R5 MED-R5-1 升级: sessionId + applicationSid + cliSessionId 加 recentlyDeleted 60s 黑名单。
  // 覆盖 OLD CLI 子进程 SIGTERM 后飞回的迟到 hook event 仍带 OLD_ID 或 cliSessionId 窗口。
  // 与 SessionManager.delete + renameSdkSession 入口对称 (markRecentlyDeleted 内部 R5 MED-R5-1 双写已加 cliSid,
  // 此处显式调一次保 sessionId 自己 + 反向 rename 后 caller 入参 sessionId 是 appSid / cliSid 不同 都被覆盖)。
  if (markRecentlyDeleted) {
    sessionManager.markRecentlyDeleted(sessionId);
    if (internal.applicationSid !== sessionId) {
      sessionManager.markRecentlyDeleted(internal.applicationSid);
    }
    if (internal.cliSessionId && internal.cliSessionId !== sessionId && internal.cliSessionId !== internal.applicationSid) {
      sessionManager.markRecentlyDeleted(internal.cliSessionId);
    }
  }

  // step 5：唤醒 createUserMessageStream 的 await，让它走到 sessions.has(key) === false 后 return。
  if (internal.notify) {
    const n = internal.notify;
    internal.notify = null;
    try {
      n();
    } catch {
      // ignore
    }
  }
}
