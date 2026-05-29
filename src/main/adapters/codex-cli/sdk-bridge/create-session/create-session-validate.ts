/**
 * Phase 4 Step 4.3 create-session validate phase — prompt 校验 + sid/token allocate。
 *
 * **执行位置**：orchestrator try block **之前**(同步)。validate throw 时:
 * - prompt empty: 调用方未传 / 空白串 → 立即 throw
 * - prompt 超 MAX_MESSAGE_LENGTH: 长度 cap (REVIEW_4 M4 / REVIEW_24 HIGH-2 follow-up,
 *   与 messageRepo cap 全局对齐)
 *
 * 两种 throw 都在 token allocate 之前 → no rollback needed (validate 子段不入 try block)。
 *
 * **sid 分配语义**（plan codex-handoff-team-alignment-20260518 P2 Step 2.5c sid 时序，v4 H2）:
 * - resume 路径: initialSid = opts.resume (已知 thread id)
 * - 新建路径: initialSid = randomUUID 即 tempKey,等 thread.started 拿到 realId 后由
 *   `sessionManager.renameSdkSession` 函数体(Step 2.8)统一 rename `codexBySession` Map +
 *   token map (不变量 7)
 *
 * sid 先确定再 allocate token 让子进程 envOverride 拿到 per-session token,后续 codex CLI MCP
 * client 调 /mcp 时 HookServer.checkMcpAuth 反查 mcpSessionTokenMap.get(token) 才能命中拿到
 * 真正 caller sid。
 */
import { randomUUID } from 'node:crypto';
import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import { MAX_MESSAGE_LENGTH } from '../constants';
import type { CreateSessionOpts, ValidateResult } from './_deps';

export function validateCreateSessionOpts(opts: CreateSessionOpts): ValidateResult {
  if (!opts.prompt || !opts.prompt.trim()) {
    throw new Error('首条消息不能为空：codex SDK 需要至少一条 prompt 才能启动 turn');
  }
  // REVIEW_4 M4：首条 prompt 也走 MAX_MESSAGE_LENGTH 上限。原版只 sendMessage 校验，
  // pendingMessages: [opts.prompt] 直接进队列，让 cli.ts / 其他入口可绕过 cap。
  // attachments 不算 text length（IPC 层 30MB 总附件独立校验）
  // REVIEW_24 HIGH-2 follow-up：byteLength → length 与 messageRepo cap 全局对齐
  const promptLen = opts.prompt.length;
  if (promptLen > MAX_MESSAGE_LENGTH) {
    throw new Error(
      `首条 prompt 超出 ${MAX_MESSAGE_LENGTH.toLocaleString()} 字符上限（实际 ${promptLen.toLocaleString()} 字符）`,
    );
  }

  // plan codex-handoff-team-alignment-20260518 P2 Step 2.5c sid 时序(v4 H2 关键修法):
  // 必须先确定 sessionId 再 allocate token 起 Codex 子进程,这样子进程 envOverride 拿到
  // per-session token,后续 codex CLI MCP client 调 /mcp 时 HookServer.checkMcpAuth 反查
  // mcpSessionTokenMap.get(token) 才能命中拿到真正 caller sid。
  //
  // - resume 路径:initialSid = opts.resume(已知 thread id)
  // - 新建路径:initialSid = 提前生成的 tempKey,用作 codex 实例 + sessions Map key,等
  //   threadLoop.startNewThreadAndAwaitId 拿到 realId 后通过 sessionManager.renameSdkSession
  //   函数体(Step 2.8)统一 rename codexBySession Map + token map(不变量 7)
  const initialSid = opts.resume ?? randomUUID();
  const sessionToken = mcpSessionTokenMap.allocate(initialSid);

  return { initialSid, sessionToken };
}
