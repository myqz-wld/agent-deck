import {
  AgentDeckClientErrorCode,
  type AuthenticatedClientAccessContext,
} from '@contracts/index';

import { DaemonRequestError } from './types';

export type DaemonClientAccessSurface = AuthenticatedClientAccessContext['surface'];

export interface DaemonCredentialIdentity {
  readonly instanceId: string;
  readonly processId: string;
  readonly accessCredentialId: string;
  readonly accessSurface: DaemonClientAccessSurface;
}

export interface DaemonCredentialActiveCheck {
  readonly identity: DaemonCredentialIdentity;
  readonly signal: AbortSignal;
}

export interface DaemonCredentialRevocationSubscription {
  close(): Promise<void> | void;
}

/** Required authoritative runtime boundary for live Server Core credential state. */
export interface DaemonCredentialLifecyclePort {
  isActive(input: DaemonCredentialActiveCheck): Promise<boolean> | boolean;
  subscribeRevocations(
    onRevoked: (identity: DaemonCredentialIdentity) => void,
  ): Promise<DaemonCredentialRevocationSubscription> | DaemonCredentialRevocationSubscription;
}

export interface DaemonCredentialIndexedConnection {
  revokeCredential(): void;
}

export interface DaemonCredentialRegistryOptions {
  readonly instanceId: string;
  readonly processId: string;
  readonly lifecycle: DaemonCredentialLifecyclePort;
  readonly checkTimeoutMs: number;
}

const MAX_CREDENTIAL_CHECK_TIMEOUT_MS = 30_000;

function revoked(): DaemonRequestError {
  return new DaemonRequestError(
    AgentDeckClientErrorCode.Revoked,
    'Access credential is revoked or unavailable',
  );
}

function identityKey(identity: DaemonCredentialIdentity): string {
  return JSON.stringify([
    identity.instanceId,
    identity.processId,
    identity.accessCredentialId,
    identity.accessSurface,
  ]);
}

function validIdentity(identity: unknown): identity is DaemonCredentialIdentity {
  return (
    typeof identity === 'object' && identity !== null &&
    'instanceId' in identity &&
    typeof identity.instanceId === 'string' &&
    'processId' in identity &&
    typeof identity.processId === 'string' &&
    'accessCredentialId' in identity &&
    typeof identity.accessCredentialId === 'string' &&
    identity.accessCredentialId.length > 0 &&
    'accessSurface' in identity &&
    (identity.accessSurface === 'desktop-full' ||
      identity.accessSurface === 'feishu-session-console')
  );
}

export class DaemonCredentialRegistry {
  private readonly indexed = new Map<string, Set<DaemonCredentialIndexedConnection>>();
  private readonly reverse = new Map<DaemonCredentialIndexedConnection, string>();
  private readonly revokedKeys = new Set<string>();
  private readonly activeChecks = new Map<string, Set<AbortController>>();
  private subscription: DaemonCredentialRevocationSubscription | null = null;
  private startOperation: Promise<void> | null = null;
  private active = false;
  private generation = 0;

  constructor(private readonly options: DaemonCredentialRegistryOptions) {
    if (
      !options.instanceId || !options.processId ||
      !Number.isSafeInteger(options.checkTimeoutMs) || options.checkTimeoutMs <= 0 ||
      options.checkTimeoutMs > MAX_CREDENTIAL_CHECK_TIMEOUT_MS
    ) {
      throw new RangeError('daemon credential registry options are invalid');
    }
  }

  start(): Promise<void> {
    if (this.active) return this.startOperation ?? Promise.resolve();
    if (this.startOperation) return this.startOperation;
    const generation = ++this.generation;
    this.active = true;
    const operation = this.startSubscription(generation).finally(() => {
      if (this.startOperation === operation) this.startOperation = null;
    });
    this.startOperation = operation;
    return operation;
  }

  private async startSubscription(generation: number): Promise<void> {
    try {
      const subscription = await this.options.lifecycle.subscribeRevocations((identity) => {
        if (!this.active || this.generation !== generation) return;
        this.handleRevocation(identity);
      });
      if (!subscription || typeof subscription.close !== 'function') {
        throw new Error('credential revocation subscription is invalid');
      }
      if (!this.active || this.generation !== generation) {
        await subscription.close();
        throw new Error('credential revocation subscription became stale');
      }
      this.subscription = subscription;
    } catch (error) {
      this.active = false;
      this.generation += 1;
      for (const checks of this.activeChecks.values()) {
        for (const controller of checks) controller.abort('credential-registry-start-failed');
      }
      this.activeChecks.clear();
      this.indexed.clear();
      this.reverse.clear();
      this.revokedKeys.clear();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.active && !this.subscription && !this.startOperation) return;
    this.active = false;
    this.generation += 1;
    for (const checks of this.activeChecks.values()) {
      for (const controller of checks) controller.abort('credential-registry-stopped');
    }
    this.activeChecks.clear();
    this.indexed.clear();
    this.reverse.clear();
    this.revokedKeys.clear();
    const startOperation = this.startOperation;
    if (startOperation) {
      try { await startOperation; } catch {}
    }
    const subscription = this.subscription;
    this.subscription = null;
    if (subscription) await subscription.close();
  }

  identity(
    accessCredentialId: string,
    accessSurface: DaemonClientAccessSurface,
  ): DaemonCredentialIdentity {
    return Object.freeze({
      instanceId: this.options.instanceId,
      processId: this.options.processId,
      accessCredentialId,
      accessSurface,
    });
  }

  async assertActive(
    accessCredentialId: string,
    accessSurface: DaemonClientAccessSurface,
    parentSignal?: AbortSignal,
  ): Promise<void> {
    const generation = this.generation;
    if (!this.active) throw revoked();
    const identity = this.identity(accessCredentialId, accessSurface);
    const key = identityKey(identity);
    if (this.revokedKeys.has(key)) throw revoked();

    const controller = new AbortController();
    let checks = this.activeChecks.get(key);
    if (!checks) {
      checks = new Set();
      this.activeChecks.set(key, checks);
    }
    checks.add(controller);
    const onParentAbort = (): void => controller.abort('credential-check-cancelled');
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    if (parentSignal?.aborted) onParentAbort();

    let timer: NodeJS.Timeout | null = null;
    const inactive = Symbol('inactive');
    const aborted = new Promise<typeof inactive>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve(inactive), { once: true });
    });
    const timeout = new Promise<typeof inactive>((resolve) => {
      timer = setTimeout(() => {
        controller.abort('credential-check-timeout');
        resolve(inactive);
      }, this.options.checkTimeoutMs);
      timer.unref();
    });
    const checked = Promise.resolve()
      .then(() => this.options.lifecycle.isActive({ identity, signal: controller.signal }))
      .then((value) => value === true ? true : inactive, () => inactive);

    try {
      const result = await Promise.race([checked, aborted, timeout]);
      if (
        result !== true || !this.active || this.generation !== generation ||
        this.revokedKeys.has(key)
      ) {
        throw revoked();
      }
    } finally {
      if (timer) clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
      checks.delete(controller);
      if (checks.size === 0) this.activeChecks.delete(key);
    }
  }

  register(
    connection: DaemonCredentialIndexedConnection,
    access: AuthenticatedClientAccessContext,
  ): void {
    const key = identityKey(this.identity(access.accessCredentialId, access.surface));
    if (!this.active || this.revokedKeys.has(key)) throw revoked();
    const previous = this.reverse.get(connection);
    if (previous && previous !== key) throw revoked();
    let connections = this.indexed.get(key);
    if (!connections) {
      connections = new Set();
      this.indexed.set(key, connections);
    }
    connections.add(connection);
    this.reverse.set(connection, key);
  }

  unregister(connection: DaemonCredentialIndexedConnection): void {
    const key = this.reverse.get(connection);
    if (!key) return;
    this.reverse.delete(connection);
    const connections = this.indexed.get(key);
    connections?.delete(connection);
    if (connections?.size === 0) this.indexed.delete(key);
  }

  private handleRevocation(identity: DaemonCredentialIdentity): void {
    if (
      !validIdentity(identity) ||
      identity.instanceId !== this.options.instanceId ||
      identity.processId !== this.options.processId
    ) return;
    const key = identityKey(identity);
    this.revokedKeys.add(key);
    for (const controller of this.activeChecks.get(key) ?? []) {
      controller.abort('credential-revoked');
    }
    for (const connection of [...(this.indexed.get(key) ?? [])]) {
      try { connection.revokeCredential(); } catch {}
    }
  }
}
