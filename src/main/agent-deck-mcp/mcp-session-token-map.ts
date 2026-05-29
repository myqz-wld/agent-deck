/**
 * Per-session MCP Bearer token ↔ sessionId 双向 map（plan codex-handoff-team-alignment-20260518
 * P2 Step 2.1 / D1 ADR）。
 *
 * 解决问题（HIGH-1）：codex teammate session 通过 HTTP MCP transport 调 agent-deck tool
 * 时，应用层需要从 Bearer token 反查出真正的 callerSessionId（而不是依赖 codex agent
 * 在 args 里自己填，prompt 注入风险）。每个 codex live session 对应一个独立 token，
 * 主进程在 spawn 时 allocate(sid) 拿到 token → 注入 codex 子进程 envOverride
 * `{AGENT_DECK_MCP_TOKEN: <session-token>}` → codex CLI MCP client 读 env 拼 Authorization
 * header → HookServer.onRequest /mcp 分支拿到 token → mcpSessionTokenMap.get(token) 反查
 * sid → extra.authInfo.resolvedSid 注入 → tool handler 内 callerSessionIdOverride 命中。
 *
 * Global fallback token（process.env.AGENT_DECK_MCP_TOKEN，main bootstrap 一次性设全局
 * token）仍保留（D1 §(b)）：
 * - 外部 codex CLI / 非应用 spawn 路径走全局 token 调 MCP → tokenToSession.get 不命中 →
 *   HookServer 比对 mcpServerToken 全局 token → 命中返 resolvedSid=null + fallbackToGlobal=
 *   true → handler 视为 external caller（EXTERNAL_CALLER_ALLOWED 表，spawn/send/shutdown/
 *   archive_plan/hand_off_session/enter_worktree/exit_worktree 全 deny；list/get 允许）
 * - 这保证「external codex CLI 走全局 token 调用 MCP 时只能读不能写」与 stdio external
 *   caller 行为对齐
 *
 * 不变量 7（plan §不变量 7）：rename 必须由 `sessionManager.renameSdkSession` 函数体内
 * 统一调用（与 sdkOwned 转移同款保证），不能让 caller（codex bridge thread-loop.ts CLI 隐式
 * fork 路径 / claude SDK fallback tempKey→realId 路径）各自调，避免漏调导致 token →
 * stale sid。
 */

import { randomUUID } from 'node:crypto';

/**
 * sid → token（一对一）。检查「该 sid 是否已有 token」用此 map；release 时同步清。
 */
const sessionToToken: Map<string, string> = new Map();

/**
 * token → sid（一对一）。HookServer.onRequest /mcp 分支反查时用此 map；release 时同步清。
 */
const tokenToSession: Map<string, string> = new Map();

/**
 * 给指定 session 分配一个 Bearer token，返回 token 字符串。
 *
 * **v4 M2 修法 — 防 re-allocate 同 sid 时旧 entry 残留**：
 * 同一 sid 可能因为 createSession failure 重试、ensureCodex 重新 new Codex 等路径再次
 * 调 allocate。直接覆盖 sessionToToken 会让旧 token 在 tokenToSession 里成「孤儿 entry」
 * （指向已废弃的 sid），导致旧 token 仍能被反查到 sid → 安全风险 + 内存泄漏。所以先把
 * 旧 token 的 tokenToSession entry 清掉再插新双向 map。
 *
 * @param sessionId 需要分配 token 的 session id（codex live session）
 * @returns 新 Bearer token（randomUUID v4 lowercase hex）
 */
export function allocate(sessionId: string): string {
  // 防 re-allocate 同 sid 残留：先清旧反向 entry
  const oldToken = sessionToToken.get(sessionId);
  if (oldToken !== undefined) {
    tokenToSession.delete(oldToken);
  }

  const token = randomUUID();
  sessionToToken.set(sessionId, token);
  tokenToSession.set(token, sessionId);
  return token;
}

/**
 * 从 Bearer token 反查 sessionId（HookServer.onRequest /mcp 分支用）。
 *
 * @param token 来自 HTTP Authorization Bearer 头的 token
 * @returns 命中 → sessionId；不命中 → null（caller 应继续比对全局 mcpServerToken）
 */
export function get(token: string): string | null {
  return tokenToSession.get(token) ?? null;
}

/**
 * 原子迁移：把 oldSid 名下的 token 改挂到 newSid 名下，token 字符串本身不变。
 *
 * 触发场景：
 * - codex thread-loop.ts CLI 隐式 fork：first event 拿到 realSid 与 startThread 时用的
 *   tempSid/oldSid 不一致 → sessionManager.renameSdkSession(oldSid, newSid) 内部调 rename
 * - claude SDK fallback：tempKey → realId rename 同款（claude 走 in-process MCP transport
 *   不用 token map，但保持函数行为一致）
 *
 * **不变量 7**：本函数必须由 `sessionManager.renameSdkSession` 函数体内统一调用，禁止
 * caller 自己散调（漏调风险）。
 *
 * 边角处理：
 * - oldSid 不在 map（如 claude adapter 路径根本没 allocate）→ 静默 no-op，不抛错
 * - newSid 已经在 map（理论上不应发生：rename 前 newSid 是新 thread id 还没 allocate）→
 *   仍 no-op，让 caller 自己感知（不在本层 throw 防破坏 renameSdkSession 主流程）
 *
 * @param oldSid 原 sessionId
 * @param newSid 新 sessionId
 */
export function rename(oldSid: string, newSid: string): void {
  const token = sessionToToken.get(oldSid);
  if (token === undefined) {
    return;
  }
  // newSid 已经在 map：rename 不应覆盖现有 entry，直接退出（caller 责任）
  if (sessionToToken.has(newSid)) {
    return;
  }
  sessionToToken.delete(oldSid);
  sessionToToken.set(newSid, token);
  tokenToSession.set(token, newSid);
}

/**
 * 释放指定 session 的 token：清双向 map 双 entry。
 *
 * 触发场景：
 * - sessionManager.close(sid) 函数体内统一调（plan P2 Step 2.9）
 * - codexCliBridge.closeSession 内 sub-step 2.5d 同步调
 *
 * 边角处理：sid 不在 map（如 claude adapter / 已 release）→ 静默 no-op。
 *
 * @param sessionId 要释放的 sessionId
 */
export function release(sessionId: string): void {
  const token = sessionToToken.get(sessionId);
  if (token === undefined) {
    return;
  }
  sessionToToken.delete(sessionId);
  tokenToSession.delete(token);
}

/**
 * 清空双向 map（仅测试 helper，禁止生产路径调用）。
 *
 * 用途：vitest 单测在 beforeEach 复位 module-level state，避免 case 间污染。
 */
export function clearAll(): void {
  sessionToToken.clear();
  tokenToSession.clear();
}
