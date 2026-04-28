import type { AgentAdapter, AdapterContext, PermissionMode } from '../types';
import type {
  AskUserQuestionAnswer,
  AskUserQuestionRequest,
  ExitPlanModeRequest,
  ExitPlanModeResponse,
  PermissionRequest,
  PermissionResponse,
} from '@shared/types';
import { buildHookRoutes } from './hook-routes';
import { HookInstaller } from './hook-installer';
import { ClaudeSdkBridge } from './sdk-bridge';
import { settingsStore } from '@main/store/settings-store';

const ADAPTER_ID = 'claude-code';

class ClaudeCodeAdapterImpl implements AgentAdapter {
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
    canCloseSession: true,
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

  async createSession(opts: {
    cwd: string;
    prompt?: string;
    model?: string;
    permissionMode?: PermissionMode;
    systemPrompt?: string;
    resume?: string;
  }): Promise<string> {
    if (!this.bridge) throw new Error('adapter not initialized');
    const handle = await this.bridge.createSession(opts);
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

  async sendMessage(sessionId: string, text: string): Promise<void> {
    if (!this.bridge) throw new Error('adapter not initialized');
    await this.bridge.sendMessage(sessionId, text);
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
}

export const claudeCodeAdapter: AgentAdapter = new ClaudeCodeAdapterImpl();
