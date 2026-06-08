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
import { ClaudeSdkBridge } from '../claude-code/sdk-bridge';
import { settingsStore } from '@main/store/settings-store';
import {
  getDeepseekDefaultModel,
  getDeepseekSettingsPath,
  loadDeepseekClaudeEnv,
} from './config';
import {
  summariseViaLlm,
  summariseSessionForHandOff,
} from '@main/session/summarizer/llm-runners';

const ADAPTER_ID = 'deepseek-claude-code';

function rewriteDeepseekEvent(event: AgentEvent): AgentEvent {
  const payload =
    event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
      ? { ...event.payload }
      : event.payload;
  if (payload && typeof payload === 'object' && 'text' in payload && typeof payload.text === 'string') {
    payload.text = payload.text.replace(
      '`~/.claude/.credentials.json`',
      `Deepseek config ${getDeepseekSettingsPath()}`,
    );
  }
  return { ...event, agentId: ADAPTER_ID, payload };
}

class DeepseekClaudeCodeAdapter implements AgentAdapter {
  id = ADAPTER_ID;
  displayName = 'Deepseek (Claude Code)';
  capabilities = {
    canCreateSession: true,
    canInterrupt: true,
    canSendMessage: true,
    canInstallHooks: false,
    canRespondPermission: true,
    canSetPermissionMode: true,
    canRestartWithPermissionMode: true,
    canRestartWithCodexSandbox: false,
    canRestartWithClaudeCodeSandbox: true,
    canCloseSession: true,
    canCollaborate: true,
    canAcceptAttachments: true,
  };

  private bridge: ClaudeSdkBridge | null = null;

  async init(ctx: AdapterContext): Promise<void> {
    this.bridge = new ClaudeSdkBridge({
      emit: (event) => ctx.emit(rewriteDeepseekEvent(event)),
      permissionTimeoutMs: settingsStore.get('permissionTimeoutMs'),
      envProvider: loadDeepseekClaudeEnv,
      defaultModelProvider: getDeepseekDefaultModel,
    });
  }

  async shutdown(): Promise<void> {}

  async createSession(
    opts: ClaudeCreateOpts & { agentId: 'deepseek-claude-code' },
  ): Promise<string> {
    if (!this.bridge) throw new Error('adapter not initialized');
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
      handOff: opts.handOff,
    });
    return handle.sessionId;
  }

  async interruptSession(sessionId: string): Promise<void> {
    await this.bridge?.interrupt(sessionId);
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.bridge?.closeSession(sessionId);
  }

  async sendMessage(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
  ): Promise<void> {
    if (!this.bridge) throw new Error('adapter not initialized');
    await this.bridge.sendMessage(sessionId, text, attachments);
  }

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
    return this.bridge?.listPending(sessionId) ?? { permissions: [], askQuestions: [], exitPlanModes: [] };
  }

  listAllPending(): Record<string, {
    permissions: PermissionRequest[];
    askQuestions: AskUserQuestionRequest[];
    exitPlanModes: ExitPlanModeRequest[];
  }> {
    return this.bridge?.listAllPending() ?? {};
  }

  setPermissionTimeoutMs(ms: number): void {
    this.bridge?.setPermissionTimeoutMs(ms);
  }

  /**
   * Deepseek provider for periodic summaries and hand-off briefs.
   *
   * It reuses the Claude-family oneshot runner with Deepseek's Anthropic-compatible
   * base URL/token/model env overlay, keeping provider selection independent from the
   * target session adapter.
   */
  async summariseEvents(
    cwd: string,
    events: AgentEvent[],
    kind: 'summary' | 'handoff',
  ): Promise<string | null> {
    const envOverride = loadDeepseekClaudeEnv();
    return kind === 'summary'
      ? summariseViaLlm(cwd, events, { agentName: 'Deepseek', envOverride })
      : summariseSessionForHandOff(cwd, events, 'Deepseek', { envOverride });
  }
}

export type { DeepseekClaudeCodeAdapter };
export const deepseekClaudeCodeAdapter: DeepseekClaudeCodeAdapter = new DeepseekClaudeCodeAdapter();
