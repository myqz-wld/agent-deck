import {
  AgentDeckClientErrorCode,
  isCoreMethodAllowed,
  isJsonValue,
  parseNodeConfigurationGetResult,
  parseNodeHookParams,
  parseNodeHookProjectionResult,
  parseNodeHookProjectionStatus,
  type CoreMethod,
  type JsonValue,
  type NodeConfigurationAdapterId,
  type NodeHookProjectionState,
  type NodeHookProjectionStatusDto,
} from '@contracts/index';
import {
  DaemonRequestError,
  type DaemonCoreRuntime,
  type DaemonEventSubscriptionInput,
  type DaemonRequestInput,
  type DaemonRequestResult,
} from '@hosts/daemon';
import type { AgentAdapter } from '@main/adapters/types';

import type { ServerCoreProviderSettings } from './provider-settings';
import type { ServerCoreSessionLifecycleSettings } from './session-lifecycle-options';
import type { ServerCoreMutationClaim, ServerCoreMutationIdentity } from './runtime-metadata-store';

export const SERVER_CORE_NODE_CONFIGURATION_METHODS = Object.freeze([
  'node.configuration.get',
  'node.hook.projection.get',
] as const satisfies readonly CoreMethod[]);

type NodeConfigurationMethod = (typeof SERVER_CORE_NODE_CONFIGURATION_METHODS)[number];

export interface ServerCoreNodeConfigurationRuntimeOptions {
  readonly settings: ServerCoreProviderSettings;
  readonly sessionLifecycle: ServerCoreSessionLifecycleSettings;
  readonly registry: {
    get(id: string): AgentAdapter | undefined;
    isReady(id: string): boolean;
  };
  readonly hookStates: {
    get(adapterId: NodeConfigurationAdapterId): NodeHookProjectionState | null;
    set(adapterId: NodeConfigurationAdapterId, state: NodeHookProjectionState): void;
  };
  readonly metadata: {
    currentRevision(): number;
    appendChange(kind: string, entityId: string | null, payload: JsonValue): number;
    claimMutation(identity: ServerCoreMutationIdentity): ServerCoreMutationClaim;
    completeMutation(
      identity: ServerCoreMutationIdentity,
      result: JsonValue,
      revision: number,
    ): void;
    releaseMutationClaim(identity: ServerCoreMutationIdentity): void;
  };
}

function isNodeConfigurationMethod(method: CoreMethod): method is NodeConfigurationMethod {
  return (SERVER_CORE_NODE_CONFIGURATION_METHODS as readonly CoreMethod[]).includes(method);
}

/** Desktop-readable configuration and Hook snapshots owned by the Worker deployment. */
export class ServerCoreNodeConfigurationRuntime implements DaemonCoreRuntime {
  readonly supportedMethods: readonly CoreMethod[];
  readonly subscribe?: DaemonCoreRuntime['subscribe'];

  constructor(
    private readonly base: DaemonCoreRuntime,
    private readonly options: ServerCoreNodeConfigurationRuntimeOptions,
  ) {
    this.supportedMethods = Object.freeze([
      ...new Set([...base.supportedMethods, ...SERVER_CORE_NODE_CONFIGURATION_METHODS]),
    ]);
    if (base.subscribe) {
      const subscribe = base.subscribe.bind(base);
      this.subscribe = (input: DaemonEventSubscriptionInput) => subscribe(input);
    }
  }

  start(): Promise<void> { return this.base.start(); }
  stop(reason: string): Promise<void> { return this.base.stop(reason); }
  currentRevision(...args: Parameters<DaemonCoreRuntime['currentRevision']>): Promise<number> | number {
    return this.base.currentRevision(...args);
  }

  async execute(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    if (!isNodeConfigurationMethod(input.method)) return this.base.execute(input);
    if (!isCoreMethodAllowed(input.access.surface, input.method)) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.AccessDenied, 'Request rejected');
    }
    if (input.signal.aborted) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.Cancelled, 'Request was cancelled');
    }
    if (input.method === 'node.configuration.get') return this.configuration(input);
    return this.status(input);
  }

  private configuration(input: DaemonRequestInput): DaemonRequestResult {
    if (Object.keys(input.params).length !== 0) this.invalid();
    const revision = this.options.metadata.currentRevision();
    return this.result(parseNodeConfigurationGetResult({
      providerDefaults: {
        claudeCliPath: this.options.settings.claudeCliPath,
        claudeCodeSandbox: this.options.settings.claudeCodeSandbox,
        codexCliPath: this.options.settings.codexCliPath,
        codexSandbox: this.options.settings.codexSandbox,
        enableAgentDeckMcp: this.options.settings.enableAgentDeckMcp,
        grokCliPath: this.options.settings.grokCliPath,
        grokSandbox: this.options.settings.grokSandbox,
        injectAgentDeckClaudeAgents: this.options.settings.injectAgentDeckClaudeAgents,
        injectAgentDeckClaudeMd: this.options.settings.injectAgentDeckClaudeMd,
        injectAgentDeckClaudeSkills: this.options.settings.injectAgentDeckClaudeSkills,
        injectAgentDeckCodexAgents: this.options.settings.injectAgentDeckCodexAgents,
        injectAgentDeckCodexAgentsMd: this.options.settings.injectAgentDeckCodexAgentsMd,
        injectAgentDeckCodexSkills: this.options.settings.injectAgentDeckCodexSkills,
        injectAgentDeckGrokAgents: this.options.settings.injectAgentDeckGrokAgents,
        injectAgentDeckGrokAgentsMd: this.options.settings.injectAgentDeckGrokAgentsMd,
        injectAgentDeckGrokSkills: this.options.settings.injectAgentDeckGrokSkills,
        mcpHttpEnabled: this.options.settings.mcpHttpEnabled,
        permissionTimeoutMs: this.options.settings.permissionTimeoutMs,
        summaryModel: this.options.settings.summaryModel,
        summaryThinking: this.options.settings.summaryThinking,
        summaryTimeoutMs: this.options.settings.summaryTimeoutMs,
      },
      sessionLifecycle: this.options.sessionLifecycle,
      revision,
    }), revision);
  }

  private async status(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    const { adapterId } = this.params(input);
    const revision = this.options.metadata.currentRevision();
    const status = this.hookStatus(adapterId);
    return this.result(parseNodeHookProjectionResult({ adapterId, status, revision }), revision);
  }

  private params(input: DaemonRequestInput): { adapterId: NodeConfigurationAdapterId } {
    try { return parseNodeHookParams(input.params); }
    catch { return this.invalid(); }
  }

  private hookStatus(adapterId: NodeConfigurationAdapterId): NodeHookProjectionStatusDto {
    const adapter = this.options.registry.get(adapterId);
    const ready = this.options.registry.isReady(adapterId);
    if (!adapter || !ready) {
      return parseNodeHookProjectionStatus({
        supported: false,
        state: 'unavailable',
        scope: null,
        writeAllowed: false,
        disabledReason: 'adapter-unavailable',
      });
    }
    const state = this.options.hookStates.get(adapterId) ?? 'unavailable';
    return parseNodeHookProjectionStatus({
      supported: true,
      state,
      scope: 'user',
      writeAllowed: false,
      disabledReason: 'mutation-unavailable',
    });
  }

  private result(value: unknown, revision: number): DaemonRequestResult {
    if (!isJsonValue(value)) throw new Error('Node configuration result is not JSON-safe');
    return { result: value, revision };
  }

  private invalid(): never {
    throw new DaemonRequestError(AgentDeckClientErrorCode.InvalidRequest, 'Request rejected');
  }
}
