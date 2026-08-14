import {
  CORE_METHOD_METADATA,
  createPermissionPreviewDisplay,
  issueRemoteOwnerAccessContext,
  type AgentDeckClient,
  type AgentDeckEventEnvelope,
  type AgentDeckRequestOptions,
  type AgentDeckSubscription,
  type CoreMethod,
  type CoreMethodMap,
  type HostHello,
  type JsonObject,
  type PendingRequestDto,
  type ProjectReferenceDto,
  type SessionHistoryEntryDto,
  type SessionConsoleSummaryDto,
  type SessionListItemDto,
} from '@contracts/index';
import { CURRENT_PROTOCOL_VERSION } from '@protocol/version';
import { sessionConsoleCapabilitiesFixture } from '@contracts/session-console-capabilities.fixture';
import {
  FeishuSessionConsoleGateway,
  InMemoryFeishuGatewayStore,
  type EnrolledFeishuCredential,
  type FeishuAgentDeckClientFactory,
  type FeishuCardActionEvent,
  type FeishuGatewayOptions,
  type FeishuMessageEvent,
  type FeishuOutboundMessage,
  type FeishuDeliveryAttemptContext,
  type FeishuPendingAction,
  type FeishuTransportPort,
  type PendingActionNoncePort,
} from '..';

export const credential: EnrolledFeishuCredential = {
  appId: 'app-1',
  tenantKey: 'tenant-1',
  openId: 'open-1',
  instanceId: 'instance-1',
  credentialId: 'credential-1',
  connectionScope: 'credential-1',
  topology: 'full',
  status: 'active',
  authority: 'owner-equivalent',
};

export const gatewayBinding = {
  appId: credential.appId,
  tenantKey: credential.tenantKey,
  instanceId: credential.instanceId,
  topology: credential.topology,
} as const;

export interface RequestCall {
  method: CoreMethod;
  params: unknown;
  options?: AgentDeckRequestOptions;
}

export class FakeCoreClient implements AgentDeckClient<CoreMethodMap> {
  readonly calls: RequestCall[] = [];
  readonly listeners = new Set<(event: AgentDeckEventEnvelope) => void>();
  readonly listenerHistory: Array<(event: AgentDeckEventEnvelope) => void> = [];
  readonly subscribeRevisions: number[] = [];
  readonly sessions = new Map<string, SessionListItemDto>();
  readonly projects = new Map<string, ProjectReferenceDto>();
  readonly histories = new Map<string, SessionHistoryEntryDto[]>();
  readonly pending = new Map<string, PendingRequestDto[]>();
  readonly runtime = new Map<string, { adapterId: string; values: JsonObject; revision: number }>();
  readonly subscriptions = new Map<string, boolean>();
  readonly hello: HostHello;
  requestHook?: (call: RequestCall) => Promise<unknown> | unknown;
  subscribeError: Error | null = null;
  subscriptionCloseError: Error | null = null;
  closeError: Error | null = null;
  subscribeHook?: (listener: (event: AgentDeckEventEnvelope) => void) => void;
  closeHold: Promise<void> | null = null;
  connectHold: Promise<void> | null = null;
  closeCalls = 0;
  subscriptionCloseCalls = 0;
  closed = false;
  revision = 10;

  constructor(
    input: Parameters<FeishuAgentDeckClientFactory>[0],
    capabilities = [...new Set(Object.values(CORE_METHOD_METADATA).map((item) => item.capability))],
  ) {
    this.hello = {
      protocolVersion: { ...CURRENT_PROTOCOL_VERSION },
      appVersion: 'fake-core',
      topology: input.topology,
      instanceId: input.instanceId,
      authoritativeCore: {
        id: input.topology === 'relay' ? 'worker-1' : 'core-1',
        location: input.topology === 'relay' ? 'local-worker' : 'server-appliance',
        generation: input.topology === 'relay' ? 1 : null,
      },
      access: issueRemoteOwnerAccessContext({
        topology: input.topology,
        instanceId: input.instanceId,
        clientId: input.clientId,
        connectionScope: input.credentialId,
        surface: 'feishu',
      }),
      capabilities,
      limits: {
        maxFrameBytes: 64_000,
        maxBlobBytes: 1_000_000,
        maxConcurrentRequests: 8,
        maxQueuedEvents: 64,
      },
      eventRevision: this.revision,
    };
  }

  async connect(): Promise<HostHello> {
    if (this.connectHold) await this.connectHold;
    return this.hello;
  }

  request: AgentDeckClient<CoreMethodMap>['request'] = (async (
    method: CoreMethod,
    params: Record<string, unknown>,
    options?: AgentDeckRequestOptions,
  ): Promise<unknown> => {
    const call = { method, params, options };
    this.calls.push(call);
    if (this.requestHook) {
      const hooked = await this.requestHook(call);
      if (hooked !== undefined) return hooked;
    }
    switch (method) {
      case 'session.console.list': {
        const sessions = [...this.sessions.values()].map(sessionSummary);
        const offset = fakeCursorOffset(params.cursor);
        const limit = params.limit as number;
        const end = Math.min(offset + limit, sessions.length);
        return {
          sessions: sessions.slice(offset, end),
          nextCursor: end < sessions.length ? `session-page-${end}` : null,
          total: sessions.length,
          revision: this.revision,
        };
      }
      case 'session.console.get': {
        const result = this.sessions.get(params.sessionId as string);
        return {
          session: result ? sessionSummary(result) : null,
          revision: this.revision,
        };
      }
      case 'project.list': {
        const projects = [...this.projects.values()];
        const offset = fakeCursorOffset(params.cursor);
        const limit = params.limit as number;
        const end = Math.min(offset + limit, projects.length);
        return {
          projects: projects.slice(offset, end),
          nextCursor: end < projects.length ? `project-page-${end}` : null,
          total: projects.length,
          revision: this.revision,
        };
      }
      case 'project.resolve':
        return {
          project: [...this.projects.values()].find(
            (project) => project.alias === params.alias,
          ) ?? null,
          revision: this.revision,
        };
      case 'session.console.capabilities':
        return {
          ...sessionConsoleCapabilitiesFixture(
            params.adapterId as 'claude-code' | 'codex-cli' | 'grok-build',
            params.workingDirectory as string,
          ),
          revision: this.revision,
        };
      case 'workspace.directory.list':
        throw new Error('Workspace directory browsing is desktop-only');
      case 'session.console.create': {
        const id = `session-${this.sessions.size + 1}`;
        this.sessions.set(id, session(id, params.adapterId as string));
        return { sessionId: id, revision: ++this.revision };
      }
      case 'session.list':
        return { sessions: [...this.sessions.values()], revision: this.revision };
      case 'session.get':
        return {
          session: this.sessions.get(params.sessionId as string) ?? null,
          revision: this.revision,
        };
      case 'session.create': {
        const id = `session-${this.sessions.size + 1}`;
        this.sessions.set(id, session(id, params.adapterId as string, params.cwd as string));
        return { sessionId: id, revision: ++this.revision };
      }
      case 'session.history': {
        const entries = this.histories.get(params.sessionId as string) ?? [];
        const limit = typeof params.limit === 'number' ? params.limit : entries.length;
        return {
          entries: entries.slice(0, limit),
          nextCursor: entries.length > limit ? 'next-1' : null,
          revision: this.revision,
        };
      }
      case 'session.send':
        return { messageId: `message-${this.calls.length}`, sequence: this.calls.length, revision: ++this.revision };
      case 'session.interrupt':
      case 'session.steer':
        return { accepted: true, revision: ++this.revision };
      case 'pending.list':
        return { requests: this.pending.get(params.sessionId as string) ?? [], revision: this.revision };
      case 'pending.respond': {
        const requests = this.pending.get(params.sessionId as string) ?? [];
        const target = requests.find((item) => item.id === params.requestId);
        if (target) target.status = params.action === 'deny' ? 'denied' : 'resolved';
        return { status: target?.status ?? 'resolved', revision: ++this.revision };
      }
      case 'session.runtime.get':
        return this.runtime.get(params.sessionId as string) ?? {
          adapterId: 'codex-cli',
          values: { approvalPolicy: 'on-request' },
          revision: this.revision,
        };
      case 'session.runtime.update': {
        const current = this.runtime.get(params.sessionId as string) ?? {
          adapterId: 'codex-cli',
          values: {},
          revision: this.revision,
        };
        const controls = {
          ...current,
          values: { ...current.values, ...(params.patch as JsonObject) },
          revision: ++this.revision,
        };
        this.runtime.set(params.sessionId as string, controls);
        return { controls, effect: 'hot-applied', replacementSessionId: null };
      }
      case 'subscription.set':
        this.subscriptions.set(params.sessionId as string, params.subscribed as boolean);
        return { subscribed: params.subscribed, revision: ++this.revision };
      case 'system.health':
        return { ok: true, revision: this.revision };
      default:
        throw new Error(`Unsupported fake Core method: ${method}`);
    }
  }) as AgentDeckClient<CoreMethodMap>['request'];

  subscribe(
    afterRevision: number,
    listener: (event: AgentDeckEventEnvelope) => void,
  ): AgentDeckSubscription {
    if (this.subscribeError) throw this.subscribeError;
    this.subscribeRevisions.push(afterRevision);
    this.listeners.add(listener);
    this.listenerHistory.push(listener);
    this.subscribeHook?.(listener);
    return {
      close: () => {
        this.subscriptionCloseCalls += 1;
        this.listeners.delete(listener);
        if (this.subscriptionCloseError) throw this.subscriptionCloseError;
      },
    };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.closed = true;
    if (this.closeHold) await this.closeHold;
    if (this.closeError) throw this.closeError;
  }

  emit(event: AgentDeckEventEnvelope): void {
    for (const listener of this.listeners) listener(event);
  }

  emitStale(event: AgentDeckEventEnvelope): void {
    for (const listener of this.listenerHistory) listener(event);
  }
}

export class FakeTransport implements FeishuTransportPort {
  readonly deliverySemantics = 'event-id-idempotent' as const;
  readonly deliveryIdempotencyWindowMs = 60 * 60 * 1_000;
  readonly messages: FeishuOutboundMessage[] = [];
  readonly attempts: FeishuDeliveryAttemptContext[] = [];
  failures = 0;
  holdChat: string | null = null;
  releaseHold: (() => void) | null = null;

  async deliver(
    message: FeishuOutboundMessage,
    attempt: FeishuDeliveryAttemptContext,
  ): Promise<void> {
    this.attempts.push(attempt);
    attempt.remainingMs();
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('transport secret must not leak');
    }
    if (this.holdChat === message.chatId) {
      await new Promise<void>((resolve) => {
        this.releaseHold = resolve;
      });
    }
    this.messages.push(structuredClone(message));
  }
}

function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  }
  return (result >>> 0).toString(36);
}

function nonceValue(binding: Parameters<PendingActionNoncePort['issue']>[0]): string {
  return JSON.stringify([
    binding.instanceId,
    binding.credentialId,
    binding.chatId,
    binding.chatType,
    binding.sessionId,
    binding.requestId,
    binding.revision,
    binding.contentDigest,
    binding.action,
  ]);
}

export const testNonce: PendingActionNoncePort = {
  issue: (binding) => `nonce-${hash(nonceValue(binding))}`,
  verify: (binding, nonce) => nonce === `nonce-${hash(nonceValue(binding))}`,
};

export function session(
  id: string,
  adapterId = 'codex-cli',
  cwd = '/srv/project',
): SessionListItemDto {
  return {
    id,
    adapterId,
    cwd,
    title: `Title ${id}`,
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
  };
}

export function sessionSummary(value: SessionListItemDto): SessionConsoleSummaryDto {
  return {
    id: value.id,
    adapterId: value.adapterId,
    title: value.title,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function project(
  alias = 'project',
  projectId = 'project-1',
  projectRef = '.',
): ProjectReferenceDto {
  return { projectId, projectRef, alias, title: `Project ${alias}` };
}

function fakeCursorOffset(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const match = value.match(/(?:^|page-)([0-9]+)$/);
  return match ? Number(match[1]) : 0;
}

export function pending(
  id = 'pending-1',
  sessionId = 'session-1',
  status: PendingRequestDto['status'] = 'pending',
): PendingRequestDto {
  return {
    id,
    sessionId,
    kind: 'permission',
    status,
    createdAt: 1,
    expiresAt: null,
    display: createPermissionPreviewDisplay('Bash', {
      command: 'pnpm test',
      apiKey: 'secret-value',
    }),
  };
}

export function messageEvent(
  eventId: string,
  text: string,
  overrides: Partial<FeishuMessageEvent> = {},
): FeishuMessageEvent {
  return {
    schemaVersion: 1,
    kind: 'message',
    eventId,
    appId: credential.appId,
    tenantKey: credential.tenantKey,
    openId: credential.openId,
    chatId: 'chat-1',
    chatType: 'p2p',
    occurredAt: 1,
    text,
    ...overrides,
  };
}

export function actionEvent(
  eventId: string,
  action: FeishuPendingAction,
  overrides: Partial<FeishuCardActionEvent> = {},
): FeishuCardActionEvent {
  return {
    schemaVersion: 1,
    kind: 'card-action',
    eventId,
    appId: credential.appId,
    tenantKey: credential.tenantKey,
    openId: credential.openId,
    chatId: action.chatId,
    chatType: action.chatType,
    occurredAt: 2,
    action,
    ...overrides,
  };
}

export function setup(
  overrides: Partial<FeishuGatewayOptions> = {},
): {
  gateway: FeishuSessionConsoleGateway;
  store: InMemoryFeishuGatewayStore;
  transport: FakeTransport;
  clients: Map<string, FakeCoreClient>;
} {
  const store = overrides.store instanceof InMemoryFeishuGatewayStore
    ? overrides.store
    : new InMemoryFeishuGatewayStore();
  if (!store.resolveCredential(credential)) store.enroll(credential);
  const transport = overrides.transport instanceof FakeTransport
    ? overrides.transport
    : new FakeTransport();
  const clients = new Map<string, FakeCoreClient>();
  const factory: FeishuAgentDeckClientFactory = (input) => {
    const client = new FakeCoreClient(input);
    client.sessions.set('session-1', session('session-1'));
    client.sessions.set('session-2', session('session-2', 'claude-code'));
    client.projects.set('project-1', project());
    clients.set(input.clientId, client);
    return client;
  };
  const gateway = new FeishuSessionConsoleGateway({
    appVersion: 'test',
    store,
    clientFactory: factory,
    transport,
    nonce: testNonce,
    ...overrides,
    binding: overrides.binding ?? gatewayBinding,
  });
  return { gateway, store, transport, clients };
}

export function onlyClient(clients: Map<string, FakeCoreClient>): FakeCoreClient {
  const result = [...clients.values()][0];
  if (!result) throw new Error('Expected one fake client');
  return result;
}

export async function select(
  gateway: FeishuSessionConsoleGateway,
  sessionId = 'session-1',
  eventId = `select-${sessionId}`,
  chatId = 'chat-1',
): Promise<void> {
  await gateway.handle(messageEvent(eventId, `/select ${sessionId}`, { chatId }));
}

export function actionFrom(message: FeishuOutboundMessage): FeishuPendingAction {
  const action = message.cards[0]?.buttons[0]?.action;
  if (!action) throw new Error('Expected an actionable pending card');
  return action;
}

export async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
