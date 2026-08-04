import { createHash } from 'node:crypto';
import {
  AgentDeckClientErrorCode,
  CORE_METHOD_METADATA,
  isCoreMethodAllowed,
  AccessSurface,
  type CoreMethod,
  type HostHello,
} from '@contracts/index';
import { CURRENT_PROTOCOL_VERSION } from '@protocol/version';
import { coreRevision } from './core-output';
import { FeishuGatewayError, FeishuGatewayLifecycleError } from './errors';
import { validateHostHello } from './host-hello';
import { validateCoreNotificationEvent } from './subscription-events';
import type {
  ConnectedFeishuClient,
  EnrolledFeishuCredential,
  FeishuAgentDeckClientFactory,
  FeishuGatewayStore,
  NotificationEvent,
} from './types';

function updateLengthPrefixed(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  hash.update(length);
  hash.update(bytes);
}

export function feishuClientId(credential: EnrolledFeishuCredential, chatId: string): string {
  const hash = createHash('sha256');
  for (const component of [
    credential.appId, credential.tenantKey, credential.openId, credential.instanceId,
    credential.credentialId, chatId,
  ]) updateLengthPrefixed(hash, component);
  return `feishu-${hash.digest('base64url')}`;
}

export function assertFeishuMethod(hello: HostHello, method: string): asserts method is CoreMethod {
  if (!isCoreMethodAllowed(AccessSurface.FeishuSessionConsole, method)) {
    throw new FeishuGatewayError(
      AgentDeckClientErrorCode.AccessDenied,
      `Method is outside the fixed Feishu session-console surface: ${method}`,
    );
  }
  const capability = CORE_METHOD_METADATA[method].capability;
  if (!hello.capabilities.includes(capability)) {
    throw new FeishuGatewayError(
      AgentDeckClientErrorCode.CapabilityUnavailable,
      `Core does not advertise ${capability}`,
    );
  }
}

interface PoolEntry {
  key: string;
  epoch: number;
  credential: EnrolledFeishuCredential;
  chatId: string;
  terminal: boolean;
  ready: boolean;
  connection: Promise<ConnectedFeishuClient>;
  retirement: Promise<void> | null;
  streamBarrier: Promise<void> | null;
  closeBarrier: Promise<void> | null;
}

export class FeishuClientPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly epochs = new Map<string, number>();
  private closed = false;

  constructor(
    private readonly appVersion: string,
    private readonly factory: FeishuAgentDeckClientFactory,
    private readonly store: FeishuGatewayStore,
    private readonly now: () => number,
    private readonly maximumClients: number,
    private readonly prepareStream: (
      credential: EnrolledFeishuCredential,
      chatId: string,
      epoch: number,
    ) => boolean,
    private readonly activateStream: (
      credential: EnrolledFeishuCredential,
      chatId: string,
      epoch: number,
    ) => boolean,
    private readonly startStream: (
      credential: EnrolledFeishuCredential,
      chatId: string,
      epoch: number,
    ) => void,
    private readonly onEvent: (
      credential: EnrolledFeishuCredential,
      chatId: string,
      epoch: number,
      event: NotificationEvent,
    ) => boolean,
    private readonly onObserverError: (code: string, operation: string) => void,
    /** Must synchronously fence the epoch before returning its idle barrier. */
    private readonly retireStream: (
      credential: EnrolledFeishuCredential,
      chatId: string,
      epoch: number,
    ) => Promise<void>,
  ) {}

  private key(credential: EnrolledFeishuCredential, chatId: string): string {
    return `${credential.instanceId}\u001f${credential.credentialId}\u001f${chatId}`;
  }

  async get(credential: EnrolledFeishuCredential, chatId: string): Promise<ConnectedFeishuClient> {
    const key = this.key(credential, chatId);
    for (;;) {
      this.assertOpen();
      const existing = this.entries.get(key);
      if (existing) {
        if (existing.retirement) {
          await existing.retirement;
          continue;
        }
        return existing.connection;
      }
      if (this.entries.size >= this.maximumClients) {
        throw new FeishuGatewayError(
          'subscription_limit_exceeded',
          'Concurrent Feishu chat client limit reached',
        );
      }
      const epoch = (this.epochs.get(key) ?? 0) + 1;
      this.epochs.set(key, epoch);
      let resolveConnection!: (connected: ConnectedFeishuClient) => void;
      let rejectConnection!: (error: unknown) => void;
      const connection = new Promise<ConnectedFeishuClient>((resolve, reject) => {
        resolveConnection = resolve;
        rejectConnection = reject;
      });
      const entry = {
        key, epoch, credential: { ...credential }, chatId, terminal: false, ready: false,
        connection,
        retirement: null, streamBarrier: null, closeBarrier: null,
      } satisfies PoolEntry;
      this.entries.set(key, entry);
      void this.connect(entry).then((connected) => {
        resolveConnection(connected);
        if (this.isCurrent(entry)) this.startStream(credential, chatId, epoch);
      }, (error) => {
        if (this.entries.get(key) === entry && !entry.retirement) this.entries.delete(key);
        rejectConnection(error);
      });
      return entry.connection;
    }
  }

  private async connect(entry: PoolEntry): Promise<ConnectedFeishuClient> {
    const { credential, chatId } = entry;
    const clientId = feishuClientId(credential, chatId);
    const client = this.factory({
      instanceId: credential.instanceId,
      credentialId: credential.credentialId,
      clientId,
      topology: credential.topology,
    });
    let subscription: ConnectedFeishuClient['subscription'] = null;
    try {
      const persisted = this.store.getCursor(
        credential.instanceId, credential.credentialId, chatId,
      );
      const cursorRevision = persisted ? coreRevision(persisted.revision, 'cursor.revision') : null;
      const rawHello = await client.connect({
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        appVersion: this.appVersion,
        clientId,
        requestedTopology: credential.topology,
        ...(cursorRevision === null ? {} : { lastEventRevision: cursorRevision }),
      });
      this.assertCurrent(entry);
      const hello = validateHostHello(rawHello, credential, clientId);
      const helloRevision = coreRevision(hello.eventRevision, 'hello.eventRevision');
      if (cursorRevision !== null && helloRevision < cursorRevision) {
        throw new FeishuGatewayError(
          'invalid_core_response',
          'Core hello revision regressed behind the persisted chat cursor',
        );
      }
      if (cursorRevision === null) {
        this.store.putCursor({
          instanceId: credential.instanceId,
          credentialId: credential.credentialId,
          chatId,
          revision: helloRevision,
          updatedAt: this.now(),
        });
      }
      this.assertCurrent(entry);
      if (!this.prepareStream(credential, chatId, entry.epoch)) {
        throw new FeishuGatewayError('subscription_failed', 'Notification lane admission failed', true);
      }
      let lastObservedRevision = cursorRevision ?? helloRevision;
      try {
        subscription = client.subscribe(lastObservedRevision, (event) => {
          if (!this.isCurrent(entry)) return;
          try {
            const validated = validateCoreNotificationEvent(event, credential, lastObservedRevision);
            if (!this.onEvent(credential, chatId, entry.epoch, validated)) {
              this.terminalize(entry);
              if (entry.ready) void this.retireEntry(entry).catch(() => {
                this.onObserverError('lifecycle_failed', 'core-event-retire');
              });
              return;
            }
            lastObservedRevision = validated.revision;
          } catch (error) {
            this.terminalize(entry);
            this.onObserverError(
              error instanceof FeishuGatewayError ? error.code : 'invalid_core_event',
              'core-event',
            );
            if (entry.ready) void this.retireEntry(entry).catch(() => {
              this.onObserverError('lifecycle_failed', 'core-event-retire');
            });
          }
        });
      } catch (error) {
        this.terminalize(entry);
        this.onObserverError('subscription_failed', 'core-event-subscribe');
        throw new FeishuGatewayError(
          'subscription_failed',
          'Core event subscription could not be attached',
          true,
          undefined,
          { cause: error },
        );
      }
      if (entry.terminal) {
        throw new FeishuGatewayError(
          'invalid_core_event',
          'Core event stream faulted during subscription attachment',
          true,
        );
      }
      if (!this.activateStream(credential, chatId, entry.epoch)) {
        this.terminalize(entry);
        throw new FeishuGatewayError(
          'subscription_failed',
          'Notification lane activation failed',
          true,
        );
      }
      const connected = { client, hello, subscription };
      entry.ready = true;
      return connected;
    } catch (error) {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => subscription?.close()),
        Promise.resolve().then(() => client.close()),
        entry.streamBarrier ?? Promise.resolve(),
      ]);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (failures.length > 0) throw new FeishuGatewayLifecycleError([error, ...failures], 'start');
      throw error;
    }
  }

  async retire(credential: EnrolledFeishuCredential, chatId: string): Promise<void> {
    const entry = this.entries.get(this.key(credential, chatId));
    if (entry) await this.retireEntry(entry);
  }

  async retireGeneration(
    credential: EnrolledFeishuCredential,
    chatId: string,
    epoch: number,
  ): Promise<void> {
    const entry = this.entries.get(this.key(credential, chatId));
    if (entry?.epoch === epoch) await this.retireEntry(entry);
  }

  private terminalize(entry: PoolEntry): void {
    if (entry.terminal) return;
    entry.terminal = true;
    try {
      entry.streamBarrier = this.retireStream(entry.credential, entry.chatId, entry.epoch);
    } catch (error) {
      entry.streamBarrier = Promise.reject(error);
    }
  }

  private retireEntry(entry: PoolEntry): Promise<void> {
    this.terminalize(entry);
    if (entry.retirement) return entry.retirement;
    entry.retirement = (async () => {
      const results = await Promise.allSettled([
        entry.streamBarrier ?? Promise.resolve(),
        this.closeEntry(entry),
      ]);
      if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (failures.length > 0) throw new FeishuGatewayLifecycleError(failures, 'close');
    })();
    return entry.retirement;
  }

  private closeEntry(entry: PoolEntry): Promise<void> {
    if (entry.closeBarrier) return entry.closeBarrier;
    entry.closeBarrier = entry.connection.then(async (connected) => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => connected.subscription?.close()),
        Promise.resolve().then(() => connected.client.close()),
      ]);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (failures.length > 0) throw new FeishuGatewayLifecycleError(failures, 'close');
    }, () => undefined);
    return entry.closeBarrier;
  }

  async close(): Promise<void> {
    this.closed = true;
    const results = await Promise.allSettled([...this.entries.values()].map((entry) => this.retireEntry(entry)));
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) throw new FeishuGatewayLifecycleError(failures, 'close');
  }

  private assertCurrent(entry: PoolEntry): void {
    if (!this.isCurrent(entry)) {
      throw new FeishuGatewayError('gateway_closed', 'Feishu client generation is retired', true);
    }
  }

  private isCurrent(entry: PoolEntry): boolean {
    return !this.closed && !entry.terminal && this.entries.get(entry.key) === entry;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new FeishuGatewayError('gateway_closed', 'Feishu client pool is closed', true);
    }
  }
}
