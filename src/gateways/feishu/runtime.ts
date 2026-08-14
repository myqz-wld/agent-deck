import type { JsonValue } from '@contracts/index';
import {
  DEFAULT_GATEWAY_CLOCK,
  FeishuGatewayError,
  FeishuSessionConsoleGateway,
  type FeishuCallbackResult,
  type FeishuGatewayBinding,
  type FeishuGatewayClock,
} from '@gateways/im';
import { boundedFeishuOperation } from './bounded-operation';
import { createFeishuAuditBundle } from './audit';
import {
  feishuDatabasePath,
  loadFeishuProductionConfig,
  withFeishuSecretMaterial,
} from './config';
import { FeishuSdkEventAdapter } from './event-adapter';
import { FeishuLongConnection } from './long-connection';
import { HmacPendingActionNonce } from './nonce';
import type { FeishuActionSecretDisposalPort } from './nonce';
import { FeishuPairingEventHandler } from './pairing-event-handler';
import { createFeishuCoreProbe } from './core-verification';
import { createOfficialFeishuConnectionFactory, createOfficialFeishuOpenApi } from './sdk';
import { FeishuSourceRegistry } from './source-registry';
import { SqliteFeishuGatewayStore } from './sqlite-store';
import { OfficialFeishuTransport } from './transport';
import type {
  FeishuGatewayRuntimePort,
  FeishuProductionConfig,
  FeishuProductionTopology,
  LoadedFeishuRuntimeFactoryOptions,
  FeishuRuntimeFactoryOptions,
} from './types';

type CoreVerificationState = Readonly<{
  state: 'connected' | 'failed' | 'unverified';
  verifiedAt: number | null;
}>;
type ShutdownFailureCode =
  | 'action-secret-disposal-failed'
  | 'connection-close-failed'
  | 'gateway-close-failed'
  | 'gateway-close-timeout'
  | 'metadata-store-close-failed';

export class FeishuProductionRuntimeShutdownError extends AggregateError {
  readonly code = 'lifecycle_failed';
  readonly retryable = true;

  constructor(readonly failureCodes: readonly ShutdownFailureCode[]) {
    super(
      failureCodes.map((code) => new Error(`Feishu shutdown cleanup failed: ${code}`)),
      'Feishu production runtime shutdown failed',
    );
    this.name = 'FeishuProductionRuntimeShutdownError';
  }
}

export class FeishuProductionRuntime implements FeishuGatewayRuntimePort {
  private state: 'idle' | 'starting' | 'running' | 'closing' | 'closed' = 'idle';
  private startPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private persistentCleanupAttempted = false;

  constructor(
    private readonly gateway: FeishuSessionConsoleGateway,
    private readonly events: FeishuSdkEventAdapter,
    private readonly connection: FeishuLongConnection,
    private readonly store: SqliteFeishuGatewayStore,
    private readonly actionSecret: FeishuActionSecretDisposalPort,
    private readonly clock: FeishuGatewayClock,
    private readonly startupTimeoutMs: number,
    private readonly shutdownTimeoutMs: number,
    private readonly coreProbe: () => Promise<JsonValue>,
    private readonly reportFatal: (code: string) => void,
  ) {}

  private coreVerification: CoreVerificationState = Object.freeze({
    state: 'unverified',
    verifiedAt: null,
  });

  start(): Promise<void> {
    if (this.state === 'starting' || this.state === 'running') {
      return this.startPromise ?? Promise.reject(new FeishuGatewayError(
        'lifecycle_failed',
        'Feishu production runtime start state is invalid',
        true,
      ));
    }
    if (this.state === 'closing' || this.state === 'closed') {
      return Promise.reject(new FeishuGatewayError(
        'gateway_closed',
        'Feishu production runtime is closed',
      ));
    }
    this.state = 'starting';
    this.startPromise = this.startOpen();
    return this.startPromise;
  }

  private async startOpen(): Promise<void> {
    try {
      await boundedFeishuOperation(
        this.gateway.start(),
        this.clock,
        this.startupTimeoutMs,
        'Authoritative Core startup exceeded the production bound',
      );
      if (this.state !== 'starting') {
        throw new FeishuGatewayError('gateway_closed', 'Runtime closed during startup');
      }
      await this.connection.start();
      if (this.state !== 'starting') {
        throw new FeishuGatewayError('gateway_closed', 'Runtime closed during startup');
      }
      this.state = 'running';
    } catch {
      try {
        await this.close();
      } catch {
        this.report('startup-cleanup-failed');
      }
      throw new FeishuGatewayError('lifecycle_failed', 'Feishu production runtime failed to start', true);
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.state === 'closed') return Promise.resolve();
    const operation = this.closeOpen();
    this.closePromise = operation;
    void operation.then(
      () => this.clearClosePromise(operation),
      () => this.clearClosePromise(operation),
    );
    return operation;
  }

  private async closeOpen(): Promise<void> {
    this.state = 'closing';
    const failures: ShutdownFailureCode[] = [];
    try {
      try {
        this.connection.close();
      } catch {
        failures.push('connection-close-failed');
      }
      let gatewaySettled = false;
      const gatewayClose = Promise.resolve()
        .then(() => this.gateway.close())
        .then(
          () => { gatewaySettled = true; },
          () => {
            gatewaySettled = true;
            throw new Error('Feishu gateway close failed');
          },
        );
      try {
        await boundedFeishuOperation(
          gatewayClose,
          this.clock,
          this.shutdownTimeoutMs,
          'Feishu gateway shutdown exceeded the production bound',
        );
      } catch {
        failures.push(gatewaySettled ? 'gateway-close-failed' : 'gateway-close-timeout');
      }
      if (gatewaySettled) {
        this.finishPersistentCleanup(failures);
      } else {
        void gatewayClose.then(
          () => this.finishDeferredCleanup(),
          () => this.finishDeferredCleanup(),
        );
      }
    } finally {
      this.state = 'closed';
    }
    if (failures.length > 0) throw new FeishuProductionRuntimeShutdownError(failures);
  }

  private finishPersistentCleanup(failures: ShutdownFailureCode[]): void {
    if (this.persistentCleanupAttempted) return;
    this.persistentCleanupAttempted = true;
    try {
      this.actionSecret.dispose();
    } catch {
      failures.push('action-secret-disposal-failed');
    }
    try {
      this.store.close();
    } catch {
      failures.push('metadata-store-close-failed');
    }
  }

  private finishDeferredCleanup(): void {
    const failures: ShutdownFailureCode[] = [];
    this.finishPersistentCleanup(failures);
    if (failures.length > 0) this.report('deferred-cleanup-failed');
  }

  private clearClosePromise(operation: Promise<void>): void {
    if (this.closePromise === operation) this.closePromise = null;
  }

  handle(raw: unknown): Promise<FeishuCallbackResult> {
    if (this.state !== 'running') {
      return Promise.reject(new FeishuGatewayError('gateway_closed', 'Feishu runtime is not open'));
    }
    return this.events.handle(raw);
  }

  fatal(code: string): void {
    this.report(code);
    void this.close().catch(() => this.report('fatal-cleanup-failed'));
  }

  managementTarget(): SqliteFeishuGatewayStore {
    return this.store;
  }

  coreStatus(): JsonValue {
    return { ...this.coreVerification };
  }

  async verifyCore(): Promise<JsonValue> {
    if (this.state !== 'running') {
      throw new FeishuGatewayError('gateway_closed', 'Feishu runtime is not open');
    }
    try {
      const result = await this.coreProbe();
      const verifiedAt = this.clock.now();
      this.coreVerification = Object.freeze({ state: 'connected', verifiedAt });
      return { ...result as Record<string, JsonValue>, state: 'connected', verifiedAt };
    } catch (error) {
      this.coreVerification = Object.freeze({ state: 'failed', verifiedAt: this.clock.now() });
      throw error;
    }
  }

  private report(code: string): void {
    try {
      this.reportFatal(code);
    } catch {
      // A host callback cannot change the runtime's fail-closed state.
    }
  }
}

function buildRuntime(
  expectedTopology: FeishuProductionTopology,
  options: FeishuRuntimeFactoryOptions,
): FeishuProductionRuntime {
  const config = loadFeishuProductionConfig(options.configPath);
  if (config.topology !== expectedTopology) {
    throw new FeishuGatewayError(
      'invalid_configuration',
      'Feishu config topology does not match the selected runtime factory',
    );
  }
  return buildVerifiedRuntime(config, options);
}

function buildVerifiedRuntime(
  config: FeishuProductionConfig,
  options: LoadedFeishuRuntimeFactoryOptions,
): FeishuProductionRuntime {
  const clock = options.clock ?? DEFAULT_GATEWAY_CLOCK;
  const binding: FeishuGatewayBinding = {
    appId: config.appId,
    tenantKey: config.tenantKey,
    instanceId: config.instanceId,
    topology: config.topology,
  };
  return withFeishuSecretMaterial(config, (appSecret, actionSecret) =>
    buildWithSecrets(config, options, binding, clock, appSecret, actionSecret));
}

function buildWithSecrets(
  config: FeishuProductionConfig,
  options: LoadedFeishuRuntimeFactoryOptions,
  binding: FeishuGatewayBinding,
  clock: FeishuGatewayClock,
  appSecret: string,
  actionSecret: Uint8Array,
): FeishuProductionRuntime {
  let store: SqliteFeishuGatewayStore | null = null;
  let nonce: HmacPendingActionNonce | null = null;
  try {
    store = new SqliteFeishuGatewayStore(feishuDatabasePath(config), binding);
    store.reconcileCredentials(config.credentials);
    const audit = createFeishuAuditBundle(binding, clock, options.auditSink);
    const sources = new FeishuSourceRegistry();
    const api = createOfficialFeishuOpenApi(config.appId, appSecret, audit.sdkLogger);
    nonce = new HmacPendingActionNonce(actionSecret, {
      now: () => clock.now(),
      defaultLifetimeMs: config.pendingPresentationLifetimeMs,
    });
    const transport = new OfficialFeishuTransport(binding, api, sources, nonce);
    const pairing = new FeishuPairingEventHandler(
      store,
      transport,
      binding,
      clock,
      audit,
      config.callbackWindowMs,
    );
    const gateway = new FeishuSessionConsoleGateway({
      appVersion: options.appVersion,
      binding,
      store,
      clientFactory: options.clientFactory,
      transport,
      nonce,
      audit: audit.audit,
      observer: audit.observer,
      clock,
      callbackWindowMs: config.callbackWindowMs,
      pendingPresentationLifetimeMs: config.pendingPresentationLifetimeMs,
    });
    const events = new FeishuSdkEventAdapter(
      gateway,
      { appId: config.appId, tenantKey: config.tenantKey, now: () => clock.now() },
      sources,
      audit,
      pairing,
    );
    let runtime: FeishuProductionRuntime | null = null;
    const connection = new FeishuLongConnection({
      instanceId: config.instanceId,
      factory: createOfficialFeishuConnectionFactory(
        config.appId,
        appSecret,
        audit.sdkLogger,
        config.handshakeTimeoutMs,
        config.pingTimeoutSeconds,
      ),
      handlers: events,
      health: store,
      clock,
      audit,
      startupTimeoutMs: config.startupTimeoutMs,
      reconnectTimeoutMs: config.reconnectTimeoutMs,
      onFatal: (code) => runtime?.fatal(code),
    });
    runtime = new FeishuProductionRuntime(
      gateway,
      events,
      connection,
      store,
      nonce,
      clock,
      config.startupTimeoutMs,
      config.shutdownTimeoutMs,
      createFeishuCoreProbe(config, options, clock),
      options.onFatal ?? (() => undefined),
    );
    return runtime;
  } catch (error) {
    try {
      nonce?.dispose();
    } catch {
      // Construction rollback continues to the metadata store.
    }
    try {
      store?.close();
    } catch {
      // The fixed construction failure below remains authoritative.
    }
    if (error instanceof FeishuGatewayError) throw error;
    throw new FeishuGatewayError(
      'invalid_configuration',
      'Feishu production dependency could not be initialized',
    );
  }
}

export function createServerCoreFeishuRuntime(
  options: FeishuRuntimeFactoryOptions,
): FeishuProductionRuntime {
  return buildRuntime('full', options);
}

export function createRelayFeishuRuntime(
  options: FeishuRuntimeFactoryOptions,
): FeishuProductionRuntime {
  return buildRuntime('relay', options);
}

export function createLoadedFeishuRuntime(
  config: FeishuProductionConfig,
  options: LoadedFeishuRuntimeFactoryOptions,
): FeishuProductionRuntime {
  if (config.topology !== 'full' && config.topology !== 'relay') {
    throw new FeishuGatewayError(
      'invalid_configuration',
      'Feishu config topology is invalid',
    );
  }
  return buildVerifiedRuntime(config, options);
}
