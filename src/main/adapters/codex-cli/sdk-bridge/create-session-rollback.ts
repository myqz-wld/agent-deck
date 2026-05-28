/**
 * createSession 早期失败 cleanup helper（REVIEW_60 R4 §B 抽法 #3 / file-size-guardrail.md SOP §档 2 强）。
 *
 * 抽自 codex-cli/sdk-bridge/index.ts createSession catch block (L774-L813 ~40 LOC),与 REVIEW_60
 * R1 MED-codex-2 修法 (顶层 try/catch 防早期失败泄漏 token / instance) 配对。
 *
 * **触发场景** (createSession 顶层 try 内任一 throw):
 * 1. ensureCodex throw (loadCodexSdk fail / new sdk.Codex throw 等)
 * 2. resumeThread / startThread sync throw (codex SDK 内部参数校验失败 / 拿不到 thread id 等)
 * 3. await thread-loop.runTurnLoop / startNewThreadAndAwaitId 内部 fallback path 已自 cleanup,
 *    本 catch 走 best-effort 重复 cleanup (idempotent) 加固
 *
 * **设计要点**:
 * - 4 资源 best-effort cleanup,每个独立 try/catch warn 不抛 (任一 cleanup 失败仍继续后续 cleanup)
 * - 全部操作 idempotent (mcp-session-token-map.release sid 不在 → silent no-op +
 *   Map.delete / Set.delete 同款),thread-loop earlyErrCb 已 cleanup 的资源重复调用安全
 * - Cleanup 顺序: codexBySession → tokenMap → sessions → sdkClaim (与 closeSession L730-L744
 *   同款模板,REVIEW_60 R3 reviewer-claude PASS 验证「子进程引用 → 鉴权 token → 路由 → manager
 *   claim 顺序 unwire 语义自然」)
 * - 与 claude createSession (sdk-bridge/index.ts:436-453) try/catch 收口模板形成 cross-adapter parity
 *
 * **接口**:
 * - sessionId: codex 端 initialSid = opts.resume ?? randomUUID() (与 sessions.set / codexBySession.set
 *   / mcpSessionTokenMap.allocate 用同一 key,不变量 7)
 * - resumeSessionId: opts.resume (定义时机:caller 侧 createSession opts.resume) — 仅 resume 路径需
 *   清 sdkClaim,spawn 主路径 randomUUID tempKey 不在 sdkClaim 集合
 * - deps: 4 个 cleanup 操作的注入点 (test seam 让单测 mock 覆盖)
 *
 * **测试 seam**: deps 字段 inject mock,跟踪每个 cleanup call site 是否被调 + idempotent 行为
 */
import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import { sessionManager } from '@main/session/manager';
import type { Codex } from '@openai/codex-sdk';
import type { InternalSession } from './types';

export interface CreateSessionRollbackDeps {
  /** codex 实例 Map (createSession 内 ensureCodex set 进 Map → 失败时 delete 释放 SDK 子进程引用) */
  codexBySession: Map<string, Codex>;
  /** sessions Map (createSession 主路径在 thread.started 后 set,早期 throw 时可能未 set 或半 set) */
  sessions: Map<string, InternalSession>;
}

export interface RunCreateSessionRollbackArgs {
  /** initialSid = opts.resume ?? randomUUID() (顶层 allocate 用同一 key) */
  sessionId: string;
  /** caller opts.resume (resume 路径有值,spawn 主路径 undefined) */
  resumeSessionId?: string;
  /** test seam:注入 cleanup 操作的目标 Map */
  deps: CreateSessionRollbackDeps;
}

/**
 * 4 资源 best-effort cleanup:codexBySession.delete + mcpSessionTokenMap.release +
 * sessions.delete + (resume 时) sessionManager.releaseSdkClaim。caller 调完后 throw err。
 *
 * 失败兜底:每个 cleanup 独立 try/catch warn 不抛 — 任一失败仍继续后续。
 * Idempotent:重复调用安全 (thread-loop earlyErrCb 可能已 cleanup 部分资源)。
 */
export function runCreateSessionRollback(args: RunCreateSessionRollbackArgs): void {
  const { sessionId, resumeSessionId, deps } = args;

  try {
    deps.codexBySession.delete(sessionId);
  } catch (cleanupErr) {
    console.warn(
      `[codex-bridge] codexBySession.delete failed during createSession early-err cleanup for ${sessionId}:`,
      cleanupErr,
    );
  }
  try {
    mcpSessionTokenMap.release(sessionId);
  } catch (cleanupErr) {
    console.warn(
      `[codex-bridge] mcpSessionTokenMap.release failed during createSession early-err cleanup for ${sessionId}:`,
      cleanupErr,
    );
  }
  try {
    deps.sessions.delete(sessionId);
  } catch (cleanupErr) {
    console.warn(
      `[codex-bridge] sessions.delete failed during createSession early-err cleanup for ${sessionId}:`,
      cleanupErr,
    );
  }
  if (resumeSessionId !== undefined) {
    try {
      sessionManager.releaseSdkClaim(resumeSessionId);
    } catch (cleanupErr) {
      console.warn(
        `[codex-bridge] releaseSdkClaim failed during createSession early-err cleanup for ${resumeSessionId}:`,
        cleanupErr,
      );
    }
  }
}
