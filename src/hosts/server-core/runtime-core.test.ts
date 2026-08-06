import { describe, expect, it, vi } from 'vitest';
import type {
  AuthenticatedClientAccessContext,
  CoreMethod,
  JsonObject,
  JsonValue,
} from '@contracts/index';
import type {
  DaemonRequestInput,
  DaemonEventSubscriptionInput,
} from '@hosts/daemon';
import type { AgentAdapter } from '@main/adapters/types';
import type { PermissionMode, SessionRecord, StoredAgentEvent } from '@shared/types';
import {
  ServerCoreDaemonRuntime,
  type ServerCoreRuntimeMetadataPort,
} from './runtime-core';
import type {
  ServerCoreChangeRecord,
  ServerCoreMutationClaim,
  ServerCoreMutationIdentity,
} from './runtime-metadata-store';

const access: AuthenticatedClientAccessContext = {
  kind: 'authenticated-client',
  topology: 'server-core',
  instanceId: 'instance-a',
  clientId: 'client-a',
  transport: 'ssh',
  accessCredentialId: 'credential-a',
  authority: 'owner-equivalent',
  surface: 'desktop-full',
};

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'session-a',
    agentId: 'claude-code',
    cwd: '/workspaces/private',
    title: 'Private session',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 10,
    lastEventAt: 20,
    endedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

class FakeMetadata implements ServerCoreRuntimeMetadataPort {
  revision = 0;
  firstRetained = 1;
  readonly changes: ServerCoreChangeRecord[] = [];
  readonly listeners = new Set<(change: ServerCoreChangeRecord) => void>();
  readonly ledger = new Map<string, {
    identity: ServerCoreMutationIdentity;
    result?: JsonValue;
    revision?: number;
  }>();
  readonly subscriptions = new Map<string, boolean>();

  currentRevision(): number { return this.revision; }

  appendChange(kind: string, entityId: string | null, payload: JsonValue): number {
    const change = { revision: ++this.revision, kind, entityId, payload };
    this.changes.push(change);
    for (const listener of [...this.listeners]) listener(change);
    return change.revision;
  }

  replay(afterRevision: number): ServerCoreChangeRecord[] {
    if (afterRevision < this.firstRetained - 1) throw new Error('gap');
    return this.changes.filter((change) => change.revision > afterRevision);
  }

  subscribe(listener: (change: ServerCoreChangeRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  claimMutation(
    identity: ServerCoreMutationIdentity,
    _now?: number,
    expectedRevision?: number,
  ): ServerCoreMutationClaim {
    const key = `${identity.accessCredentialId}\u0000${identity.accessSurface}\u0000${identity.idempotencyKey}`;
    const current = this.ledger.get(key);
    if (current) {
      if (
        current.identity.method !== identity.method ||
        current.identity.requestFingerprint !== identity.requestFingerprint
      ) return { state: 'conflict' };
      if (current.result === undefined || current.revision === undefined) {
        return { state: 'uncertain' };
      }
      return { state: 'completed', result: current.result, revision: current.revision };
    }
    if (expectedRevision !== undefined && expectedRevision !== this.revision) {
      return { state: 'conflict' };
    }
    this.ledger.set(key, { identity });
    return { state: 'claimed' };
  }

  completeMutation(
    identity: ServerCoreMutationIdentity,
    result: JsonValue,
    revision: number,
  ): void {
    const key = `${identity.accessCredentialId}\u0000${identity.accessSurface}\u0000${identity.idempotencyKey}`;
    const row = this.ledger.get(key);
    if (!row) throw new Error('claim missing');
    row.result = result;
    row.revision = revision;
  }

  setSubscribed(
    credential: string,
    surface: 'desktop-full' | 'feishu-session-console',
    sessionId: string,
    subscribed: boolean,
  ): void {
    this.subscriptions.set(`${credential}:${surface}:${sessionId}`, subscribed);
  }
}

function harness(options: {
  adapter?: Partial<AgentAdapter>;
  session?: SessionRecord;
  events?: StoredAgentEvent[];
} = {}) {
  const sessions = new Map<string, SessionRecord>();
  const session = options.session ?? record();
  sessions.set(session.id, session);
  const sendMessage = vi.fn(async () => undefined);
  const adapter = {
    id: session.agentId,
    displayName: session.agentId,
    capabilities: {},
    init: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    sendMessage,
    ...options.adapter,
  } as unknown as AgentAdapter;
  const metadata = new FakeMetadata();
  const events = options.events ?? [];
  const start = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const runtime = new ServerCoreDaemonRuntime({
    instanceId: 'instance-a',
    repository: { get: (id) => sessions.get(id) ?? null },
    events: {
      listValidForSession: (_id, limit, offset) => events.slice(offset, offset + limit),
      countForSession: () => events.length,
    },
    registry: { get: (id) => id === adapter.id ? adapter : undefined },
    metadata,
    lifecycle: { start, stop },
  });
  return { adapter, metadata, runtime, sendMessage, sessions, start, stop };
}

function input(
  method: CoreMethod,
  params: JsonObject,
  options: { idempotencyKey?: string | null; expectedRevision?: number | null } = {},
): DaemonRequestInput {
  return {
    access,
    requestId: `request-${method}`,
    method,
    params,
    idempotencyKey: options.idempotencyKey ?? null,
    expectedRevision: options.expectedRevision ?? null,
    deadlineAt: null,
    signal: new AbortController().signal,
  };
}

describe('ServerCoreDaemonRuntime', () => {
  it('starts once, exposes only cwd-free base methods, and stops once', async () => {
    const { runtime, start, stop } = harness();
    expect(runtime.supportedMethods).not.toContain('session.get');
    expect(runtime.supportedMethods).not.toContain('session.create');
    await Promise.all([runtime.start(), runtime.start()]);
    expect(start).toHaveBeenCalledOnce();
    await Promise.all([runtime.stop('test'), runtime.stop('again')]);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('serves health and bounded history without cwd disclosure', async () => {
    const event: StoredAgentEvent = {
      id: 7,
      sessionId: 'session-a',
      agentId: 'claude-code',
      kind: 'message',
      payload: { role: 'user', text: 'hello' },
      ts: 12,
      source: 'sdk',
    };
    const { runtime } = harness({ events: [event, { ...event, id: 8, ts: 13 }] });
    await runtime.start();
    await expect(runtime.execute(input('system.health', {}))).resolves.toEqual({
      result: { ok: true, revision: 0 }, revision: 0,
    });
    const history = await runtime.execute(input('session.history', {
      sessionId: 'session-a', limit: 1,
    }));
    expect(history.result).toEqual({
      entries: [{
        id: 'event-7', sessionId: 'session-a', sequence: 7,
        role: 'user', content: 'hello', createdAt: 12,
      }],
      nextCursor: 'v1:history:1',
      revision: 0,
    });
    expect(JSON.stringify(history.result)).not.toContain('/workspaces/private');
  });

  it('deduplicates accepted sends and never persists the message body in metadata', async () => {
    const { metadata, runtime, sendMessage } = harness();
    await runtime.start();
    const request = input('session.send', { sessionId: 'session-a', text: 'secret body' }, {
      idempotencyKey: 'intent-a',
    });
    const first = await runtime.execute(request);
    const replay = await runtime.execute(request);
    expect(replay).toEqual(first);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      'session-a', 'secret body', undefined, { idempotencyKey: 'intent-a' },
    );
    expect(JSON.stringify(metadata.changes)).not.toContain('secret body');
    await expect(runtime.execute(input('session.send', {
      sessionId: 'session-a', text: 'different',
    }, { idempotencyKey: 'intent-a' }))).rejects.toMatchObject({ code: 'conflict' });
  });

  it('replays a completed revision-bound mutation after unrelated changes', async () => {
    const respondPermission = vi.fn(async () => undefined);
    const { metadata, runtime } = harness({
      adapter: {
        listPending: () => ({
          permissions: [{
            type: 'permission-request', requestId: 'pending-a',
            toolName: 'Bash', toolInput: { command: 'pwd' },
          }],
          askQuestions: [], exitPlanModes: [],
        }),
        respondPermission,
      },
    });
    await runtime.start();
    const request = input('pending.respond', {
      sessionId: 'session-a', requestId: 'pending-a', action: 'approve',
    }, { idempotencyKey: 'pending-intent', expectedRevision: 0 });
    const first = await runtime.execute(request);
    metadata.appendChange('unrelated', null, null);
    await expect(runtime.execute(request)).resolves.toEqual(first);
    expect(respondPermission).toHaveBeenCalledOnce();
  });

  it('rejects a stale expected revision before invoking the provider or retaining a claim', async () => {
    const setPermissionMode = vi.fn(async (_id: string, _mode: PermissionMode) => undefined);
    const { metadata, runtime } = harness({ adapter: { setPermissionMode } });
    await runtime.start();
    metadata.appendChange('existing', null, null);
    const request = input('session.runtime.update', {
      sessionId: 'session-a', patch: { permissionMode: 'plan' },
    }, { idempotencyKey: 'runtime-intent', expectedRevision: 0 });
    await expect(runtime.execute(request)).rejects.toMatchObject({ code: 'conflict' });
    expect(setPermissionMode).not.toHaveBeenCalled();
    expect(metadata.ledger.size).toBe(0);
  });

  it('projects and answers ask-user-question with exact question identities', async () => {
    const respondAskUserQuestion = vi.fn(async () => undefined);
    const { runtime } = harness({
      adapter: {
        listPending: () => ({
          permissions: [],
          askQuestions: [{
            type: 'ask-user-question', requestId: 'ask-a',
            questions: [{ question: 'Environment?', options: [{ label: 'prod' }] }],
          }],
          exitPlanModes: [],
        }),
        respondAskUserQuestion,
      },
    });
    await runtime.start();
    const listed = await runtime.execute(input('pending.list', { sessionId: 'session-a' }));
    expect(listed.result).toMatchObject({
      requests: [{ id: 'ask-a', kind: 'ask-user-question', display: { questionIds: ['q1'] } }],
      revision: 0,
    });
    await runtime.execute(input('pending.respond', {
      sessionId: 'session-a', requestId: 'ask-a', action: 'submit', value: { q1: 'production' },
    }, { idempotencyKey: 'ask-intent', expectedRevision: 0 }));
    expect(respondAskUserQuestion).toHaveBeenCalledWith('session-a', 'ask-a', {
      answers: [{ question: 'Environment?', selected: [], other: 'production' }],
    });
  });

  it('reads and hot-applies exact provider runtime controls', async () => {
    const setPermissionMode = vi.fn(async (_id: string, _mode: PermissionMode) => undefined);
    const { metadata, runtime, sessions } = harness({ adapter: { setPermissionMode } });
    await runtime.start();
    await expect(runtime.execute(input('session.runtime.get', {
      sessionId: 'session-a',
    }))).resolves.toMatchObject({
      result: { adapterId: 'claude-code', values: { permissionMode: 'default' }, revision: 0 },
    });
    setPermissionMode.mockImplementationOnce(async (_id, mode) => {
      sessions.set('session-a', record({ permissionMode: mode }));
    });
    const updated = await runtime.execute(input('session.runtime.update', {
      sessionId: 'session-a', patch: { permissionMode: 'plan' },
    }, { idempotencyKey: 'runtime-intent', expectedRevision: 0 }));
    expect(updated.result).toEqual({
      controls: {
        adapterId: 'claude-code',
        values: {
          model: null, provider: null, thinking: null,
          claudeCodeSandbox: null, permissionMode: 'plan',
        },
        revision: 1,
      },
      effect: 'hot-applied',
      replacementSessionId: null,
    });
    expect(metadata.changes[0]?.payload).not.toHaveProperty('patch');
  });

  it('replays then streams live revisions and fails closed across a replay gap', async () => {
    const { metadata, runtime } = harness();
    await runtime.start();
    metadata.appendChange('first', 'session-a', { value: 1 });
    const events: unknown[] = [];
    const controller = new AbortController();
    const subscriptionInput: DaemonEventSubscriptionInput = {
      access,
      afterRevision: 0,
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    };
    const subscription = await runtime.subscribe(subscriptionInput);
    metadata.appendChange('second', 'session-a', { value: 2 });
    expect(events).toEqual([
      { instanceId: 'instance-a', revision: 1, kind: 'first', entityId: 'session-a', payload: { value: 1 } },
      { instanceId: 'instance-a', revision: 2, kind: 'second', entityId: 'session-a', payload: { value: 2 } },
    ]);
    controller.abort();
    await subscription.close();
    metadata.appendChange('third', null, null);
    expect(events).toHaveLength(2);
    metadata.firstRetained = 3;
    await expect(runtime.subscribe({ ...subscriptionInput, afterRevision: 0 }))
      .rejects.toMatchObject({ code: 'replay_gap', currentRevision: 3 });
  });

  it('persists subscription intent as an idempotent metadata-only mutation', async () => {
    const { metadata, runtime } = harness();
    await runtime.start();
    const request = input('subscription.set', {
      sessionId: 'session-a', subscribed: true,
    }, { idempotencyKey: 'subscribe-a' });
    await expect(runtime.execute(request)).resolves.toEqual({
      result: { subscribed: true, revision: 1 }, revision: 1,
    });
    await runtime.execute(request);
    expect(metadata.subscriptions.get('credential-a:desktop-full:session-a')).toBe(true);
    expect(metadata.changes).toHaveLength(1);
  });
});
