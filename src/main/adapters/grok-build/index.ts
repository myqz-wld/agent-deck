import type {
  AgentAdapter,
  AgentEnqueueOptions,
  AdapterContext,
  GrokCreateOpts,
  CreateSessionOptions,
} from '../types';
import type {
  AdapterSessionMode,
  AgentEvent,
  PermissionResponse,
  ProviderUsageSnapshot,
  UploadedAttachmentRef,
} from '@shared/types';
import { unavailableUsageSnapshot } from '../provider-usage';
import { settingsStore } from '@main/store/settings-store';
import log from '@main/utils/logger';
import type { TrustedContinuationInitialTurn } from '@main/session/continuation-context/initial-turn';

import { getAdapterRuntimeProfile } from '../runtime-profiles';
import { GrokBuildBridge } from './bridge';
import {
  loadGrokBaselinePrompt,
  prepareGrokPluginProfile,
} from './resources';
import { summariseGrokSessionViaOneshot } from './summarizer-runner';
import { buildGrokHookRoutes } from './hook-routes';
import { GrokHookInstaller } from './hook-installer';

const ADAPTER_ID = 'grok-build';
const logger = log.scope('grok-build-adapter');

export class GrokBuildAdapter implements AgentAdapter {
  id = ADAPTER_ID;
  displayName = getAdapterRuntimeProfile(ADAPTER_ID).displayName;
  capabilities = { ...getAdapterRuntimeProfile(ADAPTER_ID).capabilities };

  private bridge: GrokBuildBridge | null = null;
  private installer: GrokHookInstaller | null = null;

  async init(ctx: AdapterContext): Promise<void> {
    this.installer = new GrokHookInstaller(
      ctx.hookServer.listeningPort,
      ctx.hookServer.bearerToken,
    );
    for (const route of buildGrokHookRoutes(ctx.emit)) {
      ctx.routeRegistry.registerForAdapter(this.id, route);
    }

    this.bridge = new GrokBuildBridge({
      emit: ctx.emit,
      mcpHttpUrl: `http://127.0.0.1:${ctx.hookServer.listeningPort}/mcp`,
      isAgentDeckMcpEnabled: () =>
        settingsStore.get('enableAgentDeckMcp') === true &&
        settingsStore.get('mcpHttpEnabled') === true,
      getAgentProfilePrompt: () =>
        settingsStore.get('injectAgentDeckGrokAgentsMd')
          ? loadGrokBaselinePrompt()
          : Promise.resolve(null),
      getPluginDirectories: async ({ requiresAgent }) => {
        const root = await prepareGrokPluginProfile({
          includeSkills: settingsStore.get('injectAgentDeckGrokSkills'),
          includeAgents:
            requiresAgent || settingsStore.get('injectAgentDeckGrokAgents'),
        });
        return root ? [root] : [];
      },
      onNegotiatedImageCapability: (supported) => {
        this.capabilities.canAcceptAttachments = supported;
        getAdapterRuntimeProfile(ADAPTER_ID).capabilities.canAcceptAttachments = supported;
      },
      permissionTimeoutMs: settingsStore.get('permissionTimeoutMs'),
      binaryPath: settingsStore.get('grokCliPath'),
    });

    // Capability discovery is local and free. A missing CLI should not disable the rest of Agent Deck.
    try {
      await this.bridge.probeCapabilities(ctx.paths.userHome);
    } catch (error) {
      logger.info(
        `Grok ACP capability probe skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async shutdown(): Promise<void> {
    await this.bridge?.shutdown();
    this.bridge = null;
    this.installer = null;
  }

  async createSession(
    opts: GrokCreateOpts & { agentId: 'grok-build' },
  ): Promise<string> {
    if (!this.bridge) throw new Error('Grok Build adapter is not initialized.');
    return this.bridge.createSession({
      cwd: opts.cwd,
      prompt: opts.prompt,
      resume: opts.resume,
      teamName: opts.teamName,
      attachments: opts.attachments,
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
      sessionMode: opts.sessionMode,
      grokAgentName: opts.grokAgentName,
      handOff: opts.handOff,
      awaitCanonicalId: opts.awaitCanonicalId,
      initialSessionRegistration: opts.initialSessionRegistration,
    });
  }

  async createTrustedContinuationSession(
    opts: CreateSessionOptions,
    turn: TrustedContinuationInitialTurn,
  ): Promise<string> {
    if (opts.agentId !== ADAPTER_ID || !this.bridge) {
      throw new Error('Grok trusted continuation requires an initialized Grok adapter.');
    }
    return this.bridge.createTrustedContinuationSession(
      {
        cwd: opts.cwd,
        attachments: opts.attachments,
        model: opts.model,
        reasoningEffort: opts.reasoningEffort,
        sessionMode: opts.sessionMode,
        handOff: opts.handOff,
        awaitCanonicalId: opts.awaitCanonicalId,
        initialSessionRegistration: opts.initialSessionRegistration,
      },
      turn,
    );
  }

  async interruptSession(sessionId: string): Promise<void> {
    await this.bridge?.interrupt(sessionId);
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.bridge?.closeSession(sessionId);
  }

  retireSessionAfterCurrentTurn(sessionId: string): void {
    this.bridge?.retireSessionAfterCurrentTurn(sessionId);
  }

  async sendMessage(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: AgentEnqueueOptions,
  ): Promise<void> {
    if (!this.bridge) throw new Error('Grok Build adapter is not initialized.');
    await this.bridge.sendMessage(sessionId, text, attachments, options);
  }

  async enqueueMessage(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: AgentEnqueueOptions,
  ): Promise<void> {
    if (!this.bridge) throw new Error('Grok Build adapter is not initialized.');
    await this.bridge.enqueueMessage(sessionId, text, attachments, options);
  }

  snapshotQueuedMessagesForHandOff(sessionId: string) {
    return this.bridge?.snapshotQueuedMessagesForHandOff(sessionId) ?? [];
  }

  listPendingOutgoingMessages(sessionId: string) {
    return this.bridge?.listPendingOutgoingMessages(sessionId) ?? [];
  }

  removePendingOutgoingMessage(sessionId: string, messageId: string) {
    return this.bridge?.removePendingOutgoingMessage(sessionId, messageId) ?? null;
  }

  async receiveTeammateMessage(
    sessionId: string,
    _fromMemberId: string,
    body: string,
  ): Promise<void> {
    await this.sendMessage(sessionId, body);
  }

  async respondPermission(
    sessionId: string,
    requestId: string,
    response: PermissionResponse,
  ): Promise<void> {
    this.bridge?.respondPermission(sessionId, requestId, response);
  }

  async setSessionModelOptions(
    sessionId: string,
    options: { provider: string | null; model: string | null; thinking: string | null },
  ): Promise<void> {
    if (!this.bridge) throw new Error('Grok Build adapter is not initialized.');
    await this.bridge.setSessionModelOptions(sessionId, options);
  }

  async setSessionMode(sessionId: string, mode: AdapterSessionMode): Promise<void> {
    if (!this.bridge) throw new Error('Grok Build adapter is not initialized.');
    await this.bridge.setSessionMode(sessionId, mode);
  }

  listPending(sessionId: string) {
    return {
      permissions: this.bridge?.listPending(sessionId).permissions ?? [],
      askQuestions: [],
      exitPlanModes: [],
    };
  }

  listAllPending() {
    const pending = this.bridge?.listAllPending() ?? {};
    return Object.fromEntries(
      Object.entries(pending).map(([sessionId, value]) => [
        sessionId,
        { permissions: value.permissions, askQuestions: [], exitPlanModes: [] },
      ]),
    );
  }

  setPermissionTimeoutMs(ms: number): void {
    this.bridge?.setPermissionTimeoutMs(ms);
  }

  setGrokCliPath(path: string | null): void {
    this.bridge?.setBinaryPath(path);
  }

  async getUsageSnapshot(): Promise<ProviderUsageSnapshot> {
    if (!this.bridge) {
      return unavailableUsageSnapshot(
        'grok-build',
        'Grok',
        'Grok 暂时无法读取额度信息',
      );
    }
    return this.bridge.getUsageSnapshot();
  }

  async installIntegration(opts: {
    scope: 'user' | 'project';
    cwd?: string;
  }): Promise<unknown> {
    if (!this.installer) throw new Error('Grok Build adapter is not initialized.');
    return this.installer.install(opts);
  }

  async uninstallIntegration(opts: {
    scope: 'user' | 'project';
    cwd?: string;
  }): Promise<unknown> {
    if (!this.installer) throw new Error('Grok Build adapter is not initialized.');
    return this.installer.uninstall(opts);
  }

  async integrationStatus(opts: {
    scope: 'user' | 'project';
    cwd?: string;
  }): Promise<unknown> {
    if (!this.installer) throw new Error('Grok Build adapter is not initialized.');
    return this.installer.status(opts);
  }

  /** Periodic session-list summary; continuation checkpoints use the isolated runtime. */
  async summariseEvents(
    cwd: string,
    events: AgentEvent[],
    evidenceContext?: string,
    runtime?: { provider?: string; model?: string; thinking?: string },
  ): Promise<string | null> {
    if (runtime?.provider) {
      throw new Error('grok-build does not support a separate runtime provider');
    }
    return summariseGrokSessionViaOneshot(cwd, events, evidenceContext, runtime);
  }
}

export const grokBuildAdapter = new GrokBuildAdapter();
