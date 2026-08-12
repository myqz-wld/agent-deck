import { createHash } from 'node:crypto';

import {
  AgentDeckClientErrorCode,
  isCoreMethodAllowed,
  isJsonValue,
  parseNodeConfigurationGetResult,
  parseNodeHookParams,
  parseNodeHookProjectionResult,
  parseNodeHookProjectionStatus,
  parseNodeHookStatus,
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
import type {
  ServerCoreMutationClaim,
  ServerCoreMutationIdentity,
} from './runtime-metadata-store';
import { canonicalJson } from './runtime-validation';

export const SERVER_CORE_NODE_CONFIGURATION_METHODS = Object.freeze([
  'node.configuration.get',
  'node.hook.projection.get',
  'node.hook.projection.install',
  'node.hook.projection.uninstall',
] as const satisfies readonly CoreMethod[]);

type NodeConfigurationMethod = (typeof SERVER_CORE_NODE_CONFIGURATION_METHODS)[number];

export interface ServerCoreNodeConfigurationRuntimeOptions {
  readonly settings: ServerCoreProviderSettings;
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

/** Desktop-only configuration snapshot and Worker-owned provider Hook controls. */
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
    if (input.method === 'node.hook.projection.get') return this.status(input);
    return this.mutateHook(
      input,
      input.method === 'node.hook.projection.install' ? 'install' : 'uninstall',
    );
  }

  private configuration(input: DaemonRequestInput): DaemonRequestResult {
    if (Object.keys(input.params).length !== 0) this.invalid();
    const revision = this.options.metadata.currentRevision();
    return this.result(parseNodeConfigurationGetResult({
      providerDefaults: {
        claudeCodeSandbox: this.options.settings.claudeCodeSandbox,
        codexSandbox: this.options.settings.codexSandbox,
        enableAgentDeckMcp: this.options.settings.enableAgentDeckMcp,
        grokSandbox: this.options.settings.grokSandbox,
        permissionTimeoutMs: this.options.settings.permissionTimeoutMs,
        summaryModel: this.options.settings.summaryModel,
        summaryThinking: this.options.settings.summaryThinking,
        summaryTimeoutMs: this.options.settings.summaryTimeoutMs,
      },
      revision,
    }), revision);
  }

  private async status(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    const { adapterId } = this.params(input);
    const revision = this.options.metadata.currentRevision();
    const status = this.hookStatus(adapterId);
    return this.result(parseNodeHookProjectionResult({ adapterId, status, revision }), revision);
  }

  private async mutateHook(
    input: DaemonRequestInput,
    operation: 'install' | 'uninstall',
  ): Promise<DaemonRequestResult> {
    const { adapterId } = this.params(input);
    const identity = this.identity(input);
    const claim = this.options.metadata.claimMutation(identity);
    if (claim.state === 'completed') return { result: claim.result, revision: claim.revision };
    if (claim.state === 'conflict') {
      throw new DaemonRequestError(AgentDeckClientErrorCode.Conflict, 'Request conflicts');
    }
    if (claim.state === 'uncertain') {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.ProviderLost,
        'Hook operation outcome is uncertain',
      );
    }
    let status: NodeHookProjectionStatusDto;
    try {
      status = await this.mutateHookProvider(adapterId, operation);
    } catch (cause) {
      try { this.options.metadata.releaseMutationClaim(identity); }
      catch (releaseError) {
        throw new AggregateError([cause, releaseError], 'Hook mutation claim release failed');
      }
      throw cause;
    }
    const revision = this.options.metadata.appendChange('node.hook.updated', adapterId, {
      adapterId,
      state: status.state,
    });
    const result = parseNodeHookProjectionResult({ adapterId, status, revision });
    const wire = this.result(result, revision);
    this.options.metadata.completeMutation(identity, wire.result, revision);
    return wire;
  }

  private params(input: DaemonRequestInput): { adapterId: NodeConfigurationAdapterId } {
    try { return parseNodeHookParams(input.params); }
    catch { return this.invalid(); }
  }

  private hookStatus(adapterId: NodeConfigurationAdapterId): NodeHookProjectionStatusDto {
    const adapter = this.options.registry.get(adapterId);
    const ready = this.options.registry.isReady(adapterId);
    const writeAllowed = adapter?.capabilities.canInstallHooks === true &&
      ready &&
      typeof adapter.installIntegration === 'function' &&
      typeof adapter.uninstallIntegration === 'function';
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
      writeAllowed,
      disabledReason: writeAllowed ? null : 'mutation-unavailable',
    });
  }

  private async mutateHookProvider(
    adapterId: NodeConfigurationAdapterId,
    operation: 'install' | 'uninstall',
  ): Promise<NodeHookProjectionStatusDto> {
    const adapter = this.options.registry.get(adapterId);
    const ready = this.options.registry.isReady(adapterId);
    const writeAllowed = adapter?.capabilities.canInstallHooks === true &&
      ready &&
      typeof adapter.installIntegration === 'function' &&
      typeof adapter.uninstallIntegration === 'function';
    const method = operation === 'install'
      ? adapter?.installIntegration
      : adapter?.uninstallIntegration;
    if (!writeAllowed || typeof method !== 'function') {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.CapabilityUnavailable,
        'Provider Hook integration is unavailable',
      );
    }
    const value = await method.call(adapter, { scope: 'user' });
    try {
      const raw = parseNodeHookStatus(value);
      const state: NodeHookProjectionState = raw.installed
        ? 'installed'
        : raw.installedHooks.length > 0 ? 'partial' : 'not-installed';
      this.options.hookStates.set(adapterId, state);
      return parseNodeHookProjectionStatus({
        supported: true,
        state,
        scope: 'user',
        writeAllowed,
        disabledReason: writeAllowed ? null : 'mutation-unavailable',
      });
    }
    catch {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.InternalError,
        'Provider Hook result is invalid',
      );
    }
  }

  private identity(input: DaemonRequestInput): ServerCoreMutationIdentity {
    if (!input.idempotencyKey) this.invalid();
    return {
      accessCredentialId: input.access.accessCredentialId,
      accessSurface: input.access.surface,
      idempotencyKey: input.idempotencyKey,
      method: input.method,
      requestFingerprint: createHash('sha256')
        .update(`${input.method}\u0000${canonicalJson(input.params)}`)
        .digest('hex'),
    };
  }

  private result(value: unknown, revision: number): DaemonRequestResult {
    if (!isJsonValue(value)) throw new Error('Node configuration result is not JSON-safe');
    return { result: value, revision };
  }

  private invalid(): never {
    throw new DaemonRequestError(AgentDeckClientErrorCode.InvalidRequest, 'Request rejected');
  }
}
