/**
 * Codex resume path inner Promise 编排 helper（REVIEW_60 R4 §B 抽法 #1 / file-size-guardrail.md SOP §档 2 强）。
 *
 * 抽自 codex-cli/sdk-bridge/index.ts createSession resume path inner Promise (L609-L729 ~120 LOC)。
 * resume 路径 thread.started 等待 + earlyErr cleanup + 30s timeout fallback 三态状态机。
 *
 * **三态路径**:
 * 1. **onFirstId triggered** (thread.started 在 30s 内到):resolve(realId) → outer createSession 继续
 *    走 persistSessionFields + return handle
 * 2. **earlyErrCb 30s 内 triggered** (resolved=false 路径):cleanup 4 资源 + emit finished →
 *    reject 让 outer caller catch 触发上下文相关错误处理 / DB rollback
 * 3. **earlyErrCb 30s 后 triggered** (resolved=true 路径,late earlyErr after timeout):cleanup 4 资源 +
 *    emit finished + emit error message → 不 reject(outer 已 resolve),补 emit 让用户在 SessionDetail 看到
 * 4. **30s timeout fallback** (resolved=false 路径):console.warn + emit info message →
 *    resolve(opts.resume) 假定 SDK 慢但能起,与新路径 resolveWithFallback 不同 (resume 已 emit
 *    session-start + user msg 不应武断标 finished:error)
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
import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import { sessionManager } from '@main/session/manager';
import type { Codex } from '@openai/codex-sdk';
import type { AgentEvent } from '@shared/types';
import { AGENT_ID, THREAD_STARTED_FALLBACK_MS } from './constants';
import type { ThreadLoop } from './thread-loop';
import type { InternalSession } from './types';
import log from '@main/utils/logger';

const logger = log.scope('codex-resume-await');

export interface AwaitResumedThreadStartDeps {
  threadLoop: ThreadLoop;
  /** sessions Map (earlyErrCb 失败路径 cleanup) */
  sessions: Map<string, InternalSession>;
  /** codex 实例 Map (earlyErrCb 失败路径 cleanup) */
  codexBySession: Map<string, Codex>;
  /** outer createSession 注入的 SdkBridgeOptions.emit (event-bus 派发) */
  emit: (event: AgentEvent) => void;
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
    let resolved = false;
    const fallback = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      logger.warn(
        `[codex-bridge] resume ${applicationSid} no thread.started in ${THREAD_STARTED_FALLBACK_MS}ms, ` +
          `returning original id (turn loop may still recover)`,
      );
      // symmetry-plan P3 R2-3 (reviewer-claude LOW-B):补 emit info message 让用户在
      // SessionDetail 知道 30s 没拿到 thread.started — 不 `error: true`(commit c9c94d7
      // 注释明示 resume 已 emit session-start + user msg 不应武断标 finished:error,
      // 仅 turn loop 慢启动场景信息提示)。修前 silent resolve 用户等 30s 啥反馈没有。
      deps.emit({
        sessionId: applicationSid,
        agentId: AGENT_ID,
        kind: 'message',
        payload: {
          text:
            `⚠ Codex 30 秒内未发出 thread.started 事件,可能 SDK 慢启动 — 后续 turn 可能仍能` +
            `恢复,请等待或检查 codex 鉴权 / 二进制路径(终端 \`codex auth\` 或设置面板「Codex 二进制路径」)。`,
        },
        ts: Date.now(),
        source: 'sdk',
      });
      resolve(applicationSid);
    }, THREAD_STARTED_FALLBACK_MS);

    void deps.threadLoop.runTurnLoop(
      internal,
      applicationSid,
      (realId) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(fallback);
        // realId 可能 = applicationSid (common case) 或新 id (thread-loop 已 rename Map key + 调
        // renameSdkSession + update internal.threadId,outer 仅取最终 id 即可)
        resolve(realId);
      },
      (earlyErr) => {
        // symmetry-plan P3 R3 (reviewer-codex MED):cleanup + emit finished **永远做**(不管
        // resolved 不 resolved),覆盖两条路径:
        // 1. 30s 内 earlyErr (resolved=false):cleanup → emit finished → reject(让 outer caller
        //    catch 触发上下文相关错误处理 / DB rollback)
        // 2. 30s timeout 后 late earlyErr (resolved=true):cleanup → emit finished + emit error
        //    message(outer caller 已 resolve 不会 catch,补 emit error 让用户在 SessionDetail 看到失败)
        //
        // 修前 R2-1 仅修了路径 1,路径 2 (timeout resolve → late earlyErr → `if (resolved) return`
        // 短路) 仍残留 stale internal.thread + 后续 sendMessage `if (!s)` 命中绕过 recoverer。
        //
        // symmetry-plan P3 R2-1 (reviewer-codex HIGH):cleanup 半初始化 sessions Map + sdkClaim,
        // 让后续 sendMessage 走 sessions Map miss → recoverer 自愈正常路径。
        //
        // **P5 Round 1 reviewer-claude+codex 双方独立 HIGH-2 修法**:earlyErrCb cleanup 必须
        // 同步清 codexBySession + mcpSessionTokenMap (旧实现仅清 sessions Map + releaseSdkClaim,
        // 漏清两个 Map → recoverer 重试 createSession({resume}) 顶部 allocate(opts.resume) 走
        // re-allocate 路径,ensureCodex(opts.resume) 命中 codexBySession.get cache 返 leaked Codex-A
        // (env frozen tokenA),resumeThread 在 Codex-A spawn 子进程读 frozen tokenA → 401。
        // closeSession line 730-744 标准 cleanup 模板已含双轨,这里同款。delete / release 失败
        // 仅 console.warn 不阻塞 cleanup 后续 emit。
        deps.sessions.delete(applicationSid);
        sessionManager.releaseSdkClaim(applicationSid);
        try {
          deps.codexBySession.delete(applicationSid);
        } catch (cleanupErr) {
          logger.warn(
            `[codex-bridge] codexBySession.delete failed during earlyErr cleanup for ${applicationSid}:`,
            cleanupErr,
          );
        }
        try {
          mcpSessionTokenMap.release(applicationSid);
        } catch (cleanupErr) {
          logger.warn(
            `[codex-bridge] mcpSessionTokenMap.release failed during earlyErr cleanup for ${applicationSid}:`,
            cleanupErr,
          );
        }
        // resume 路径已 emit session-start + user msg,补 finished 完成 UI 序列。
        deps.emit({
          sessionId: applicationSid,
          agentId: AGENT_ID,
          kind: 'finished',
          payload: { ok: false, subtype: 'error' },
          ts: Date.now(),
          source: 'sdk',
        });

        if (resolved) {
          // 路径 2 (late earlyErr after 30s timeout):outer caller 已 resolve 不会 catch,
          // 补 emit error message 让用户看到失败原因 + 知道下条消息会自愈。
          deps.emit({
            sessionId: applicationSid,
            agentId: AGENT_ID,
            kind: 'message',
            payload: {
              text:
                `⚠ Codex 启动失败 (30s timeout 后 late error):${earlyErr}。` +
                `会话已清理,下条消息将走自愈路径重新尝试 resume。`,
              error: true,
            },
            ts: Date.now(),
            source: 'sdk',
          });
          return;
        }

        // 路径 1 (30s 内 earlyErr):reject 让 outer caller 自己 emit 上下文相关错误消息
        // (避免双错误消息)。
        resolved = true;
        clearTimeout(fallback);
        reject(new Error(`Codex resume early error: ${earlyErr}`));
      },
    );
  });
}
