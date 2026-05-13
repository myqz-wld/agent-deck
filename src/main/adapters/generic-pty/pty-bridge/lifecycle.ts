/**
 * GenericPtyBridge close / shutdown 路径（CHANGELOG_82 Step 3.1 Tier 2 拆分）。
 *
 * 拆出原因：close + shutdown 两条路径都涉及 timer 清理 + fileWatcher.close 异步释放
 * fs handle + sessions Map mutate，逻辑量集中且 race 边界清晰，独立成 module 后单测
 * 便利（不需要全套 GenericPtyBridge 实例 mock）。
 *
 * state ownership：函数签名显式接受 sessions Map + opts；不引入 ctx 共享对象（pty
 * 比 manager 简单，不像 CHANGELOG_52 拆 manager 的 ctx 模式那么必要）。
 *
 * REVIEW_24 codex MED 1/2 与 CHANGELOG_67 行为完全保持，零业务变更（纯物理拆分）。
 */

import {
  KILL_GRACE_MS,
  type GenericPtyBridgeOptions,
  type PtySessionState,
} from './pty-session-state';

/**
 * 关闭单 session：SIGTERM → 10s grace → SIGKILL 兜底 → onExit 清理 state。
 * 多次调用安全（已 closed 直接 noop）。
 *
 * REVIEW_24 codex MED 1：先 SIGTERM 让 kernel 立即开始 grace；fileWatcher.close
 * 改 fire-and-forget（不阻塞 close 主流程）。**之前** await watcher 在 SIGTERM 之前 →
 * watcher close 慢 / throw 时 SIGTERM 路径不可达，违背关闭契约。
 *
 * REVIEW_24 codex MED 2：设 killTimer 前 check sessions Map 还在（onExit 在
 * SIGTERM ↔ killTimer 设置之间同步触发可能已 delete）。否则 killTimer 引用已脱离
 * Map 的 state，会额外持 event loop 直到 10s grace 到（虽然不影响正确性，是 leak）。
 *
 * shutdownAll 仍保持 await all watcher.close（process exit 时必须释放 fs handle）。
 */
export async function closeSessionImpl(
  sessions: Map<string, PtySessionState>,
  opts: GenericPtyBridgeOptions,
  sessionId: string,
): Promise<void> {
  const state = sessions.get(sessionId);
  if (!state) return;
  if (state.intentionallyClosed) return; // 已 close 中，等 onExit 自然清
  state.intentionallyClosed = true;
  // F3：close 时立刻 dispose idle detector（避免 SIGTERM 后子进程未退期间还有迟到 chunk 触发 timer）
  state.idleDetector.dispose();
  // codex MED 1：先 SIGTERM 让 kernel 立刻开始 grace（不被 watcher close 阻塞）
  try {
    state.pty.kill('SIGTERM');
  } catch (err) {
    console.warn(`[generic-pty:${opts.adapterId}] SIGTERM ${sessionId} 失败`, err);
  }
  // codex MED 2：onExit 可能已在 SIGTERM 同步路径里 fire 并 delete sessions[sid]
  // → 此处 sessions.has() check 防止 killTimer 引用已脱离 Map 的 state 多挂 10s
  if (sessions.has(sessionId)) {
    state.killTimer = setTimeout(() => {
      const s = sessions.get(sessionId);
      if (!s) return; // 已被 onExit 清掉
      try {
        s.pty.kill('SIGKILL');
      } catch (err) {
        console.warn(`[generic-pty:${opts.adapterId}] SIGKILL ${sessionId} 失败`, err);
      }
    }, KILL_GRACE_MS);
  }
  // F4 + codex MED 1：fileWatcher.close fire-and-forget（不阻塞 closeSession 返回；
  // fs handle 释放是异步关，对业务无影响。shutdownAll 路径仍 await 所有 close 兜底）。
  void state.fileWatcher.close().catch((err) => {
    console.warn(
      `[generic-pty:${opts.adapterId}] fileWatcher.close ${sessionId} 失败`,
      err,
    );
  });
  // 注：不在此 await onExit；caller 不需要等子进程实际退出（emit session-end 异步触发）
}

/**
 * 进程级 cleanup：app shutdown 时调，SIGKILL 所有未关 session（best-effort）。
 * F4：并发 await 所有 fileWatcher.close（释放 fs handle 是退出关键）。
 */
export async function shutdownAllImpl(
  sessions: Map<string, PtySessionState>,
  opts: GenericPtyBridgeOptions,
): Promise<void> {
  const closeTasks: Promise<void>[] = [];
  for (const [sid, state] of sessions) {
    state.intentionallyClosed = true;
    state.idleDetector.dispose();
    if (state.killTimer) clearTimeout(state.killTimer);
    try {
      state.pty.kill('SIGKILL');
    } catch (err) {
      console.warn(`[generic-pty:${opts.adapterId}] shutdown SIGKILL ${sid} 失败`, err);
    }
    closeTasks.push(
      state.fileWatcher.close().catch((err) => {
        console.warn(
          `[generic-pty:${opts.adapterId}] shutdown fileWatcher.close ${sid} 失败`,
          err,
        );
      }),
    );
  }
  await Promise.all(closeTasks);
  sessions.clear();
}
