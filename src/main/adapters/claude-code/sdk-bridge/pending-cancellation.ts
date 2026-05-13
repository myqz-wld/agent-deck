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
 * 清掉 internal 上的三个 pending Maps + emit *-cancelled 事件。
 *
 * @param internal 待 close 的 session 内部 state
 * @param realIdForEmit emit 用的 sessionId（realSessionId ?? sessionId 兜底，与
 *   原 closeSession 同款；wait 之前 close 罕见路径用 sessionId 兜底）
 * @param emit AgentEvent dispatcher（注入避免直接 import event-bus）
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
  }
  internal.pendingExitPlanModes.clear();
}

/**
 * closeSession 的 step 2-5 整套 cleanup 链。
 *
 * facade closeSession 内调用顺序（与原 inline 实现 100% 一致）：
 * 1. emit `*-cancelled` + clear 三 pending Map（cancelPendingAndEmit）
 * 2. sessions.delete(key) — consume() stream 下次 notify 后自然终止
 * 3. releaseSdkClaim sessionId / realSessionId（避免 hook 事件误吞）
 * 4. markRecentlyDeleted sessionId / realSessionId（REVIEW_12 Bug 5 60s 黑名单兜底）
 * 5. notify wakeup（唤醒 createUserMessageStream 的 await）
 */
export function runCloseSessionCleanup(args: {
  sessions: Map<string, InternalSession>;
  internal: InternalSession;
  key: string;
  sessionId: string;
  emit: (e: AgentEvent) => void;
}): void {
  const { sessions, internal, key, sessionId, emit } = args;

  // step 2 + 顺手修：先 emit 后 clear，避免 store 端 zombie row 残留
  const realIdForEmit = internal.realSessionId ?? sessionId;
  cancelPendingAndEmit(internal, realIdForEmit, emit);

  // step 3：从 sessions map 移除
  sessions.delete(key);

  // step 4：释放 sdkOwned（sessionId + realSessionId 双面）
  sessionManager.releaseSdkClaim(sessionId);
  if (internal.realSessionId && internal.realSessionId !== sessionId) {
    sessionManager.releaseSdkClaim(internal.realSessionId);
  }

  // REVIEW_12 Bug 5 双保险：sessionId + realSessionId 加 recentlyDeleted 60s 黑名单。
  // 覆盖 OLD CLI 子进程 SIGTERM 后飞回的迟到 hook event 仍带 OLD_ID 或 realSessionId 窗口。
  // 与 SessionManager.delete + renameSdkSession 入口对称。
  sessionManager.markRecentlyDeleted(sessionId);
  if (internal.realSessionId && internal.realSessionId !== sessionId) {
    sessionManager.markRecentlyDeleted(internal.realSessionId);
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
