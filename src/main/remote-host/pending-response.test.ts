import { describe, expect, it, vi } from 'vitest';

import {
  AgentDeckCapability,
  createPermissionPreviewDisplay,
  MCP_PLAN_PRESENTATION_SCHEMA,
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

import { MemoryCredentialMaterialStore, testConnectionSelections } from './test-connection-fixture';
import type { RemoteHostProfileDocument } from './profile-document';
import { RemoteHostProfileStore, type RemoteHostProfileBackend } from './profile-store';
import { remoteHostPendingPresentationDigest } from './pending-response-policy';
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
      display: options.display ?? { tool: 'Bash', command: 'pwd' },
    }],
    revision: options.revision ?? 7,
  };
}

function harness(capabilities = Object.values(AgentDeckCapability) as Capability[]) {
  const local = standaloneProfile('local');
  const remote = remoteProfile('remote-pending', 'server-core');
  const client = new ControlledClient({ ...remoteHello(remote), capabilities });
  let currentPending = pendingResult();
  let currentPresentationDigest = remoteHostPendingPresentationDigest(currentPending.requests[0]!);
  let pendingResponder = () => ({ status: 'resolved' as const, revision: currentPending.revision + 1 });
  vi.mocked(client.request).mockImplementation((async (method: keyof CoreMethodMap) => {
    if (method === 'pending.list') return structuredClone(currentPending);
    if (method === 'pending.respond') return pendingResponder();
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
    connections: testConnectionSelections(createId),
    materials: new MemoryCredentialMaterialStore(),
    createId,
  });
  return {
    client,
    local,
    remote,
    service,
    response(
      action: RemoteHostPendingAction,
      options: Partial<RemoteHostPendingResponseDto> = {},
    ): RemoteHostPendingResponseDto {
      return response(action, currentPresentationDigest, options);
    },
    setPending(value: PendingListResult, bindPresentation = true): void {
      currentPending = value;
      const request = value.requests[0];
      if (bindPresentation && request?.status === 'pending') {
        currentPresentationDigest = remoteHostPendingPresentationDigest(request);
      }
    },
    setPendingResponder(responder: typeof pendingResponder): void { pendingResponder = responder; },
  };
}

function response(
  action: RemoteHostPendingAction,
  expectedPresentationDigest: string,
  options: Partial<RemoteHostPendingResponseDto> = {},
): RemoteHostPendingResponseDto {
  return {
    profileId: 'remote-pending',
    sessionId: 'session-1',
    requestId: 'request-1',
    action,
    expectedRevision: 7,
    expectedPresentationDigest,
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

    await expect(context.service.respondPending(context.response('approve'))).resolves.toEqual({
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
    {
      display: { questionIds: ['question-a', 'question-b'] },
      value: {
        'question-a': { selected: ['production'], other: 'urgent', note: 'watch metrics' },
        'question-b': { selected: [] },
      },
    },
  ])('accepts exact authoritative ask-user-question keys: %#', async ({ display, value }) => {
    const context = harness();
    context.setPending(pendingResult('ask-user-question', {
      display: display as Record<string, RemoteHostJsonValue>,
    }));
    await context.service.connect(context.remote.id);

    await context.service.respondPending(context.response('submit', {
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

  it('forwards revision feedback only for an authoritative MCP presentation', async () => {
    const context = harness();
    context.setPending(pendingResult('exit-plan', {
      display: {
        schema: MCP_PLAN_PRESENTATION_SCHEMA,
        plan: '# Plan',
      },
    }));
    await context.service.connect(context.remote.id);
    await context.service.respondPending(context.response('reject', {
      value: { feedback: 'Change the order' },
    }));
    expect(vi.mocked(context.client.request).mock.calls[1]?.[1]).toEqual({
      sessionId: 'session-1',
      requestId: 'request-1',
      action: 'reject',
      value: { feedback: 'Change the order' },
    });
  });

  it('forwards exact native exit-plan target modes and feedback', async () => {
    const context = harness();
    context.setPending(pendingResult('exit-plan', {
      display: { title: 'Deploy', summary: '# Plan' },
    }));
    await context.service.connect(context.remote.id);
    await context.service.respondPending(context.response('accept', {
      value: { targetMode: 'acceptEdits' },
    }));
    expect(vi.mocked(context.client.request).mock.calls[1]?.[1]).toEqual({
      sessionId: 'session-1',
      requestId: 'request-1',
      action: 'accept',
      value: { targetMode: 'acceptEdits' },
    });

    const feedback = harness();
    feedback.setPending(pendingResult('exit-plan', {
      display: { summary: '# Plan' },
    }));
    await feedback.service.connect(feedback.remote.id);
    await feedback.service.respondPending(feedback.response('reject', {
      value: { feedback: 'Add rollback' },
    }));
    expect(vi.mocked(feedback.client.request).mock.calls[1]?.[1]).toEqual({
      sessionId: 'session-1',
      requestId: 'request-1',
      action: 'reject',
      value: { feedback: 'Add rollback' },
    });
  });

  it('allows fallback exit-plan approval without native target modes', async () => {
    const context = harness();
    context.setPending(pendingResult('exit-plan', {
      display: { title: 'Deploy', summary: '# Plan', hint: 'future metadata' },
    }));
    await context.service.connect(context.remote.id);

    await context.service.respondPending(context.response('accept'));
    expect(vi.mocked(context.client.request).mock.calls[1]?.[1]).toEqual({
      sessionId: 'session-1', requestId: 'request-1', action: 'accept',
    });
  });

  it('permits denial but rejects approval when the authorization preview is incomplete', async () => {
    const display = createPermissionPreviewDisplay('Write', {
      file_path: '/workspace/large.txt', content: 'x'.repeat(100_000),
    });
    expect(display.complete).toBe(false);
    const denied = harness();
    denied.setPending(pendingResult('permission', { display }));
    await denied.service.connect(denied.remote.id);
    await expect(denied.service.respondPending(denied.response('deny')))
      .resolves.toMatchObject({ status: 'resolved' });

    const approved = harness();
    approved.setPending(pendingResult('permission', { display }));
    await approved.service.connect(approved.remote.id);
    await expect(approved.service.respondPending(approved.response('approve')))
      .rejects.toMatchObject({ code: 'invalid_request' });
    expect(methods(approved.client)).toEqual(['pending.list']);
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

    await expect(context.service.respondPending(context.response(action))).rejects.toMatchObject({
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
    {
      kind: 'diff-review',
      display: {},
      action: 'reject',
      value: { feedback: 'not an MCP presentation' },
    },
    {
      kind: 'exit-plan',
      display: { schema: MCP_PLAN_PRESENTATION_SCHEMA, plan: '# Plan' },
      action: 'accept',
      value: { targetMode: 'acceptEdits' },
    },
    {
      kind: 'exit-plan',
      display: { summary: '# Plan' },
      action: 'accept',
      value: { targetMode: 'unknown' },
    },
  ] as const)('rejects mismatched or forbidden values before pending.respond: %#', async (item) => {
    const context = harness();
    context.setPending(pendingResult(item.kind, {
      display: item.display as Record<string, RemoteHostJsonValue>,
    }));
    await context.service.connect(context.remote.id);

    const operation = context.service.respondPending(context.response(item.action, {
      value: item.value as unknown as RemoteHostJsonValue,
    }));
    await expect(operation).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(operation).rejects.not.toThrow(/secret-question|private\/remote/u);
    expect(methods(context.client)).toEqual(['pending.list']);
  });

  it('accepts an unchanged presentation at a later global revision and rejects display drift', async () => {
    const context = harness();
    context.setPending(pendingResult('permission', { revision: 8 }));
    await context.service.connect(context.remote.id);

    await expect(context.service.respondPending(context.response('approve', {
      expectedRevision: 7,
    }))).resolves.toMatchObject({ status: 'resolved' });
    expect(vi.mocked(context.client.request).mock.calls[1]?.[2])
      .toMatchObject({ expectedRevision: 8 });

    const drifted = pendingResult('permission', {
      revision: 9,
      display: { tool: 'Bash', command: 'rm -rf workspace' },
    });
    context.setPending(drifted, false);
    await expect(context.service.respondPending(context.response('approve')))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(methods(context.client)).toEqual(['pending.list', 'pending.respond', 'pending.list']);
  });

  it('forwards the same intent to Core replay after success may have lost its response', async () => {
    const context = harness();
    await context.service.connect(context.remote.id);
    const request = context.response('approve');
    let first = true;
    context.setPendingResponder(() => {
      if (first) {
        first = false;
        context.setPending({ requests: [], revision: 8 }, false);
        throw Object.assign(new Error('response was lost'), { code: 'deadline_exceeded' });
      }
      return { status: 'resolved', revision: 8 };
    });

    await expect(context.service.respondPending(request)).rejects.toThrow('response was lost');
    await expect(context.service.respondPending(request)).resolves.toEqual({
      status: 'resolved', revision: 8,
    });
    const responses = vi.mocked(context.client.request).mock.calls
      .filter(([method]) => method === 'pending.respond');
    expect(responses).toHaveLength(2);
    expect(responses[1]?.[2]?.idempotencyKey).toBe(responses[0]?.[2]?.idempotencyKey);
  });

  it.each([
    { capabilities: [AgentDeckCapability.PendingRead] },
    { capabilities: [AgentDeckCapability.PendingRespond] },
  ])('requires both pending capabilities before any request: $capabilities', async ({ capabilities }) => {
    const context = harness(capabilities);
    await context.service.connect(context.remote.id);

    await expect(context.service.respondPending(context.response('approve'))).rejects.toMatchObject({
      code: 'capability_unavailable',
    });
    expect(context.client.request).not.toHaveBeenCalled();
  });

  it('fences a rescope while the authoritative pending.list is in flight', async () => {
    const context = harness();
    const pending = deferred<PendingListResult>();
    vi.mocked(context.client.request).mockImplementationOnce(() => pending.promise as never);
    await context.service.connect(context.remote.id);

    const operation = context.service.respondPending(context.response('approve'));
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

    const operation = context.service.respondPending(context.response('approve'));
    await context.service.connect(context.remote.id);
    pending.resolve(pendingResult());

    await expect(operation).rejects.toMatchObject({ code: 'stale_scope' });
    expect(methods(context.client)).toEqual(['pending.list']);
  });
});
