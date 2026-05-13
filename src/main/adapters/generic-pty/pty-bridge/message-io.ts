/**
 * GenericPtyBridge 消息 I/O + listener factory（CHANGELOG_82 Step 3.1 Tier 2 拆分）。
 *
 * 拆出原因：
 * - sendMessage / interrupt：close 后边界检查 + emit + pty.write 三段直线代码，
 *   独立模块好做单测（不需要 ptySpawn 真起进程）
 * - makeStdoutListener / makeExitListener：onData / onExit 是 native callback，
 *   按 closure ref 传 (sessions, state, sessionId, opts) 进 factory 拿回 handler
 *   函数，让 createSession 主体用 pty.onData(makeStdoutListener(...)) 一行调用
 *
 * REVIEW_24 MED-Claude4 与 CHANGELOG_67 行为完全保持，零业务变更（纯物理拆分）。
 */

import type { UploadedAttachmentRef } from '@shared/types';
import { stripAnsi } from '../ansi-parser';
import {
  MAX_PROMPT_LENGTH,
  type GenericPtyBridgeOptions,
  type PtySessionState,
} from './pty-session-state';

/**
 * 写 stdin。attachments 静默忽略（PTY 没概念）。
 * - 与 receiveTeammateMessage 同实现（F-bonus 加 capabilities 后让 watcher 调）
 * - 不抛错也不返回成功 / 失败信号；UI / watcher 视 emit message 为「已送达」线索
 *
 * REVIEW_24 MED-Claude4：closeSession 后窗口期内仍有 sendMessage / receiveTeammateMessage
 * 进来 — 之前 state 还在 Map（要等 onExit 异步清），会 emit 一条 user message 然后
 * pty.write 撞到 SIGTERM 后的 PTY 触发 broken pipe → throw → watcher retry 3 次都同款失败 →
 * markFailed reason=EIO（不准）。修法：sendMessage 顶部检查 intentionallyClosed，立刻
 * throw 让 watcher 走 retry → state 清后下次 retry 拿 'session not found' markFailed
 * reason 准确，且节省 3 次 retry quota。
 */
export async function sendMessageImpl(
  sessions: Map<string, PtySessionState>,
  opts: GenericPtyBridgeOptions,
  sessionId: string,
  text: string,
  _attachments?: UploadedAttachmentRef[],
): Promise<void> {
  const state = sessions.get(sessionId);
  if (!state) {
    throw new Error(`[generic-pty:${opts.adapterId}] session ${sessionId} not found`);
  }
  if (state.intentionallyClosed) {
    throw new Error(`[generic-pty:${opts.adapterId}] session ${sessionId} is closing`);
  }
  if (text.length > MAX_PROMPT_LENGTH) {
    throw new Error(`[generic-pty:${opts.adapterId}] message > ${MAX_PROMPT_LENGTH} chars`);
  }
  // emit user message 让 UI 立即看到
  opts.emit({
    sessionId,
    agentId: opts.adapterId,
    kind: 'message',
    payload: { text, role: 'user' },
    ts: Date.now(),
    source: 'sdk',
  });
  state.pty.write(text.endsWith('\n') ? text : text + '\n');
}

/**
 * Ctrl+C ASCII (\x03) 中断当前命令。不杀子进程，PTY 仍存活。
 * 与 codex / claude SDK 的 interrupt 概念对齐（中断当前 turn，不关 session）。
 */
export async function interruptImpl(
  sessions: Map<string, PtySessionState>,
  sessionId: string,
): Promise<void> {
  const state = sessions.get(sessionId);
  if (!state) return; // session 不在了直接 noop（不抛错，与 codex/claude 同款）
  state.pty.write('\x03');
}

/**
 * 工厂：onData listener。
 *
 * 行为：
 * 1. F3：strip ANSI escape，避免 UI 渲染控制字符
 * 2. push 进 outputBuffer 给 idle 二次校验用
 * 3. 收到新 chunk → 复位 idle emit dedup（让下次 idle 能再 emit）+ reset detector
 * 4. emit message kind=assistant
 *
 * 用法：`pty.onData(makeStdoutListener(state, sessionId, opts))`
 */
export function makeStdoutListener(
  state: PtySessionState,
  sessionId: string,
  opts: GenericPtyBridgeOptions,
): (data: string) => void {
  return (data: string) => {
    const stripped = stripAnsi(data);
    state.outputBuffer.push(stripped);
    state.idleEmitted = false;
    state.idleDetector.onData(state.outputBuffer);
    opts.emit({
      sessionId,
      agentId: opts.adapterId,
      kind: 'message',
      payload: { text: stripped, role: 'assistant' },
      ts: Date.now(),
      source: 'sdk',
    });
  };
}

/**
 * 工厂：onExit listener。
 *
 * 行为：
 * 1. emit session-end，reason 区分 user-closed / signal=N / exit=N
 * 2. cleanup：idleDetector.dispose / fileWatcher.close 异步触发 / clear killTimer / sessions.delete
 *
 * 注：F4 fileWatcher.close 在 onExit 内 fire-and-forget（onExit 是 sync callback，不能
 * await；R3 老 team-watcher 在 SDK shutdown 链路里 await 因为是 promise chain，这里 PTY
 * exit 是 native callback 不是 promise，void close() fire-and-forget；shutdownAll /
 * closeSession 路径仍 await）。
 *
 * 用法：`pty.onExit(makeExitListener(sessions, state, sessionId, opts))`
 */
export function makeExitListener(
  sessions: Map<string, PtySessionState>,
  state: PtySessionState,
  sessionId: string,
  opts: GenericPtyBridgeOptions,
): (e: { exitCode?: number; signal?: number }) => void {
  return ({ exitCode, signal }) => {
    const reason = state.intentionallyClosed
      ? 'user-closed'
      : signal !== undefined && signal !== null && signal !== 0
        ? `signal=${signal}`
        : `exit=${exitCode ?? 0}`;
    opts.emit({
      sessionId,
      agentId: opts.adapterId,
      kind: 'session-end',
      payload: { reason },
      ts: Date.now(),
      source: 'sdk',
    });
    state.idleDetector.dispose();
    void state.fileWatcher.close();
    if (state.killTimer) {
      clearTimeout(state.killTimer);
      state.killTimer = null;
    }
    sessions.delete(sessionId);
  };
}
