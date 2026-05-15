import type {
  AgentAdapter,
  AdapterContext,
  ClaudeCreateOpts,
  PermissionMode,
} from '../types';
import type {
  AgentEvent,
  AskUserQuestionAnswer,
  AskUserQuestionRequest,
  ExitPlanModeRequest,
  ExitPlanModeResponse,
  PermissionRequest,
  PermissionResponse,
  UploadedAttachmentRef,
} from '@shared/types';
import { buildHookRoutes } from './hook-routes';
import { HookInstaller } from './hook-installer';
import { ClaudeSdkBridge } from './sdk-bridge';
import { settingsStore } from '@main/store/settings-store';
import {
  summariseViaLlm,
  summariseSessionForHandOff,
} from '@main/session/summarizer/llm-runners';

const ADAPTER_ID = 'claude-code';

class ClaudeCodeAdapter implements AgentAdapter {
  id = ADAPTER_ID;
  displayName = 'Claude Code';
  capabilities = {
    canCreateSession: true,
    canInterrupt: true,
    canSendMessage: true,
    canInstallHooks: true,
    canRespondPermission: true,
    canSetPermissionMode: true,
    canRestartWithPermissionMode: true,
    canRestartWithCodexSandbox: false,
    // CHANGELOG_74：claude OS 沙盒冷切（与 codex restartWithCodexSandbox 字面镜像）
    canRestartWithClaudeCodeSandbox: true,
    canCloseSession: true,
    // R3.E4：universal team backend 接收 cross-adapter 消息（receiveTeammateMessage = sendMessage）
    canCollaborate: true,
    // REVIEW_35 HIGH-D2：SDK content blocks 接收 image base64
    canAcceptAttachments: true,
  };

  private installer: HookInstaller | null = null;
  private bridge: ClaudeSdkBridge | null = null;

  async init(ctx: AdapterContext): Promise<void> {
    const port = ctx.hookServer.listeningPort;
    const token = ctx.hookServer.bearerToken;
    this.installer = new HookInstaller(port, token);

    const routes = buildHookRoutes(ctx.emit);
    for (const r of routes) {
      ctx.routeRegistry.registerForAdapter(this.id, r);
    }

    this.bridge = new ClaudeSdkBridge({
      emit: ctx.emit,
      permissionTimeoutMs: settingsStore.get('permissionTimeoutMs'),
    });
  }

  async shutdown(): Promise<void> {
    // fastify 路由关闭由 HookServer.stop() 统一处理
  }

  async createSession(opts: ClaudeCreateOpts & { agentId: 'claude-code' }): Promise<string> {
    if (!this.bridge) throw new Error('adapter not initialized');
    // p4-d2-impl R1 reviewer-claude MED follow-up:显式 spread 各字段(与其他 3 adapter 风格一致),
    // 不整 opts(含 D2 discriminator agentId 字段)塞 bridge — bridge.createSession opts inline
    // type 不接 agentId 字段,TS structural typing 当前接受但 future bridge 加 strict check 会破。
    const handle = await this.bridge.createSession({
      cwd: opts.cwd,
      prompt: opts.prompt,
      permissionMode: opts.permissionMode,
      resume: opts.resume,
      teamName: opts.teamName,
      attachments: opts.attachments,
      claudeCodeSandbox: opts.claudeCodeSandbox,
      extraAllowWrite: opts.extraAllowWrite,
      model: opts.model,
    });
    return handle.sessionId;
  }

  async interruptSession(sessionId: string): Promise<void> {
    if (!this.bridge) return;
    await this.bridge.interrupt(sessionId);
  }

  async closeSession(sessionId: string): Promise<void> {
    if (!this.bridge) return;
    await this.bridge.closeSession(sessionId);
  }

  async sendMessage(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
  ): Promise<void> {
    if (!this.bridge) throw new Error('adapter not initialized');
    await this.bridge.sendMessage(sessionId, text, attachments);
  }

  /**
   * R3.E4：receiveTeammateMessage = 调本 adapter 的 sendMessage（与 IPC 路径同款）。
   * watcher 已在 body 里拼好 `[from <displayName> @ <adapterId>]` 前缀，直接透传。
   * fromMemberId 仅用于 logging（未来 emit 时贴标签）。
   */
  async receiveTeammateMessage(
    sessionId: string,
    _fromMemberId: string,
    body: string,
  ): Promise<void> {
    if (!this.bridge) throw new Error('adapter not initialized');
    await this.bridge.sendMessage(sessionId, body);
  }

  async respondPermission(
    sessionId: string,
    requestId: string,
    response: PermissionResponse,
  ): Promise<void> {
    if (!this.bridge) throw new Error('adapter not initialized');
    this.bridge.respondPermission(sessionId, requestId, response);
  }

  async respondAskUserQuestion(
    sessionId: string,
    requestId: string,
    answer: AskUserQuestionAnswer,
  ): Promise<void> {
    if (!this.bridge) throw new Error('adapter not initialized');
    this.bridge.respondAskUserQuestion(sessionId, requestId, answer);
  }

  async respondExitPlanMode(
    sessionId: string,
    requestId: string,
    response: ExitPlanModeResponse,
  ): Promise<void> {
    if (!this.bridge) throw new Error('adapter not initialized');
    await this.bridge.respondExitPlanMode(sessionId, requestId, response);
  }

  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
    if (!this.bridge) throw new Error('adapter not initialized');
    await this.bridge.setPermissionMode(sessionId, mode);
  }

  async restartWithPermissionMode(
    sessionId: string,
    mode: PermissionMode,
    handoffPrompt: string,
  ): Promise<string> {
    if (!this.bridge) throw new Error('adapter not initialized');
    return this.bridge.restartWithPermissionMode(sessionId, mode, handoffPrompt);
  }

  /**
   * CHANGELOG_74：Claude OS 沙盒冷切（与 codex restartWithCodexSandbox 字面镜像）。
   * 销毁旧 SDK 子进程 + 用新档位 createSession resume 重建。
   * 失败 bridge 内已 emit error message + 回滚 sessionRepo.claudeCodeSandbox。
   */
  async restartWithClaudeCodeSandbox(
    sessionId: string,
    sandbox: 'off' | 'workspace-write' | 'strict',
    handoffPrompt: string,
  ): Promise<string> {
    if (!this.bridge) throw new Error('adapter not initialized');
    return this.bridge.restartWithClaudeCodeSandbox(sessionId, sandbox, handoffPrompt);
  }

  listPending(sessionId: string): {
    permissions: PermissionRequest[];
    askQuestions: AskUserQuestionRequest[];
    exitPlanModes: ExitPlanModeRequest[];
  } {
    if (!this.bridge) return { permissions: [], askQuestions: [], exitPlanModes: [] };
    return this.bridge.listPending(sessionId);
  }

  listAllPending(): Record<string, {
    permissions: PermissionRequest[];
    askQuestions: AskUserQuestionRequest[];
    exitPlanModes: ExitPlanModeRequest[];
  }> {
    if (!this.bridge) return {};
    return this.bridge.listAllPending();
  }

  setPermissionTimeoutMs(ms: number): void {
    this.bridge?.setPermissionTimeoutMs(ms);
  }

  async installIntegration(opts: { scope: 'user' | 'project'; cwd?: string }): Promise<unknown> {
    if (!this.installer) throw new Error('adapter not initialized');
    return this.installer.install(opts);
  }

  async uninstallIntegration(opts: { scope: 'user' | 'project'; cwd?: string }): Promise<unknown> {
    if (!this.installer) throw new Error('adapter not initialized');
    return this.installer.uninstall(opts);
  }

  async integrationStatus(opts: { scope: 'user' | 'project'; cwd?: string }): Promise<unknown> {
    if (!this.installer) throw new Error('adapter not initialized');
    return this.installer.status(opts);
  }

  /**
   * R37 P2-I Step 3.3：LLM 驱动的「最近做什么」入口（dispatch 下放）。
   *
   * - 'summary' → `summariseViaLlm` (haiku 30 字 tag-line，settings.summaryTimeoutMs)
   * - 'handoff' → `summariseSessionForHandOff` (sonnet 4 节简报，60s timeout hardcoded)
   *
   * model / systemPrompt / timeout / result 清洗等差异全在底层 runner，本 adapter 只做 dispatch。
   */
  async summariseEvents(
    cwd: string,
    events: AgentEvent[],
    kind: 'summary' | 'handoff',
  ): Promise<string | null> {
    return kind === 'summary'
      ? summariseViaLlm(cwd, events)
      : summariseSessionForHandOff(cwd, events);
  }
}

/**
 * Typed export（D2）：caller `adapterRegistry.get('claude-code')` 拿到本 class 实例后,
 * 自动暴露 claude 专属方法（respondPermission / restartWithClaudeCodeSandbox 等）TS visible。
 * AgentAdapter union 兜底兼容仍可（ClaudeCodeAdapter implements AgentAdapter）。
 */
export type { ClaudeCodeAdapter };
export const claudeCodeAdapter: ClaudeCodeAdapter = new ClaudeCodeAdapter();
