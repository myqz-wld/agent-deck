import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';

import {
  PROVIDER_INFERENCE_MAX_DEADLINE_MS,
  PROVIDER_INFERENCE_MAX_REQUEST_BYTES,
  PROVIDER_INFERENCE_MAX_RESPONSE_BYTES,
  PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION,
  parseProviderSessionLaunchSpec,
  type ProviderSessionBrowserContext,
  type SessionConsoleSandboxAccess,
} from '@contracts/index';
import type {
  ProviderSessionControlChannel,
  ProviderSessionControlExit,
  ProviderSessionSupervisorControlPort,
} from '@hosts/provider-session/supervisor-port';
import {
  ProviderSessionMultiplexConnection,
  type ProviderSessionInferenceTransport,
} from '@hosts/provider-session';

import {
  parseServerCoreProviderInferenceBinding,
} from './provider-inference-broker';
import type {
  ServerCoreProviderInferenceBinding,
} from './provider-inference-broker-port';
import { ServerCoreProviderInferenceError } from './provider-inference-broker-port';
import type {
  ServerCoreProviderInferenceUnixHttpPort,
} from './provider-inference-unix-http';

const ADAPTER_ID = 'grok-build';
const PROVIDER_ID = 'xai';
const RUNTIME_ID = 'grok-build-v1';
const UPSTREAM_ID = 'grok-xai';
const UPSTREAM_PATHS = Object.freeze(['/v1/chat/completions', '/v1/responses']);

export type ServerCoreProviderGrokContainerDisabledReason =
  | 'provider-inference-broker-unavailable'
  | 'provider-session-supervisor-unavailable';

export interface ServerCoreProviderGrokContainerReadiness {
  readonly available: boolean;
  readonly disabledReason: ServerCoreProviderGrokContainerDisabledReason | null;
  readonly supervisorGeneration: number;
}

export interface ServerCoreProviderGrokContainerOpenInput {
  readonly browserContext?: ProviderSessionBrowserContext;
  readonly effectiveAccess: SessionConsoleSandboxAccess;
  readonly sessionId: string;
  /** `.` or one normalized directory relative to the selected Workspace. */
  readonly workingDirectory: string;
}

export interface ServerCoreProviderGrokContainerSession {
  readonly exited: Promise<ProviderSessionControlExit>;
  readonly processId: string;
  readonly sessionId: string;
  readonly stream: Duplex;
  close(): Promise<void>;
}

export interface ServerCoreProviderGrokContainerRuntimeOptions {
  readonly browserRelay?: (request: Buffer, signal: AbortSignal) => Promise<Buffer>;
  readonly inference: ServerCoreProviderInferenceUnixHttpPort;
  readonly inferenceTransport?: ProviderSessionInferenceTransport;
  readonly instanceId: string;
  readonly nextLaunchId?: () => string;
  readonly nextProcessId?: () => string;
  readonly onCleanupFailure?: (sessionId: string) => void;
  readonly onInferenceFailure?: (failure: {
    readonly code: string;
    readonly path: string;
  }) => void;
  readonly supervisor: ProviderSessionSupervisorControlPort;
}

interface ActiveSession {
  readonly brokerEndpointId: string;
  readonly channel: ProviderSessionControlChannel;
  readonly launchId: string;
  readonly multiplex: ProviderSessionMultiplexConnection | null;
  readonly processId: string;
  readonly runtimeHandle: string;
  readonly sessionId: string;
  brokerReleased: boolean;
  closePromise: Promise<void> | null;
  stopped: boolean;
}

function binding(instanceId: string, processId: string, sessionId: string) {
  return parseServerCoreProviderInferenceBinding({
    adapterId: ADAPTER_ID,
    instanceId,
    maxConcurrency: 2,
    maxDeadlineMs: PROVIDER_INFERENCE_MAX_DEADLINE_MS,
    maxRequestBytes: PROVIDER_INFERENCE_MAX_REQUEST_BYTES,
    maxResponseBytes: PROVIDER_INFERENCE_MAX_RESPONSE_BYTES,
    method: 'POST',
    paths: UPSTREAM_PATHS,
    processId,
    providerId: PROVIDER_ID,
    sessionId,
    upstreamId: UPSTREAM_ID,
  });
}

function closedError(): Error {
  return new Error('Provider Grok container runtime is closed');
}

/** Core-owned broker/supervisor composition. No host path or credential enters its session API. */
export class ServerCoreProviderGrokContainerRuntime {
  private readonly nextLaunchId: () => string;
  private readonly nextProcessId: () => string;
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly pendingSessions = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private browserRelay: ServerCoreProviderGrokContainerRuntimeOptions['browserRelay'];

  constructor(private readonly options: ServerCoreProviderGrokContainerRuntimeOptions) {
    binding(options.instanceId, 'provider-readiness-probe', 'provider-readiness-probe');
    this.nextLaunchId = options.nextLaunchId ?? randomUUID;
    this.nextProcessId = options.nextProcessId ?? randomUUID;
    this.browserRelay = options.browserRelay;
  }

  setBrowserRelay(
    relay: ServerCoreProviderGrokContainerRuntimeOptions['browserRelay'],
  ): void {
    if (this.sessions.size > 0 || this.pendingSessions.size > 0) {
      throw new Error('Provider Browser relay cannot change while sessions are active');
    }
    this.browserRelay = relay;
  }

  async readiness(): Promise<ServerCoreProviderGrokContainerReadiness> {
    if (this.closed) return Object.freeze({
      available: false,
      disabledReason: 'provider-session-supervisor-unavailable',
      supervisorGeneration: 0,
    });
    let capabilities;
    try {
      capabilities = await this.options.supervisor.capabilities();
    } catch {
      return Object.freeze({
        available: false,
        disabledReason: 'provider-session-supervisor-unavailable',
        supervisorGeneration: 0,
      });
    }
    if (this.closed || !capabilities.available ||
        !capabilities.adapterIds.includes(ADAPTER_ID)) {
      return Object.freeze({
        available: false,
        disabledReason: 'provider-session-supervisor-unavailable',
        supervisorGeneration: capabilities.generation,
      });
    }
    let available = false;
    try {
      available = await this.options.inference.available(binding(
        this.options.instanceId,
        'provider-readiness-probe',
        'provider-readiness-probe',
      ));
    } catch {
      available = false;
    }
    return Object.freeze({
      available: !this.closed && available,
      disabledReason: !this.closed && available
        ? null
        : 'provider-inference-broker-unavailable',
      supervisorGeneration: capabilities.generation,
    });
  }

  async open(
    input: ServerCoreProviderGrokContainerOpenInput,
  ): Promise<ServerCoreProviderGrokContainerSession> {
    if (this.closed) throw closedError();
    const launchId = this.nextLaunchId();
    const processId = this.nextProcessId();
    const provisional = parseProviderSessionLaunchSpec({
      schemaVersion: PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION,
      adapterId: ADAPTER_ID,
      brokerEndpointId: 'provider-endpoint-pending',
      effectiveAccess: input.effectiveAccess,
      launchId,
      processId,
      providerId: PROVIDER_ID,
      resourceClass: 'interactive-v1',
      runtimeId: RUNTIME_ID,
      sessionId: input.sessionId,
      upstreamId: UPSTREAM_ID,
      workingDirectory: input.workingDirectory,
      ...(input.browserContext ? { browserContext: input.browserContext } : {}),
    });
    if (this.sessions.has(provisional.sessionId) ||
        this.pendingSessions.has(provisional.sessionId)) {
      throw new Error('Provider Grok container session identity is already active');
    }
    this.pendingSessions.add(provisional.sessionId);
    const finish = this.beginOperation();
    let endpointId: string | null = null;
    let launched: { readonly runtimeHandle: string } | null = null;
    let channel: ProviderSessionControlChannel | null = null;
    let multiplex: ProviderSessionMultiplexConnection | null = null;
    try {
      await this.assertReady(binding(
        this.options.instanceId,
        provisional.processId,
        provisional.sessionId,
      ));
      if (this.closed) throw closedError();
      const endpoint = await this.options.inference.open(binding(
        this.options.instanceId,
        provisional.processId,
        provisional.sessionId,
      ));
      endpointId = endpoint.endpointId;
      if (this.closed) throw closedError();
      const spec = parseProviderSessionLaunchSpec({
        ...provisional,
        brokerEndpointId: endpoint.endpointId,
      });
      const result = await this.options.supervisor.launch(spec);
      if (result.launchId !== spec.launchId || result.processId !== spec.processId ||
          result.sessionId !== spec.sessionId) {
        throw new Error('Provider Grok container launch identity changed');
      }
      launched = result;
      if (this.closed) throw closedError();
      channel = await this.options.supervisor.attach({
        schemaVersion: PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION,
        processId: result.processId,
        runtimeHandle: result.runtimeHandle,
        sessionId: result.sessionId,
      });
      if (this.closed) throw closedError();
      const stream = this.options.inferenceTransport === 'stdio-multiplex-v1'
        ? (multiplex = new ProviderSessionMultiplexConnection({
          invoke: async (request, signal) => {
            try {
              return await this.options.inference.invoke(endpoint!.endpointId, request, signal);
            } catch (error) {
              try {
                this.options.onInferenceFailure?.({
                  code: error instanceof ServerCoreProviderInferenceError
                    ? error.code
                    : 'unknown',
                  path: request.path,
                });
              } catch {}
              throw error;
            }
          },
          ...(this.browserRelay ? { invokeBrowser: this.browserRelay } : {}),
          role: 'core',
          stream: channel.stream,
        })).acp
        : channel.stream;
      const record: ActiveSession = {
        brokerEndpointId: endpoint.endpointId,
        brokerReleased: false,
        channel,
        closePromise: null,
        launchId: result.launchId,
        multiplex,
        processId: result.processId,
        runtimeHandle: result.runtimeHandle,
        sessionId: result.sessionId,
        stopped: false,
      };
      this.sessions.set(record.sessionId, record);
      void channel.exited.then(() => this.retire(record)).catch(() => {
        try { this.options.onCleanupFailure?.(record.sessionId); } catch {}
      });
      return Object.freeze({
        exited: channel.exited,
        processId: record.processId,
        sessionId: record.sessionId,
        stream,
        close: () => this.retire(record),
      });
    } catch (error) {
      const failures: unknown[] = [error];
      if (multiplex) await multiplex.close().catch((cause) => failures.push(cause));
      if (channel) await channel.close().catch((cause) => failures.push(cause));
      if (launched) {
        await this.options.supervisor.stop({
          schemaVersion: PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION,
          processId: provisional.processId,
          runtimeHandle: launched.runtimeHandle,
          sessionId: provisional.sessionId,
        }).catch((cause) => failures.push(cause));
      }
      if (endpointId) {
        await this.options.inference.release(endpointId).catch((cause) => failures.push(cause));
      }
      if (failures.length === 1) throw error;
      throw new AggregateError(failures, 'Provider Grok container startup cleanup failed');
    } finally {
      this.pendingSessions.delete(provisional.sessionId);
      finish();
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const closing = this.closeOnce();
    this.closePromise = closing;
    void closing.catch(() => {
      if (this.closePromise === closing) this.closePromise = null;
    });
    return closing;
  }

  private async assertReady(value: ServerCoreProviderInferenceBinding): Promise<void> {
    const capabilities = await this.options.supervisor.capabilities();
    if (this.closed || !capabilities.available ||
        !capabilities.adapterIds.includes(ADAPTER_ID)) {
      throw new Error('Provider session supervisor is unavailable for Grok');
    }
    if (!await this.options.inference.available(value)) {
      throw new Error('Provider inference broker is unavailable for Grok');
    }
  }

  private retire(record: ActiveSession): Promise<void> {
    record.closePromise ??= this.retireOnce(record).finally(() => {
      if (!record.stopped || !record.brokerReleased) record.closePromise = null;
    });
    return record.closePromise;
  }

  private async retireOnce(record: ActiveSession): Promise<void> {
    const failures: unknown[] = [];
    await record.multiplex?.close().catch((error) => failures.push(error));
    await record.channel.close().catch((error) => failures.push(error));
    if (!record.stopped) {
      try {
        await this.options.supervisor.stop({
          schemaVersion: PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION,
          processId: record.processId,
          runtimeHandle: record.runtimeHandle,
          sessionId: record.sessionId,
        });
        record.stopped = true;
      } catch (error) {
        failures.push(error);
      }
    }
    if (!record.brokerReleased) {
      try {
        await this.options.inference.release(record.brokerEndpointId);
        record.brokerReleased = true;
      } catch (error) {
        failures.push(error);
      }
    }
    if (record.stopped && record.brokerReleased) this.sessions.delete(record.sessionId);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Provider Grok container cleanup failed');
    }
  }

  private async closeOnce(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.inFlight]);
    const failures: unknown[] = [];
    await Promise.all([...this.sessions.values()].map((record) =>
      this.retire(record).catch((error) => failures.push(error))));
    await Promise.all([
      this.options.supervisor.close().catch((error) => failures.push(error)),
      this.options.inference.close().catch((error) => failures.push(error)),
    ]);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Provider Grok container runtime shutdown failed');
    }
  }

  private beginOperation(): () => void {
    let finish!: () => void;
    const operation = new Promise<void>((resolve) => { finish = resolve; });
    this.inFlight.add(operation);
    return () => {
      this.inFlight.delete(operation);
      finish();
    };
  }
}
