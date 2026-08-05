import { describe, expect, it, vi } from 'vitest';

import {
  AgentDeckCapability,
  type AgentDeckCapability as Capability,
  type CoreMethodMap,
} from '@contracts/index';
import { ElectronHostRegistry } from '@hosts/electron';
import {
  ControlledClient,
  deferred,
  remoteHello,
  remoteProfile,
  standaloneProfile,
} from '@hosts/electron/__tests__/registry-fixture';
import type {
  RemoteHostJsonValue,
  RemoteHostPendingAction,
  RemoteHostPendingResponseDto,
  RemoteHostPendingRequestDto,
} from '@shared/remote-host';

import { RemoteHostCredentialSelections } from './credential-selections';
import type { RemoteHostProfileDocument } from './profile-document';
import { RemoteHostProfileStore, type RemoteHostProfileBackend } from './profile-store';
import { RemoteHostService } from './service';

type PendingListResult = CoreMethodMap['pending.list']['result'];

class MemoryBackend implements RemoteHostProfileBackend {
  constructor(private value: RemoteHostProfileDocument) {}
  read(): unknown { return structuredClone(this.value); }
  write(value: RemoteHostProfileDocument): void { this.value = structuredClone(value); }
}

function pendingResult(
  kind: RemoteHostPendingRequestDto['kind'] = 'permission',
  options: {
    display?: Record<string, RemoteHostJsonValue>;
    id?: string;
    revision?: number;
    status?: RemoteHostPendingRequestDto['status'];
  } = {},
): PendingListResult {
  return {
    requests: [{
      id: options.id ?? 'request-1',
      sessionId: 'session-1',
      kind,
      status: options.status ?? 'pending',
      createdAt: 1,
      expiresAt: null,
      display: options.display ?? {},
    }],
    revision: options.revision ?? 7,
  };
}

function harness(capabilities = Object.values(AgentDeckCapability) as Capability[]) {
  const local = standaloneProfile('local');
  const remote = remoteProfile('remote-pending', 'server-core');
  const client = new ControlledClient({ ...remoteHello(remote), capabilities });
  let currentPending = pendingResult();
  vi.mocked(client.request).mockImplementation((async (method: keyof CoreMethodMap) => {
    if (method === 'pending.list') return structuredClone(currentPending);
    if (method === 'pending.respond') {
      return { status: 'resolved', revision: currentPending.revision + 1 };
    }
    throw new Error(`unexpected ${method}`);
  }) as typeof client.request);
  const registry = new ElectronHostRegistry({
    appVersion: 'desktop-test',
    createClient: () => ({ client }),
  });
  let generated = 0;
  const createId = () => `pending-${++generated}`;
  const service = new RemoteHostService({
    registry,
    store: new RemoteHostProfileStore(new MemoryBackend({
      schemaVersion: 3,
      sourceMode: 'remote',
      selectedRemoteProfileId: remote.id,
      profiles: [local, remote],
    }), { create: createId }),
    selections: new RemoteHostCredentialSelections({
      createId,
      validateFile: () => undefined,
    }),
    createId,
  });
  return {
    client,
    local,
    remote,
    service,
    setPending(value: PendingListResult): void { currentPending = value; },
  };
}

function response(
  action: RemoteHostPendingAction,
  options: Partial<RemoteHostPendingResponseDto> = {},
): RemoteHostPendingResponseDto {
  return {
    profileId: 'remote-pending',
    sessionId: 'session-1',
    requestId: 'request-1',
    action,
    expectedRevision: 7,
    intentId: 'intent-pending-1',
    ...options,
  };
}

function methods(client: ControlledClient): string[] {
  return vi.mocked(client.request).mock.calls.map((call) => call[0]);
}

describe('RemoteHostService authoritative pending response policy', () => {
  it('reads pending.list first and sends the legal action at its authoritative revision', async () => {
    const context = harness();
    await context.service.connect(context.remote.id);

    await expect(context.service.respondPending(response('approve'))).resolves.toEqual({
      status: 'resolved',
      revision: 8,
    });

    expect(vi.mocked(context.client.request).mock.calls).toEqual([
      ['pending.list', { sessionId: 'session-1' }, { deadlineMs: 45_000 }],
      [
        'pending.respond',
        { sessionId: 'session-1', requestId: 'request-1', action: 'approve' },
        {
          deadlineMs: 45_000,
          idempotencyKey: expect.stringMatching(/^electron-pending-/),
          expectedRevision: 7,
        },
      ],
    ]);
  });

  it.each([
    {
      display: { questionIds: ['question-a', 'question-b'] },
      value: { 'question-a': 'answer-a', 'question-b': 'answer-b' },
    },
    {
      display: {},
      value: { answer: 'fallback-answer' },
    },
  ])('accepts exact authoritative ask-user-question keys: %#', async ({ display, value }) => {
    const context = harness();
    context.setPending(pendingResult('ask-user-question', {
      display: display as Record<string, RemoteHostJsonValue>,
    }));
    await context.service.connect(context.remote.id);

    await context.service.respondPending(response('submit', {
      value: value as unknown as RemoteHostJsonValue,
    }));

    expect(methods(context.client)).toEqual(['pending.list', 'pending.respond']);
    expect(vi.mocked(context.client.request).mock.calls[1]?.[1]).toEqual({
      sessionId: 'session-1',
      requestId: 'request-1',
      action: 'submit',
      value,
    });
  });

  it.each([
    { kind: 'permission', action: 'accept' },
    { kind: 'permission', action: 'reject' },
    { kind: 'diff-review', action: 'approve' },
    { kind: 'exit-plan', action: 'deny' },
    { kind: 'ask-user-question', action: 'approve' },
  ] as const)('rejects $kind -> $action before pending.respond', async ({ kind, action }) => {
    const context = harness();
    context.setPending(pendingResult(kind));
    await context.service.connect(context.remote.id);

    await expect(context.service.respondPending(response(action))).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(methods(context.client)).toEqual(['pending.list']);
  });

  it.each([
    {
      kind: 'ask-user-question',
      display: { questionIds: ['secret-question', 'second-question'] },
      action: 'submit',
      value: { 'secret-question': 'one' },
    },
    {
      kind: 'ask-user-question',
      display: { questionIds: ['secret-question'] },
      action: 'submit',
      value: { 'secret-question': 'one', extra: 'two' },
    },
    {
      kind: 'ask-user-question',
      display: { remotePath: '/private/remote' },
      action: 'submit',
      value: { wrong: 'fallback mismatch' },
    },
    {
      kind: 'permission',
      display: {},
      action: 'approve',
      value: { answer: 'unexpected' },
    },
  ] as const)('rejects mismatched or forbidden values before pending.respond: %#', async (item) => {
    const context = harness();
    context.setPending(pendingResult(item.kind, {
      display: item.display as Record<string, RemoteHostJsonValue>,
    }));
    await context.service.connect(context.remote.id);

    const operation = context.service.respondPending(response(item.action, {
      value: item.value as unknown as RemoteHostJsonValue,
    }));
    await expect(operation).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(operation).rejects.not.toThrow(/secret-question|private\/remote/u);
    expect(methods(context.client)).toEqual(['pending.list']);
  });

  it.each([
    {
      pending: pendingResult('permission', { revision: 8 }),
      expectedRevision: 7,
      code: 'conflict',
    },
    {
      pending: pendingResult('permission', { status: 'resolved' }),
      expectedRevision: 7,
      code: 'already_decided',
    },
    {
      pending: { requests: [], revision: 7 } as PendingListResult,
      expectedRevision: 7,
      code: 'not_found',
    },
  ])('rejects stale, non-pending, or missing authoritative state: $code', async (item) => {
    const context = harness();
    context.setPending(item.pending);
    await context.service.connect(context.remote.id);

    await expect(context.service.respondPending(response('approve', {
      expectedRevision: item.expectedRevision,
    }))).rejects.toMatchObject({ code: item.code });
    expect(methods(context.client)).toEqual(['pending.list']);
  });

  it.each([
    { capabilities: [AgentDeckCapability.PendingRead] },
    { capabilities: [AgentDeckCapability.PendingRespond] },
  ])('requires both pending capabilities before any request: $capabilities', async ({ capabilities }) => {
    const context = harness(capabilities);
    await context.service.connect(context.remote.id);

    await expect(context.service.respondPending(response('approve'))).rejects.toMatchObject({
      code: 'capability_unavailable',
    });
    expect(context.client.request).not.toHaveBeenCalled();
  });

  it('fences a rescope while the authoritative pending.list is in flight', async () => {
    const context = harness();
    const pending = deferred<PendingListResult>();
    vi.mocked(context.client.request).mockImplementationOnce(() => pending.promise as never);
    await context.service.connect(context.remote.id);

    const operation = context.service.respondPending(response('approve'));
    await context.service.setSourceMode('local');
    pending.resolve(pendingResult());

    await expect(operation).rejects.toMatchObject({ code: 'stale_scope' });
    expect(methods(context.client)).toEqual(['pending.list']);
  });

  it('fences a reconnect while the authoritative pending.list is in flight', async () => {
    const context = harness();
    const pending = deferred<PendingListResult>();
    vi.mocked(context.client.request).mockImplementationOnce(() => pending.promise as never);
    await context.service.connect(context.remote.id);

    const operation = context.service.respondPending(response('approve'));
    await context.service.connect(context.remote.id);
    pending.resolve(pendingResult());

    await expect(operation).rejects.toMatchObject({ code: 'stale_scope' });
    expect(methods(context.client)).toEqual(['pending.list']);
  });
});
