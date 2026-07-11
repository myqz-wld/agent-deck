/**
 * createSession 早期失败 cleanup helper（REVIEW_60 R4 §B 抽法 #3 / file-size-guardrail.md SOP §档 2 强）。
 *
 * 抽自 codex-cli/sdk-bridge/index.ts createSession catch block (L774-L813 ~40 LOC),与 REVIEW_60
 * R1 MED-codex-2 修法 (顶层 try/catch 防早期失败泄漏 token / instance) 配对。
 *
 * **触发场景** (createSession 顶层 try 内任一 throw):
 * 1. ensureCodex throw (new CodexAppServerClient throw 等)
 * 2. resumeThread / startThread sync throw (Codex app-server 参数校验失败 / 拿不到 thread id 等)
 * 3. await thread-loop.runTurnLoop / startNewThreadAndAwaitId 内部 fallback path 已自 cleanup,
 *    本 catch 走 best-effort 重复 cleanup (idempotent) 加固
 *
 * **设计要点**:
 * - 新建 provisional session 先经 lifecycle SSOT 删除；其余资源 best-effort cleanup，
 *   每个独立 try/catch warn 不抛（任一 cleanup 失败仍继续后续 cleanup）
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
 * - resumeSessionId: opts.resume (定义时机:caller 侧 createSession opts.resume) — 有值表示既有
 *   会话，绝不能删除历史行；无值表示失败的新建 provisional session，可以安全删除
 * - deps: Map cleanup 操作的注入点 (test seam 让单测 mock 覆盖)
 *
 * **测试 seam**: deps 字段 inject mock,跟踪每个 cleanup call site 是否被调 + idempotent 行为
 */
import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import { sessionManager } from '@main/session/manager';
import type { CodexAppServerClient } from '../app-server/client';
import type { InternalSession } from './types';
import log from '@main/utils/logger';

const logger = log.scope('codex-rollback');

export interface CreateSessionRollbackDeps {
  /** codex 实例 Map (createSession 内 ensureCodex set 进 Map → 失败时 delete 释放 SDK 子进程引用) */
  codexBySession: Map<string, CodexAppServerClient>;
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
 * 新建 provisional row 删除 + 4 资源 best-effort cleanup：codexBySession.delete +
 * mcpSessionTokenMap.release + sessions.delete + sessionManager.releaseSdkClaim。
 * caller 调完后继续抛出原始错误。
 *
 * 失败兜底:每个 cleanup 独立 try/catch warn 不抛 — 任一失败仍继续后续。
 * Idempotent:重复调用安全 (thread-loop earlyErrCb 可能已 cleanup 部分资源)。
 */
export async function runCreateSessionRollback(args: RunCreateSessionRollbackArgs): Promise<void> {
  const { sessionId, resumeSessionId, deps } = args;

  // Programmatic new-session creation may already have emitted a provisional row before the
  // provider reports its canonical id. Remove that row through the lifecycle SSOT so renderer
  // state, cascaded events, adapter state, and the late-event blacklist stay aligned. Never delete
  // a resume target: it is pre-existing user history rather than a failed provisional session.
  if (resumeSessionId === undefined) {
    try {
      await sessionManager.delete(sessionId);
    } catch (cleanupErr) {
      logger.warn(
        `[codex-bridge] sessionManager.delete failed during createSession rollback for ${sessionId}:`,
        cleanupErr,
      );
    }
  }

  try {
    deps.codexBySession.get(sessionId)?.dispose();
    deps.codexBySession.delete(sessionId);
  } catch (cleanupErr) {
    logger.warn(
      `[codex-bridge] codexBySession.delete failed during createSession early-err cleanup for ${sessionId}:`,
      cleanupErr,
    );
  }
  try {
    mcpSessionTokenMap.release(sessionId);
  } catch (cleanupErr) {
    logger.warn(
      `[codex-bridge] mcpSessionTokenMap.release failed during createSession early-err cleanup for ${sessionId}:`,
      cleanupErr,
    );
  }
  try {
    deps.sessions.delete(sessionId);
  } catch (cleanupErr) {
    logger.warn(
      `[codex-bridge] sessions.delete failed during createSession early-err cleanup for ${sessionId}:`,
      cleanupErr,
    );
  }
  try {
    sessionManager.releaseSdkClaim(sessionId);
  } catch (cleanupErr) {
    logger.warn(
      `[codex-bridge] releaseSdkClaim failed during createSession early-err cleanup for ${sessionId}:`,
      cleanupErr,
    );
  }
}
