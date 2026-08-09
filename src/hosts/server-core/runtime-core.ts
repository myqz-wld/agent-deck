import { createHash } from 'node:crypto';

import {
  AgentDeckClientErrorCode,
  isJsonObject,
  isJsonValue,
  type AgentDeckEventEnvelope,
  type CoreMethod,
  type JsonObject,
  type JsonValue,
} from '@contracts/index';
import {
  DaemonRequestError,
  type DaemonCoreRuntime,
  type DaemonEventSubscription,
  type DaemonEventSubscriptionInput,
  type DaemonRequestInput,
  type DaemonRequestResult,
} from '@hosts/daemon';
import type { AgentAdapter } from '@main/adapters/types';
import type { StoredAgentEvent, SessionRecord } from '@shared/types';
import {
  applyServerCoreRuntimePatch,
  serverCoreRuntimeValues,
} from './runtime-controls';
import {
  listServerCorePendingRequests,
  respondToServerCorePending,
} from './runtime-pending';
import type {
  ServerCoreChangeRecord,
  ServerCoreMutationClaim,
  ServerCoreMutationIdentity,
} from './runtime-metadata-store';
import type { ServerCoreMcpPresentationPort } from './mcp-presentation-port';
import {
  canonicalJson,
  historyCursor,
  parseEmptyParams,
  parseHistoryParams,
  parsePendingResponseParams,
  parseRuntimeUpdateParams,
  parseSendParams,
  parseSessionTargetParams,
  parseSteerParams,
  parseSubscriptionParams,
} from './runtime-validation';

const HISTORY_CONTENT_BYTES = 8 * 1024;

export const SERVER_CORE_BASE_METHODS = Object.freeze([
  'pending.list',
  'pending.respond',
  'session.history',
  'session.interrupt',
  'session.runtime.get',
  'session.runtime.update',
  'session.send',
  'session.steer',
  'subscription.set',
  'system.health',
] as const satisfies readonly CoreMethod[]);

export interface ServerCoreRuntimeRepositoryPort {
  get(sessionId: string): SessionRecord | null;
}

export interface ServerCoreRuntimeEventRepositoryPort {
  listValidForSession(sessionId: string, limit: number, offset: number): StoredAgentEvent[];
  countForSession(sessionId: string): number;
}

export interface ServerCoreRuntimeRegistryPort {
  get(adapterId: string): AgentAdapter | undefined;
}

export interface ServerCoreRuntimeMetadataPort {
  currentRevision(): number;
  appendChange(kind: string, entityId: string | null, payload: JsonValue): number;
  replay(afterRevision: number): ServerCoreChangeRecord[];
  subscribe(listener: (change: ServerCoreChangeRecord) => void): () => void;
  claimMutation(
    identity: ServerCoreMutationIdentity,
    now?: number,
    expectedRevision?: number,
  ): ServerCoreMutationClaim;
  completeMutation(
    identity: ServerCoreMutationIdentity,
    result: JsonValue,
    revision: number,
  ): void;
  setSubscribed(
    accessCredentialId: string,
    accessSurface: 'desktop-full' | 'feishu-session-console',
    sessionId: string,
    subscribed: boolean,
  ): void;
}

export interface ServerCoreRuntimeLifecyclePort {
  start(): Promise<void>;
  stop(reason: string): Promise<void>;
}

export interface ServerCoreDaemonRuntimeOptions {
  readonly instanceId: string;
  readonly repository: ServerCoreRuntimeRepositoryPort;
  readonly events: ServerCoreRuntimeEventRepositoryPort;
  readonly registry: ServerCoreRuntimeRegistryPort;
  readonly metadata: ServerCoreRuntimeMetadataPort;
  readonly lifecycle: ServerCoreRuntimeLifecyclePort;
  readonly presentations: Pick<ServerCoreMcpPresentationPort, 'list' | 'respond'>;
}

function clipped(value: string): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= HISTORY_CONTENT_BYTES) return value;
  return `${bytes.subarray(0, HISTORY_CONTENT_BYTES).toString('utf8')}…`;
}

function historyEntry(event: StoredAgentEvent): JsonObject {
  const payload = isJsonObject(event.payload) ? event.payload : null;
  const role = payload && ['assistant', 'system', 'user'].includes(String(payload.role))
    ? String(payload.role)
    : 'system';
  let content: JsonValue;
  if (payload && typeof payload.text === 'string') content = clipped(payload.text);
  else if (isJsonValue(event.payload)) content = clipped(canonicalJson(event.payload));
  else content = '[event unavailable]';
  return {
    id: `event-${event.id}`,
    sessionId: event.sessionId,
    sequence: event.id,
    role,
    content,
    createdAt: event.ts,
  };
}

function mutationError(claim: ServerCoreMutationClaim): DaemonRequestResult | null {
  if (claim.state === 'claimed') return null;
  if (claim.state === 'conflict') {
    throw new DaemonRequestError(
      AgentDeckClientErrorCode.Conflict,
      'Mutation revision or idempotency does not match',
    );
  }
  if (claim.state === 'uncertain') {
    throw new DaemonRequestError(
      AgentDeckClientErrorCode.ProviderLost,
      'The earlier mutation outcome is uncertain',
    );
  }
  if (!isJsonValue(claim.result)) throw new Error('Stored mutation result is invalid');
  return { result: claim.result, revision: claim.revision };
}

/** Authoritative non-cwd Core methods with durable revision, replay, and mutation fencing. */
export class ServerCoreDaemonRuntime implements DaemonCoreRuntime {
  readonly supportedMethods = SERVER_CORE_BASE_METHODS;
  private state: 'idle' | 'running' | 'stopped' = 'idle';
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(private readonly options: ServerCoreDaemonRuntimeOptions) {}

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.state !== 'idle') return Promise.reject(new Error('Server Core runtime is closed'));
    this.startPromise = this.options.lifecycle.start().then(
      () => { this.state = 'running'; },
      (error) => { this.state = 'stopped'; throw error; },
    );
    return this.startPromise;
  }

  stop(reason: string): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      if (this.startPromise) await this.startPromise.catch(() => undefined);
      if (this.state === 'running') await this.options.lifecycle.stop(reason);
      this.state = 'stopped';
    })();
    return this.stopPromise;
  }

  currentRevision(): number {
    this.assertRunning();
    return this.options.metadata.currentRevision();
  }

  async execute(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    this.assertRunning();
    if (input.signal.aborted) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.Cancelled, 'Request was cancelled');
    }
    switch (input.method) {
      case 'system.health': {
        parseEmptyParams(input.params);
        const revision = this.options.metadata.currentRevision();
        return { result: { ok: true, revision }, revision };
      }
      case 'session.history': return this.history(input);
      case 'session.send': return this.send(input);
      case 'session.interrupt': return this.interrupt(input);
      case 'session.steer': return this.steer(input);
      case 'pending.list': return this.pending(input);
      case 'pending.respond': return this.respondPending(input);
      case 'session.runtime.get': return this.runtimeControls(input);
      case 'session.runtime.update': return this.updateRuntime(input);
      case 'subscription.set': return this.setSubscription(input);
      default:
        throw new DaemonRequestError(
          AgentDeckClientErrorCode.CapabilityUnavailable,
          'Core method is unavailable',
        );
    }
  }

  async subscribe(input: DaemonEventSubscriptionInput): Promise<DaemonEventSubscription> {
    this.assertRunning();
    let replay: ServerCoreChangeRecord[];
    try {
      replay = this.options.metadata.replay(input.afterRevision);
    } catch {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.ReplayGap,
        'Event replay is unavailable',
        false,
        this.options.metadata.currentRevision(),
      );
    }
    for (const change of replay) input.onEvent(this.envelope(change));
    let closed = false;
    const release = this.options.metadata.subscribe((change) => {
      if (!closed && !input.signal.aborted) input.onEvent(this.envelope(change));
    });
    const onAbort = (): void => { close(); };
    const close = (): void => {
      if (closed) return;
      closed = true;
      input.signal.removeEventListener('abort', onAbort);
      release();
    };
    input.signal.addEventListener('abort', onAbort, { once: true });
    if (input.signal.aborted) close();
    return { close };
  }

  private history(input: DaemonRequestInput): DaemonRequestResult {
    const params = parseHistoryParams(input.params);
    this.requireSession(params.sessionId);
    const events = this.options.events.listValidForSession(
      params.sessionId,
      params.limit,
      params.offset,
    );
    const total = this.options.events.countForSession(params.sessionId);
    const nextOffset = params.offset + events.length;
    const revision = this.options.metadata.currentRevision();
    return {
      result: {
        entries: events.map(historyEntry),
        nextCursor: nextOffset < total ? historyCursor(nextOffset) : null,
        revision,
      },
      revision,
    };
  }

  private async send(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    const params = parseSendParams(input.params);
    const { adapter } = this.requireProviderSession(params.sessionId);
    if (!adapter.sendMessage) this.unavailable();
    const fingerprint = this.fingerprint(input.method, input.params);
    return this.mutate(input, fingerprint, 'session.message.accepted', params.sessionId, async () => {
      await adapter.sendMessage!(params.sessionId, params.text, undefined, {
        idempotencyKey: input.idempotencyKey!,
      });
      return (revision) => ({
        messageId: `remote-message-${fingerprint.slice(0, 32)}`,
        sequence: revision,
        revision,
      });
    });
  }

  private async interrupt(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    const { sessionId } = parseSessionTargetParams(input.params);
    const { adapter } = this.requireProviderSession(sessionId);
    if (!adapter.interruptSession) this.unavailable();
    return this.mutate(
      input,
      this.fingerprint(input.method, input.params),
      'session.interrupted',
      sessionId,
      async () => {
        await adapter.interruptSession!(sessionId);
        return (revision) => ({ accepted: true, revision });
      },
    );
  }

  private async steer(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    const params = parseSteerParams(input.params);
    const { adapter } = this.requireProviderSession(params.sessionId);
    if (!adapter.steerTurn) this.unavailable();
    return this.mutate(
      input,
      this.fingerprint(input.method, input.params),
      'session.steered',
      params.sessionId,
      async () => {
        await adapter.steerTurn!(params.sessionId, params.text);
        return (revision) => ({ accepted: true, revision });
      },
    );
  }

  private pending(input: DaemonRequestInput): DaemonRequestResult {
    const { sessionId } = parseSessionTargetParams(input.params);
    const { adapter, record } = this.requireProviderSession(sessionId);
    const requests = listServerCorePendingRequests(
      adapter,
      sessionId,
      record.startedAt,
      this.options.presentations,
    ).map(
      (request): JsonObject => ({
        id: request.id,
        sessionId: request.sessionId,
        kind: request.kind,
        status: request.status,
        createdAt: request.createdAt,
        expiresAt: request.expiresAt,
        display: request.display,
      }),
    );
    const revision = this.options.metadata.currentRevision();
    return { result: { requests, revision }, revision };
  }

  private async respondPending(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    const params = parsePendingResponseParams(input.params);
    const { adapter } = this.requireProviderSession(params.sessionId);
    return this.mutate(
      input,
      this.fingerprint(input.method, input.params),
      'pending.responded',
      params.sessionId,
      async () => {
        const status = await respondToServerCorePending(
          adapter,
          params,
          this.options.presentations,
        );
        return (revision) => ({ status, revision });
      },
    );
  }

  private runtimeControls(input: DaemonRequestInput): DaemonRequestResult {
    const { sessionId } = parseSessionTargetParams(input.params);
    const { record } = this.requireProviderSession(sessionId);
    return this.controls(record, this.options.metadata.currentRevision());
  }

  private async updateRuntime(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    const params = parseRuntimeUpdateParams(input.params);
    const { adapter, record } = this.requireProviderSession(params.sessionId);
    return this.mutate(
      input,
      this.fingerprint(input.method, input.params),
      'session.runtime.updated',
      params.sessionId,
      async () => {
        const outcome = await applyServerCoreRuntimePatch(adapter, record, params.patch);
        return (revision) => {
          const current = this.options.repository.get(params.sessionId) ?? record;
          return {
            controls: this.controlsResult(current, revision),
            effect: outcome.effect,
            replacementSessionId: outcome.replacementSessionId,
          };
        };
      },
    );
  }

  private async setSubscription(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    const params = parseSubscriptionParams(input.params);
    this.requireSession(params.sessionId);
    return this.mutate(
      input,
      this.fingerprint(input.method, input.params),
      'subscription.updated',
      params.sessionId,
      async () => {
        this.options.metadata.setSubscribed(
          input.access.accessCredentialId,
          input.access.surface,
          params.sessionId,
          params.subscribed,
        );
        return (revision) => ({ subscribed: params.subscribed, revision });
      },
    );
  }

  private async mutate(
    input: DaemonRequestInput,
    fingerprint: string,
    kind: string,
    entityId: string,
    invoke: () => Promise<(revision: number) => JsonObject>,
  ): Promise<DaemonRequestResult> {
    const identity: ServerCoreMutationIdentity = {
      accessCredentialId: input.access.accessCredentialId,
      accessSurface: input.access.surface,
      idempotencyKey: input.idempotencyKey!,
      method: input.method,
      requestFingerprint: fingerprint,
    };
    const replay = mutationError(this.options.metadata.claimMutation(
      identity,
      Date.now(),
      input.expectedRevision ?? undefined,
    ));
    if (replay) return replay;
    const resultFactory = await invoke();
    const revision = this.options.metadata.appendChange(kind, entityId, {
      method: input.method,
      sessionId: entityId,
    });
    const result = resultFactory(revision);
    this.options.metadata.completeMutation(identity, result, revision);
    return { result, revision };
  }

  private controls(record: SessionRecord, revision: number): DaemonRequestResult {
    return { result: this.controlsResult(record, revision), revision };
  }

  private controlsResult(record: SessionRecord, revision: number): JsonObject {
    return { adapterId: record.agentId, values: serverCoreRuntimeValues(record), revision };
  }

  private requireSession(sessionId: string): SessionRecord {
    const record = this.options.repository.get(sessionId);
    if (!record) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.NotFound, 'Session was not found');
    }
    return record;
  }

  private requireProviderSession(sessionId: string): {
    adapter: AgentAdapter;
    record: SessionRecord;
  } {
    const record = this.requireSession(sessionId);
    const adapter = this.options.registry.get(record.agentId);
    if (!adapter) this.unavailable();
    return { adapter, record };
  }

  private fingerprint(method: CoreMethod, params: JsonObject): string {
    return createHash('sha256').update(`${method}\u0000${canonicalJson(params)}`).digest('hex');
  }

  private envelope(change: ServerCoreChangeRecord): AgentDeckEventEnvelope {
    return {
      instanceId: this.options.instanceId,
      revision: change.revision,
      kind: change.kind,
      entityId: change.entityId,
      payload: change.payload,
    };
  }

  private assertRunning(): void {
    if (this.state !== 'running') throw new Error('Server Core runtime is not running');
  }

  private unavailable(): never {
    throw new DaemonRequestError(
      AgentDeckClientErrorCode.CapabilityUnavailable,
      'Provider capability is unavailable',
    );
  }
}
