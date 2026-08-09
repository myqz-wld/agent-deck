import { FeishuGatewayError, type FeishuGatewayClock } from '@gateways/im';
import { validateFeishuConnectionHealth } from './health';
import type {
  FeishuAuditBundle,
  FeishuHealthStore,
  FeishuSdkConnectionFactory,
  FeishuSdkConnectionPort,
  FeishuSdkEventHandlers,
} from './types';

interface FeishuLongConnectionOptions {
  instanceId: string;
  factory: FeishuSdkConnectionFactory;
  handlers: FeishuSdkEventHandlers;
  health: FeishuHealthStore;
  clock: FeishuGatewayClock;
  audit: FeishuAuditBundle;
  startupTimeoutMs: number;
  reconnectTimeoutMs: number;
  onFatal(code: string): void;
}

type Timer = ReturnType<FeishuGatewayClock['setTimer']>;

export class FeishuLongConnection {
  private connection: FeishuSdkConnectionPort | null = null;
  private startupTimer: Timer | null = null;
  private reconnectTimer: Timer | null = null;
  private state: 'idle' | 'starting' | 'connected' | 'reconnecting' | 'failed' | 'stopped' = 'idle';
  private generation: number;
  private reconnectAttempts = 0;
  private startPromise: Promise<void> | null = null;
  private resolveStart: (() => void) | null = null;
  private rejectStart: ((error: Error) => void) | null = null;
  private fatalReported = false;

  constructor(private readonly options: FeishuLongConnectionOptions) {
    let persisted;
    try {
      persisted = validateFeishuConnectionHealth(
        options.health.getHealth(options.instanceId),
        options.instanceId,
      );
    } catch (error) {
      if (error instanceof FeishuGatewayError) throw error;
      throw new FeishuGatewayError(
        'invalid_configuration',
        'Persisted Feishu connection health could not be read',
      );
    }
    if (
      persisted?.generation === Number.MAX_SAFE_INTEGER ||
      persisted?.reconnectAttempts === Number.MAX_SAFE_INTEGER
    ) {
      throw new FeishuGatewayError(
        'invalid_configuration',
        'Persisted Feishu connection health counters are exhausted',
      );
    }
    this.generation = persisted?.generation ?? 0;
    this.reconnectAttempts = persisted?.reconnectAttempts ?? 0;
  }

  start(): Promise<void> {
    if (['starting', 'connected', 'reconnecting'].includes(this.state)) {
      return this.startPromise ?? Promise.reject(this.error('Long connection start state is invalid'));
    }
    if (this.state !== 'idle') return Promise.reject(this.error('Long connection cannot restart'));
    this.state = 'starting';
    this.startPromise = new Promise<void>((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });
    if (!this.persist('starting', null)) {
      this.fail('health-store-error');
      return this.startPromise;
    }
    try {
      this.connection = this.options.factory({
        onReady: () => this.ready(),
        onError: () => this.fail('sdk-terminal-error'),
        onReconnecting: () => this.reconnecting(),
        onReconnected: () => this.reconnected(),
      });
    } catch {
      this.fail('sdk-construction-error');
      return this.startPromise;
    }
    this.startupTimer = this.options.clock.setTimer(
      () => this.fail('startup-timeout'),
      this.options.startupTimeoutMs,
    );
    try {
      const result = this.connection.start(this.options.handlers);
      void Promise.resolve(result).catch(() => this.fail('sdk-start-error'));
    } catch {
      this.fail('sdk-start-error');
    }
    return this.startPromise;
  }

  close(): void {
    if (this.state === 'stopped') return;
    const preserveFailure = this.state === 'failed';
    let cleanupFailed = false;
    this.state = 'stopped';
    this.cancelTimers();
    if (this.rejectStart) this.rejectStart(this.error('Long connection stopped during startup'));
    this.clearStartSettlement();
    try {
      this.connection?.close(true);
    } catch {
      cleanupFailed = true;
      try {
        this.options.audit.runtime('connection-close', 'retryable-failure', 'sdk-close-error');
      } catch {
        // The fixed cleanup result remains authoritative.
      }
    }
    if (!preserveFailure && !this.persist('stopped', null)) cleanupFailed = true;
    if (cleanupFailed) {
      throw new FeishuGatewayError(
        'lifecycle_failed',
        'Feishu long connection cleanup failed',
        true,
      );
    }
  }

  private ready(): void {
    if (this.state !== 'starting') return;
    this.startupTimer?.cancel();
    this.startupTimer = null;
    if (!this.incrementGeneration()) return;
    this.state = 'connected';
    this.reconnectAttempts = 0;
    if (!this.persist('connected', null)) {
      this.fail('health-store-error');
      return;
    }
    this.options.audit.runtime('connection-start', 'accepted', 'connected');
    this.resolveStart?.();
    this.clearStartSettlement();
  }

  private reconnecting(): void {
    if (this.state !== 'connected' && this.state !== 'reconnecting') return;
    if (this.reconnectAttempts >= Number.MAX_SAFE_INTEGER) {
      this.fail('health-counter-overflow');
      return;
    }
    this.state = 'reconnecting';
    this.reconnectAttempts += 1;
    if (!this.persist('reconnecting', null)) {
      this.fail('health-store-error');
      return;
    }
    this.options.audit.runtime('connection-reconnect', 'retryable-failure', 'reconnecting');
    if (!this.reconnectTimer) {
      this.reconnectTimer = this.options.clock.setTimer(
        () => this.fail('reconnect-timeout'),
        this.options.reconnectTimeoutMs,
      );
    }
  }

  private reconnected(): void {
    if (this.state !== 'reconnecting') return;
    this.reconnectTimer?.cancel();
    this.reconnectTimer = null;
    if (!this.incrementGeneration()) return;
    this.state = 'connected';
    if (!this.persist('connected', null)) {
      this.fail('health-store-error');
      return;
    }
    this.options.audit.runtime('connection-reconnect', 'accepted', 'reconnected');
  }

  private fail(code: string): void {
    if (this.state === 'failed' || this.state === 'stopped') return;
    this.state = 'failed';
    this.cancelTimers();
    try {
      this.connection?.close(true);
    } catch {
      // The terminal state and fixed audit code are authoritative.
    }
    this.persist('failed', code);
    try {
      this.options.audit.runtime('connection-lifecycle', 'retryable-failure', code);
    } catch {
      // Audit cleanup cannot replace the authoritative terminal cause.
    }
    this.rejectStart?.(this.error('Feishu long connection failed'));
    this.clearStartSettlement();
    if (!this.fatalReported) {
      this.fatalReported = true;
      try {
        this.options.onFatal(code);
      } catch {
        // The runtime is already terminal and the external callback is untrusted.
      }
    }
  }

  private incrementGeneration(): boolean {
    if (this.generation >= Number.MAX_SAFE_INTEGER) {
      this.fail('health-counter-overflow');
      return false;
    }
    this.generation += 1;
    return true;
  }

  private persist(
    state: 'connected' | 'failed' | 'reconnecting' | 'starting' | 'stopped',
    lastErrorCode: string | null,
  ): boolean {
    try {
      this.options.health.putHealth({
        instanceId: this.options.instanceId,
        state,
        generation: this.generation,
        reconnectAttempts: this.reconnectAttempts,
        lastErrorCode,
        updatedAt: this.options.clock.now(),
      });
      return true;
    } catch {
      try {
        this.options.audit.runtime('connection-health', 'retryable-failure', 'health-store-error');
      } catch {
        // The fixed health-store result remains authoritative.
      }
      return false;
    }
  }

  private cancelTimers(): void {
    this.startupTimer?.cancel();
    this.reconnectTimer?.cancel();
    this.startupTimer = null;
    this.reconnectTimer = null;
  }

  private clearStartSettlement(): void {
    this.resolveStart = null;
    this.rejectStart = null;
  }

  private error(message: string): FeishuGatewayError {
    return new FeishuGatewayError('lifecycle_failed', message, true);
  }
}
