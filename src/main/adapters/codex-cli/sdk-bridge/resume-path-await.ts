/**
 * Codex resume path bounded startup helper.
 *
 * 抽自 codex-cli/sdk-bridge/index.ts createSession resume path inner Promise (L609-L729 ~120 LOC)。
 * Resume succeeds only after thread.started identifies the accepted native thread. A deadline or
 * early startup error aborts the live turn, disposes the app-server client, clears all provisional
 * ownership, emits one failed terminal, and rejects with an actionable retry error. It never
 * returns an application sid while the startup loop is still blocked.
 *
 * **REVIEW_60 R1 MED-codex-2 修法 + R3 reviewer-claude PASS 验证**:earlyErrCb cleanup 必须
 * 同步清 4 资源 (sessions / sdkClaim / codexBySession / mcpSessionTokenMap),漏清两个 Map →
 * recoverer 重试 createSession 顶部 allocate 走 re-allocate 路径,ensureCodex 命中 codexBySession.get
 * cache 返 leaked Codex-A (env frozen tokenA),resumeThread 在 Codex-A spawn 子进程读 frozen
 * tokenA → HookServer.checkMcpAuth 反查 tokenA = null + 全局 token mismatch → 401,codex teammate
 * mcp send_message 全失败。本 helper 保持原 inline cleanup 行为字面等价。
 *
 * **设计要点**:
 * - resolved 标志 + clearTimeout pattern 保多态互斥不重复 resolve / reject
 * - deps 收敛到 ~8 个 (threadLoop / sessions / codexBySession / emit + helper closure):
 *   AGENT_ID / THREAD_STARTED_FALLBACK_MS 引为常量
 * - earlyErrCb 4 资源 cleanup 内联 (与 REVIEW_60 R3 reviewer-claude PASS「三层 cleanup idempotent
 *   设计强项」一致,不下沉到 runCreateSessionRollback 避免 deps Map 多重引用风险)
 *
 * **接口契约**:
 * - 入参:applicationSid (= opts.resume) / internal / deps
 * - 返回:Promise<string> (resumedId,outer 当前不消费但保留与原 inline 行为对偶 + future-proof)
 * - 副作用:emit session events (finished / message / info / error) + cleanup 4 资源 (earlyErr 路径)
 *
 * **测试 seam**:deps 全部注入,test 可 mock threadLoop.runTurnLoop + emit + 4 资源 Map 验 cleanup 调用
 */
import type { AgentEvent } from '@shared/types';
import type { CodexAppServerClient } from '../app-server/client';
import { AGENT_ID, THREAD_STARTED_FALLBACK_MS } from './constants';
import type { ThreadLoop } from './thread-loop';
import type { InternalSession } from './types';
import { safeDiagnostic, safeErrorSummary } from '@main/utils/safe-diagnostic';

import type { CodexBridgeRuntimeHost } from './runtime-host-core';

export interface AwaitResumedThreadStartDeps {
  threadLoop: ThreadLoop;
  /** sessions Map (earlyErrCb 失败路径 cleanup) */
  sessions: Map<string, InternalSession>;
  /** codex 实例 Map (earlyErrCb 失败路径 cleanup) */
  codexBySession: Map<string, CodexAppServerClient>;
  /** outer createSession 注入的 SdkBridgeOptions.emit (event-bus 派发) */
  emit: (event: AgentEvent) => void;
  runtimeHost: CodexBridgeRuntimeHost;
}

export interface AwaitResumedThreadStartArgs {
  /** applicationSid = opts.resume (resume 路径已知 thread id 维度,与 sessions.set key 一致) */
  applicationSid: string;
  /** outer createSession 构造的 InternalSession (runTurnLoop 入参) */
  internal: InternalSession;
  deps: AwaitResumedThreadStartDeps;
}

/**
 * Resume path inner Promise 三态状态机 — 等 thread.started OR earlyErr OR 30s timeout 三选一。
 *
 * 返回 resumedId (现 outer caller 不消费,但保留与原 inline 行为对偶 + future-proof 防 SDK 升级/CLI 行为变更)。
 *
 * 失败路径 (earlyErrCb) 通过 reject 抛 Error 给 outer caller catch (typical:createSession 顶层 try/catch
 * runCreateSessionRollback 同款 4 资源重复 cleanup,best-effort idempotent 安全)。
 */
export async function awaitResumedThreadStart(args: AwaitResumedThreadStartArgs): Promise<string> {
  const { applicationSid, internal, deps } = args;

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      internal.intentionallyClosed = true;
      internal.pendingMessages.length = 0;
      try {
        internal.currentTurn?.abort();
      } catch {
        // The client disposal below remains authoritative.
      }
      deps.sessions.delete(applicationSid);
      try {
        deps.runtimeHost.sessions.releaseSdkClaim(applicationSid);
      } catch (cleanupErr) {
        deps.runtimeHost.logger('codex-resume-await').warn(
          '[codex-bridge] SDK claim release failed during resume cleanup',
          safeErrorSummary(cleanupErr),
        );
      }
      const client = deps.codexBySession.get(applicationSid);
      deps.codexBySession.delete(applicationSid);
      try {
        client?.dispose();
      } catch (cleanupErr) {
        deps.runtimeHost.logger('codex-resume-await').warn(
          '[codex-bridge] client retirement failed during resume cleanup',
          safeDiagnostic({
            event: 'codex_resume_cleanup',
            phase: 'client_retirement',
            outcome: 'failed',
            sessionShort: applicationSid.slice(0, 12),
            error: safeErrorSummary(cleanupErr),
          }),
        );
      }
      try {
        deps.runtimeHost.tokens.release(applicationSid);
      } catch (cleanupErr) {
        deps.runtimeHost.logger('codex-resume-await').warn(
          '[codex-bridge] MCP token release failed during resume cleanup',
          safeDiagnostic({
            event: 'codex_resume_cleanup',
            phase: 'mcp_token_release',
            outcome: 'failed',
            sessionShort: applicationSid.slice(0, 12),
            error: safeErrorSummary(cleanupErr),
          }),
        );
      }
    };
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(fallback);
      cleanup();
      try {
        deps.emit({
          sessionId: applicationSid,
          agentId: AGENT_ID,
          kind: 'finished',
          payload: { ok: false, subtype: 'error' },
          ts: Date.now(),
          source: 'sdk',
        });
      } catch (emitError) {
        deps.runtimeHost.logger('codex-resume-await').warn(
          '[codex-bridge] failed to emit resume failure terminal',
          safeErrorSummary(emitError),
        );
      }
      reject(new Error(message));
    };
    const fallback = setTimeout(() => {
      deps.runtimeHost.logger('codex-resume-await').warn(
        '[codex-bridge] resume readiness timed out; retiring blocked runtime',
        safeDiagnostic({
          event: 'codex_resume_readiness',
          phase: 'thread.started',
          outcome: 'timeout_retired',
          sessionShort: applicationSid.slice(0, 12),
          timeoutMs: THREAD_STARTED_FALLBACK_MS,
        }),
      );
      try {
        deps.emit({
          sessionId: applicationSid,
          agentId: AGENT_ID,
          kind: 'message',
          payload: {
            text:
              '⚠ Codex 30 秒内未发出 thread.started 事件。阻塞的运行时已清理；' +
              '请重试，若仍失败请检查 `codex auth` 和 Codex 二进制路径。',
            error: true,
          },
          ts: Date.now(),
          source: 'sdk',
        });
      } catch (emitError) {
        deps.runtimeHost.logger('codex-resume-await').warn(
          '[codex-bridge] failed to emit resume timeout detail',
          safeErrorSummary(emitError),
        );
      }
      fail(
        `Codex resume ${applicationSid} timed out waiting for thread.started; ` +
          'the blocked runtime was retired and the operation can be retried',
      );
    }, THREAD_STARTED_FALLBACK_MS);

    void deps.threadLoop.runTurnLoop(
      internal,
      applicationSid,
      (realId) => {
        if (settled) return;
        settled = true;
        clearTimeout(fallback);
        // realId 可能 = applicationSid (common case) 或新 id (thread-loop 已 rename Map key + 调
        // renameSdkSession + update internal.threadId,outer 仅取最终 id 即可)
        resolve(realId);
      },
      (earlyErr) => {
        fail(`Codex resume early error: ${earlyErr}; runtime retired, retry is safe`);
      },
    ).catch((loopError) => {
      fail(
        `Codex resume loop failed before thread.started: ` +
          `${loopError instanceof Error ? loopError.message : String(loopError)}; ` +
          'runtime retired, retry is safe',
      );
    });
  });
}
