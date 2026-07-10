import type {
  AgentAdapter,
  AdapterContext,
  ClaudeCreateOpts,
  CreateSessionOptions,
  ForkedSessionHandle,
  ForkSessionSource,
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
  ProviderUsageSnapshot,
  UploadedAttachmentRef,
} from '@shared/types';
import { ClaudeSdkBridge } from '../claude-code/sdk-bridge';
import {
  createClaudeFamilyForkedSession,
  getClaudeConfigRoot,
} from '../claude-code/fork-session';
import { settingsStore } from '@main/store/settings-store';
import {
  getDeepseekDefaultModel,
  getDeepseekModelForClaudeAlias,
  getDeepseekSettingsPath,
  loadDeepseekClaudeEnv,
} from './config';
import {
  summariseViaLlm,
  summariseSessionForHandOff,
} from '@main/session/summarizer/llm-runners';
import { unsupportedUsageSnapshot } from '../provider-usage';
import { sessionManager } from '@main/session/manager';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { normalize, resolve } from 'node:path';

const ADAPTER_ID = 'deepseek-claude-code';

const CLAUDE_ALIAS_MODEL_RE = /^(?:claude-)?(fable|opus|sonnet|haiku)(?:-|$)/i;

function rewriteDeepseekModel(model: unknown): unknown {
  if (typeof model !== 'string') return model;
  const match = CLAUDE_ALIAS_MODEL_RE.exec(model);
  if (!match) return model;
  try {
    const alias = match[1].toLowerCase() as 'fable' | 'opus' | 'sonnet' | 'haiku';
    return getDeepseekModelForClaudeAlias(alias) ?? model;
  } catch {
    return model;
  }
}

export function rewriteDeepseekEvent(event: AgentEvent): AgentEvent {
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
  if (payload && typeof payload === 'object' && 'model' in payload) {
    payload.model = rewriteDeepseekModel(payload.model);
  }
  return { ...event, agentId: ADAPTER_ID, payload };
}

function comparableConfigRoot(configRoot: string): string {
  const absolute = resolve(configRoot);
  try {
    return normalize(realpathSync(absolute)).normalize('NFC');
  } catch {
    return normalize(absolute).normalize('NFC');
  }
}

function readDeepseekConfigRootOverride(settingsPath: string): string | undefined {
  if (!existsSync(settingsPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const env = (parsed as { env?: unknown }).env;
    if (!env || typeof env !== 'object' || Array.isArray(env)) return undefined;
    const value = (env as Record<string, unknown>).CLAUDE_CONFIG_DIR;
    return typeof value === 'string' ? value : undefined;
  } catch (error) {
    throw new Error(
      `Failed to read Deepseek config ${settingsPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Read-only native-fork preflight. It never creates settings or mutates process.env. */
export function assertDeepseekForkTranscriptRootCompatible(
  settingsPath = getDeepseekSettingsPath(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const mainProcessRoot = getClaudeConfigRoot(env);
  const deepseekRoot = readDeepseekConfigRootOverride(settingsPath) ?? mainProcessRoot;
  if (comparableConfigRoot(deepseekRoot) === comparableConfigRoot(mainProcessRoot)) return;
  throw new Error(
    'Deepseek native fork cannot safely locate the source transcript because its effective ' +
      `CLAUDE_CONFIG_DIR (${deepseekRoot}) differs from the main-process Claude transcript root ` +
      `(${mainProcessRoot}). Use the main transcript root or use contextMode "fresh".`,
  );
}

class DeepseekClaudeCodeAdapter implements AgentAdapter {
  id = ADAPTER_ID;
  displayName = 'Deepseek (Claude Code)';
  capabilities = {
    canCreateSession: true,
    canForkSession: true,
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
      claudeCodeEffortLevel: opts.claudeCodeEffortLevel,
      claudeAgentName: opts.claudeAgentName,
      claudeAgents: opts.claudeAgents,
      handOff: opts.handOff,
      awaitCanonicalId: opts.awaitCanonicalId,
    });
    return handle.sessionId;
  }

  async validateForkSession(
    _source: ForkSessionSource,
    target: CreateSessionOptions,
  ): Promise<void> {
    if (target.agentId !== ADAPTER_ID) {
      throw new Error(`Deepseek native fork requires target adapter "${ADAPTER_ID}".`);
    }
    if (!this.bridge) throw new Error('adapter not initialized');
    assertDeepseekForkTranscriptRootCompatible();
  }

  async createForkedSession(
    source: ForkSessionSource,
    target: CreateSessionOptions,
  ): Promise<ForkedSessionHandle> {
    if (target.agentId !== ADAPTER_ID || !this.bridge) {
      throw new Error(`Deepseek native fork requires initialized target adapter "${ADAPTER_ID}".`);
    }
    const bridge = this.bridge;
    return createClaudeFamilyForkedSession({
      source,
      providerName: 'Deepseek',
      createChild: (forkedNativeSessionId) =>
        this.createSession({ ...target, resume: forkedNativeSessionId }),
      closeChild: (sessionId) => bridge.closeSession(sessionId),
      deleteChild: (sessionId) => sessionManager.delete(sessionId),
    });
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

  async getUsageSnapshot(): Promise<ProviderUsageSnapshot> {
    return unsupportedUsageSnapshot(
      'deepseek-claude-code',
      'Deepseek',
      'Deepseek 暂不支持读取额度信息',
    );
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
