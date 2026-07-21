import { sessionManager } from '@main/session/manager';
import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
// CHANGELOG_52 Step 4a-4c：拆 class 完成。本目录（sdk-bridge/）含 4 sub-module + index.ts (facade)。
//
// **TS module resolution 假设**（与 claude sdk-bridge 同款）：moduleResolution: node
// 模式下 `import './sdk-bridge'` 优先匹配 `sdk-bridge.ts` 文件（不存在时才走 `sdk-bridge/index.ts`）。
// Step 4c 删了原 `sdk-bridge.ts` 文件，import 自动切到本 index.ts；外部 import 站点
// （`@main/adapters/codex-cli/sdk-bridge`）零变更继续工作。
//
// R37 P2-E Step 3.4a：抽 input-pack.ts (packCodexInput + extractAttachmentPaths 模块级纯函数)。
// R37 P2-E Step 3.4b：抽 session-finalize.ts (persistSessionFields 收口 setCodexSandbox + setModel + warn)。
// R37 P2-E Step 3.4c：抽 restart-controller.ts (RestartController sub-class 持 sandbox switch method)。
import { AGENT_ID } from './constants';
import type {
  CodexBridgeOptions,
  CodexSessionHandle,
  InternalSession,
} from './types';
import type { ForkedSessionHandle, ForkSessionSource } from '../../types/fork-session';
import { ThreadLoop, type ThreadLoopCtx } from './thread-loop';
import { RestartController, type RestartCtx } from './restart-controller';
import { SessionModelController } from '@main/adapters/session-model-controller';
import type { SessionModelOptions } from '@main/adapters/session-model-options';
import type { AgentEnqueueOptions, PendingAgentMessage, QueuedAgentMessage } from '@main/adapters/types';
import type { ProviderUsageSnapshot, UploadedAttachmentRef } from '@shared/types';
import {
  SessionRecoverer,
  defaultCodexResumeJsonlExists,
  defaultCwdExists,
} from './recoverer';
// Phase 4 Step 4.3: createSession 主体抽到 create-session/ 子目录(facade pattern + 3 子段)。
// facade.createSession 改为 thin delegate 调 createSessionImpl orchestrator → validate / resume / new
// 3 子段 fn(详 create-session/_deps.ts 顶部 jsdoc 拆分说明)。
import { createSessionImpl } from './create-session/create-session-impl';
import type { CreateSessionOpts } from './create-session/_deps';
import { createCodexForkedSession } from './fork-session/create-forked-session';
import type { CodexAppServerClient } from '../app-server/client';
import {
  ensureCodexClient,
  getCodexUsageSnapshot,
  invalidateCodexClientsForPathChange,
  renameCodexClient,
} from './client-registry';
import { MessageController } from './message-controller';
import log from '@main/utils/logger';
import {
  captureRecoveryContinuation,
  cleanupRecoveryContinuation,
  prepareRecoveryContinuation,
  type CapturedRecoveryContinuation,
  type PreparedRecoveryContinuation,
  type RecoveryRuntimeOverrides,
} from '@main/session/continuation-context/recovery';
import type { SessionRecord } from '@shared/types';
import {
  armCodexSessionRetirement,
  finalizeCodexSessionRetirement,
} from './session-retirement';

const logger = log.scope('codex-bridge');

export type { CodexSessionHandle, CodexBridgeOptions } from './types';

/**
 * Codex SDK 通道实现。与 claude-code/sdk-bridge.ts 同形态但显著简化：
 *
 * - 无 canUseTool / AskUserQuestion / ExitPlanMode（codex SDK 不支持，capabilities 已 false）
 * - 无 setPermissionMode（同上）
 * - 无 hook 通道时序竞争（codex 无 hook），不调 sessionManager.expectSdkSession
 * - 同一 thread 不能并发 turn（codex CLI 共享 ~/.codex/sessions 文件），用 pendingMessages 串行
 * - interrupt = AbortController.abort() → SIGTERM 子进程；下条消息可继续同 thread
 */
export class CodexSdkBridge {
  /** key = 真实 thread_id（拿到前用 tempKey） */
  private sessions = new Map<string, InternalSession>();
  /**
   * Per-session Codex SDK 实例（plan codex-handoff-team-alignment-20260518 P2 Step 2.5a 字段重组）。
   *
   * 修前 single `private codex: Codex | null` 给所有 codex teammate 共享，子进程 envOverride
   * 复用同一份全局 token，应用层无法区分「这条 MCP 请求来自哪个 codex teammate」（HIGH-1
   * caller_session_id 透传困境）。
   *
   * 修后 per-session Map：每个 codex live session 独立 new Codex({env: {...process.env,
   * AGENT_DECK_MCP_TOKEN: <session-token>}})，token 由 mcpSessionTokenMap.allocate 在
   * createSession 起始时分配（Step 2.5c sid 时序），子进程通过 envOverride 拿到自己的 token，
   * agent-deck MCP server `/mcp` 路由 `request.raw.auth` 反查 token map 得到真正 caller sid。
   *
   * Sub-step 2.5d closeSession 同步 delete entry + release token；Sub-step 2.5e
   * setCodexCliPath 路径变更时 clear 整 Map（已 spawn 的 codex 子进程不受影响 —
   * spike 2 §1 实证 envOverride 已 frozen 拷贝到子进程 env）。
   *
   * `codex-instance-pool.ts` 仅服务周期总结 oneshot caller，
   * 不需要 per-session token，沿用全局 process.env 路径，与本 Map 双轨独立维护（plan §M5）。
   */
  private codexBySession: Map<string, CodexAppServerClient> = new Map();
  /**
   * 与 claude `recovering` Map 同模式的单飞表。Codex sandbox 切换已不再冷重启，
   * 但仍与 recoverer 共享这张表，避免同 session 的 recover/create 与 sandbox DB/live-option
   * patch 交错。
   */
  private recovering = new Map<string, Promise<unknown>>();
  /**
   * CHANGELOG_52 Step 4b：ThreadLoop sub-class 持 startNewThreadAndAwaitId + runTurnLoop。
   * sessions Map / emit 通过 ThreadLoopCtx 注入；class 上 createSession / sendMessage 内的
   * 调用走 this.threadLoop.xxx 委托。
   */
  private threadLoop: ThreadLoop;
  /**
   * R37 P2-E Step 3.4c：RestartController sub-class 持 restartWithCodexSandbox method。
   * public 名称保留兼容旧 IPC；当前实现只持久化 + patch live app-server thread options，
   * 不再 close/create Codex thread。
   */
  private restartController: RestartController;
  private sessionModelController: SessionModelController;
  private messageController: MessageController;

  /**
   * symmetry-plan P2 HIGH-B：SessionRecoverer 持 recoverAndSend 主体。
   *
   * ctx 与 RestartController 共享 facade.recovering Map（HIGH-A 已建权威 ref）。
   * thunk 反调 facade.createSession / sendMessage / cwdExists / resumeJsonlExists（test
   * 通过 facade extend override 让单测不依赖真 fs / 真 LLM）。与 claude SessionRecoverer 同模式。
   */
  private recoverer: SessionRecoverer;

  constructor(private opts: CodexBridgeOptions) {
    const ctx: ThreadLoopCtx = {
      sessions: this.sessions,
      emit: opts.emit,
      // P5 Round 1 reviewer-claude MED-1 修法 (resolveWithFallback 漏清 codexBySession + token map):
      // facade 注入 thunk 让 thread-loop 不直接 import codexBySession / mcp-session-token-map 模块。
      // 失败 swallow — fallback 路径已经在错误状态下,cleanup 失败不应再 throw 阻塞 emit 序列(thread-loop
      // resolveWithFallback 内已 catch 本 thunk 的 throw 但仍兜底)。
      cleanupTempKey: (tempKey: string) => {
        try {
          this.codexBySession.get(tempKey)?.dispose();
          this.codexBySession.delete(tempKey);
        } catch (cleanupErr) {
          logger.warn(
            `[codex-bridge] codexBySession.delete failed in cleanupTempKey for ${tempKey}:`,
            cleanupErr,
          );
        }
        try {
          mcpSessionTokenMap.release(tempKey);
        } catch (cleanupErr) {
          logger.warn(
            `[codex-bridge] mcpSessionTokenMap.release failed in cleanupTempKey for ${tempKey}:`,
            cleanupErr,
          );
        }
      },
      finalizeRetirement: (internal) => this.finalizeSessionRetirement(internal),
    };
    this.threadLoop = new ThreadLoop(ctx);
    const restartCtx: RestartCtx = {
      recovering: this.recovering,
      emit: opts.emit,
      applyLiveSandbox: (sessionId, sandbox, sandboxOpts) => {
        const internal = this.sessions.get(sessionId);
        if (!internal) return false;
        internal.thread.updateSandboxMode(sandbox, sandboxOpts);
        return true;
      },
    };
    this.restartController = new RestartController(restartCtx);
    this.sessionModelController = new SessionModelController({
      operations: this.recovering,
      agentId: AGENT_ID,
      emit: opts.emit,
      applyLive: async (sessionId, options) => {
        const internal = this.sessions.get(sessionId);
        if (!internal) return false;
        await internal.thread.updateModelOptions(
          options.model,
          options.thinking as CreateSessionOpts['modelReasoningEffort'] | null,
        );
        return true;
      },
    });

    // symmetry-plan P2 HIGH-B：SessionRecoverer 装配（与 claude facade 同款 thunk 注入模式）。
    // arrow 闭包 this，运行时晚解析 → this.createSession 一定已绑定。
    // attachments 透传 sendMessage 第三参（与 claude HIGH-1 同款 — 避免 inflight 第二条等待者丢图）。
    this.recoverer = new SessionRecoverer(
      { recovering: this.recovering, emit: opts.emit },
      (createOpts) => this.createSession(createOpts),
      (sid, text, attachments) => this.sendMessage(sid, text, attachments),
      (threadId, startedAt) => this.codexResumeJsonlExists(threadId, startedAt),
      (cwd) => this.cwdExists(cwd),
      (session, overrides) => this.captureRecoveryContext(session, overrides),
      (capture, instruction) => this.prepareRecoveryContext(capture, instruction),
      (capture) => this.cleanupRecoveryContext(capture),
    );
    this.messageController = new MessageController({
      sessions: this.sessions,
      emit: opts.emit,
      recoverAndSend: (sessionId, text, attachments, options) =>
        this.recoverer.recoverAndSend(sessionId, text, attachments, options),
      runTurnLoop: (session, sessionId) => this.threadLoop.runTurnLoop(session, sessionId),
    });
  }

  setCodexCliPath(_path: string | null): void {
    invalidateCodexClientsForPathChange(this.codexBySession, this.sessions);
  }

  async getUsageSnapshot(): Promise<ProviderUsageSnapshot> {
    return getCodexUsageSnapshot(this.codexBySession);
  }

  private async ensureCodex(
    sessionId: string,
    sessionToken: string,
    envOverrideExtra?: Readonly<Record<string, string>>,
  ): Promise<CodexAppServerClient> {
    return ensureCodexClient({
      clients: this.codexBySession,
      sessionId,
      sessionToken,
      hookServer: this.opts.hookServer,
      envOverrideExtra,
    });
  }

  renameCodexInstance(oldId: string, newId: string): void {
    renameCodexClient(this.codexBySession, oldId, newId);
  }

  async createSession(opts: CreateSessionOpts): Promise<CodexSessionHandle> {
    // Phase 4 Step 4.3 — facade thin delegate (详 create-session/_deps.ts §拆分布局)。
    // 字段 jsdoc SSOT 在 CreateSessionOpts interface(create-session/_deps.ts);
    // method 主体抽到 createSessionImpl orchestrator → validate / resume / new 3 子段。
    return createSessionImpl(opts, {
      sessions: this.sessions,
      codexBySession: this.codexBySession,
      threadLoop: this.threadLoop,
      emit: this.opts.emit,
      // arrow 闭包 facade `this`,运行时晚解析 → this.ensureCodex 一定已绑定
      ensureCodex: (sid, token, extra) => this.ensureCodex(sid, token, extra),
    });
  }

  validateForkSession(source: ForkSessionSource): void {
    const sourceClient = this.codexBySession.get(source.applicationSessionId);
    const sourceInternal = this.sessions.get(source.applicationSessionId);
    if (
      !sourceClient ||
      !sourceClient.isProcessAlive ||
      !sourceInternal ||
      sourceInternal.threadId !== source.nativeSessionId
    ) {
      throw new Error(
        'Codex native fork requires caller-owned live app-server state matching the caller native thread. Retry while the caller turn is active or use contextMode "fresh".',
      );
    }
  }

  createForkedSession(
    source: ForkSessionSource,
    target: CreateSessionOpts,
  ): Promise<ForkedSessionHandle> {
    return createCodexForkedSession(source, target, {
      sessions: this.sessions,
      codexBySession: this.codexBySession,
      threadLoop: this.threadLoop,
      emit: this.opts.emit,
      ensureCodex: (sid, token, extra) => this.ensureCodex(sid, token, extra),
      lifecycle: {
        allocateToken: (sid) => mcpSessionTokenMap.allocate(sid),
        resolveToken: (token) => mcpSessionTokenMap.get(token),
        releaseToken: (sid) => mcpSessionTokenMap.release(sid),
        claimSession: (sid) => sessionManager.claimAsSdk(sid),
        releaseClaim: (sid) => sessionManager.releaseSdkClaim(sid),
        hasClaim: (sid) => sessionManager.hasSdkClaim(sid),
        renameSession: (from, to) => sessionManager.renameSdkSession(from, to),
        deleteSession: (sid) => sessionManager.delete(sid),
      },
    });
  }

  async sendMessage(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: AgentEnqueueOptions,
  ): Promise<void> {
    await this.messageController.sendMessage(sessionId, text, attachments, options);
  }

  async enqueueMessage(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: AgentEnqueueOptions,
  ): Promise<void> {
    await this.messageController.enqueueMessage(sessionId, text, attachments, options);
  }

  async steerTurn(sessionId: string, text: string): Promise<void> {
    await this.messageController.steerTurn(sessionId, text);
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.messageController.interrupt(sessionId);
  }

  /** Finish the current provider turn, but never start queued work on a handed-off source. */
  retireSessionAfterCurrentTurn(sessionId: string): void {
    const internal = this.sessions.get(sessionId);
    if (!internal) return;
    armCodexSessionRetirement(internal);
    if (!internal.currentTurn && !internal.turnLoopRunning) {
      this.finalizeSessionRetirement(internal);
    }
  }

  snapshotQueuedMessagesForHandOff(sessionId: string): QueuedAgentMessage[] {
    const internal = this.sessions.get(sessionId);
    if (!internal) return [];
    return (internal.pendingHandOffMessages ?? []).flatMap((message) =>
      message
        ? [{
            text: message.text,
            ...(message.attachments
              ? { attachments: message.attachments.map((attachment) => ({ ...attachment })) }
              : {}),
          }]
        : [],
    );
  }

  listPendingOutgoingMessages(sessionId: string): PendingAgentMessage[] {
    return this.messageController.listPendingOutgoingMessages(sessionId);
  }

  removePendingOutgoingMessage(sessionId: string, messageId: string): PendingAgentMessage | null {
    return this.messageController.removePendingOutgoingMessage(sessionId, messageId);
  }

  /**
   * 兼容旧 IPC 名称的 Codex sandbox 切换入口。
   *
   * app-server Codex 每次 `turn/start` 都携带 sandboxPolicy，因此这里不再冷重启：
   * 持久化 sessionRepo.codexSandbox 后 patch live thread options，当前 turn 继续跑，
   * 下一条 pending/user message 使用新 sandbox。
   */
  async restartWithCodexSandbox(
    sessionId: string,
    sandbox: 'workspace-write' | 'read-only' | 'danger-full-access',
    handoffPrompt: string,
  ): Promise<string> {
    return this.restartController.restartWithCodexSandbox(sessionId, sandbox, handoffPrompt);
  }

  async setSessionModelOptions(sessionId: string, options: SessionModelOptions): Promise<void> {
    await this.sessionModelController.setOptions(sessionId, options);
  }

  /**
   * 删会话清理：abort 当前 turn + 清 pendingMessages + 移除 internal session 记录。
   * 由 SessionManager.delete 调用，确保 codex 子进程不继续跑（CHANGELOG_20 / N2）。
   *
   * REVIEW_4 H1：必须先设 `intentionallyClosed = true` 再 abort，让 runTurnLoop catch
   * 看到标记后**静默退出**（不发 finished/message）。否则 abort 触发 catch → emit
   * `finished{subtype:interrupted}` → manager.dedupOrClaim 不丢这条 sdk 事件 →
   * ensureRecord 把已删 session 复活成 lifecycle:active 的幽灵 record + 多通知一条「Agent 完成」。
   */
  async closeSession(sessionId: string): Promise<void> {
    const internal = this.sessions.get(sessionId);
    if (!internal) return;

    // 关键：标记必须在 abort 之前置位，否则 runTurnLoop 的 catch 微任务会先看到 aborted 跑常规分支
    internal.intentionallyClosed = true;
    armCodexSessionRetirement(internal, true);

    if (internal.currentTurn) {
      try {
        internal.currentTurn.abort();
      } catch (err) {
        logger.warn(`[codex-bridge] abort during close failed: ${sessionId}`, err);
      }
      internal.currentTurn = null;
      internal.currentTurnId = null;
    }
    this.finalizeSessionRetirement(internal);
  }

  private finalizeSessionRetirement(internal: InternalSession): void {
    finalizeCodexSessionRetirement(
      {
        sessions: this.sessions,
        clients: this.codexBySession,
        releaseClaim: (sid) => sessionManager.releaseSdkClaim(sid),
        releaseToken: (sid) => mcpSessionTokenMap.release(sid),
      },
      internal,
    );
  }

  /**
   * Codex 没有 SDK 层 pending 概念（无权限请求 / 无主动提问 / 无 plan mode），
   * 但 IPC handler 期望 listPending 返回结构化对象。返回空数组保持接口一致。
   */
  listPending(_sessionId: string): {
    permissions: never[];
    askQuestions: never[];
    exitPlanModes: never[];
  } {
    return { permissions: [], askQuestions: [], exitPlanModes: [] };
  }

  listAllPending(): Record<
    string,
    { permissions: never[]; askQuestions: never[]; exitPlanModes: never[] }
  > {
    return {};
  }

  /**
   * symmetry-plan P2 HIGH-B：codex jsonl 预检 protected wrapper（与 claude
   * `resumeJsonlExists` 同款 facade extend override 模式）。
   *
   * 让 test 通过子类化 override 不依赖真 ~/.codex/sessions 目录；实际走 module-level
   * `defaultCodexResumeJsonlExists`（扫 startedAt 日期目录 + ±1 day 找 *-<threadId>.jsonl）。
   *
   * recoverer 拿这个判定 codex CLI resume 用的 jsonl 是否还在；不在时走 fallback 路径
   * （createSession 不带 resume + 后置 renameSdkSession 把应用层 events / file_changes /
   * summaries 子表迁过去）。
   */
  protected codexResumeJsonlExists(threadId: string, startedAt: number): boolean {
    return defaultCodexResumeJsonlExists(threadId, startedAt);
  }

  /**
   * symmetry-plan P2 LOW-A：cwd 存在性 protected wrapper（与 claude `cwdExists` 同款）。
   *
   * 让 test 通过子类化 override 不依赖真 fs；实际走 module-level `defaultCwdExists`
   * （直接 existsSync，异常 fail-safe 退化返回 true 让 SDK 自己 try）。
   *
   * recoverer 拿这个判定 sessionRepo.cwd 是否还有效；不存在时走 `findFallbackCwd` 启发式
   * fallback 路径（典型：K2 老 session cwd=worktree 后 worktree 被 archive_plan 删 /
   * 用户手动 git worktree remove / 跨设备同步丢目录）。
   */
  protected cwdExists(cwd: string): boolean {
    return defaultCwdExists(cwd);
  }

  /** Test seam around the synchronous pre-emit TEMP-spool capture. */
  protected captureRecoveryContext(
    session: SessionRecord,
    overrides?: RecoveryRuntimeOverrides,
  ): CapturedRecoveryContinuation {
    return captureRecoveryContinuation({ session, overrides });
  }

  /** Test seam around the shared provider-neutral recovery preparation. */
  protected prepareRecoveryContext(
    capture: CapturedRecoveryContinuation,
    continuationInstruction: string,
  ): Promise<PreparedRecoveryContinuation> {
    return prepareRecoveryContinuation({ capture, continuationInstruction });
  }

  /** Test seam around idempotent TEMP-spool cleanup. */
  protected cleanupRecoveryContext(capture: CapturedRecoveryContinuation): void {
    cleanupRecoveryContinuation(capture);
  }
}
