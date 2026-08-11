import { describe, expect, it, vi } from 'vitest';
import type { SessionConsoleAttachmentInput } from '@contracts/index';
import type { DaemonEventSubscriptionInput } from '@hosts/daemon';
import type {
  PermissionMode,
  StoredAgentEvent,
  UploadedAttachmentRef,
} from '@shared/types';
import {
  runtimeCoreAccess as access,
  runtimeCoreHarness as harness,
  runtimeCoreInput as input,
  runtimeCoreRecord as record,
} from './runtime-core.test-fixture';

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

  it('persists Remote image attachments once and forwards only Worker-owned references', async () => {
    const attachment: SessionConsoleAttachmentInput = {
      kind: 'image', mime: 'image/png', bytes: 1, base64: 'YQ==',
    };
    const stored: UploadedAttachmentRef = {
      kind: 'uploaded', mime: 'image/png', bytes: 1, path: '/private/image.png',
    };
    const persist = vi.fn(async () => [stored]);
    const remove = vi.fn(async () => undefined);
    const { runtime, sendMessage } = harness({
      adapter: { capabilities: { canAcceptAttachments: true } as never },
      attachmentStore: { persist, remove },
    });
    await runtime.start();
    const request = input('session.send', {
      sessionId: 'session-a', text: '', attachments: [attachment],
    }, { idempotencyKey: 'attachment-intent' });
    const first = await runtime.execute(request);
    await expect(runtime.execute(request)).resolves.toEqual(first);
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith([attachment]);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      'session-a', '', [stored], { idempotencyKey: 'attachment-intent' },
    );
    expect(remove).not.toHaveBeenCalled();
  });

  it('removes persisted Remote attachments when provider acceptance fails', async () => {
    const attachment: SessionConsoleAttachmentInput = {
      kind: 'image', mime: 'image/png', bytes: 1, base64: 'YQ==',
    };
    const stored: UploadedAttachmentRef = {
      kind: 'uploaded', mime: 'image/png', bytes: 1, path: '/private/image.png',
    };
    const remove = vi.fn(async () => undefined);
    const { runtime } = harness({
      adapter: {
        capabilities: { canAcceptAttachments: true } as never,
        sendMessage: vi.fn(async () => { throw new Error('provider rejected'); }),
      },
      attachmentStore: { persist: vi.fn(async () => [stored]), remove },
    });
    await runtime.start();
    await expect(runtime.execute(input('session.send', {
      sessionId: 'session-a', text: 'inspect', attachments: [attachment],
    }, { idempotencyKey: 'attachment-failure' }))).rejects.toThrow('provider rejected');
    expect(remove).toHaveBeenCalledWith([stored]);
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
            questions: [{
              question: 'Environment?', multiSelect: true, options: [{ label: 'prod' }],
            }],
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
    await expect(runtime.execute(input('pending.respond', {
      sessionId: 'session-a', requestId: 'ask-a', action: 'submit',
      value: { q1: { selected: ['prod', 'prod'] } },
    }, { idempotencyKey: 'ask-invalid-duplicate', expectedRevision: 0 })))
      .rejects.toMatchObject({ code: 'invalid_request' });
    expect(respondAskUserQuestion).not.toHaveBeenCalled();
    await runtime.execute(input('pending.respond', {
      sessionId: 'session-a', requestId: 'ask-a', action: 'submit',
      value: { q1: { selected: ['prod'], other: 'production', note: 'release window' } },
    }, { idempotencyKey: 'ask-intent', expectedRevision: 0 }));
    expect(respondAskUserQuestion).toHaveBeenCalledWith('session-a', 'ask-a', {
      answers: [{
        question: 'Environment?',
        selected: ['prod'],
        other: 'production',
        note: 'release window',
      }],
    });
  });

  it('preserves native exit-plan target modes and revision feedback', async () => {
    const respondExitPlanMode = vi.fn(async () => undefined);
    const setup = () => harness({
      adapter: {
        listPending: () => ({
          permissions: [], askQuestions: [],
          exitPlanModes: [{
            type: 'exit-plan-mode', requestId: 'plan-a', plan: '# Deploy',
          }],
        }),
        respondExitPlanMode,
      },
    });
    const approve = setup();
    await approve.runtime.start();
    await approve.runtime.execute(input('pending.respond', {
      sessionId: 'session-a', requestId: 'plan-a', action: 'accept',
      value: { targetMode: 'acceptEdits' },
    }, { idempotencyKey: 'plan-approve', expectedRevision: 0 }));
    expect(respondExitPlanMode).toHaveBeenLastCalledWith('session-a', 'plan-a', {
      decision: 'approve', targetMode: 'acceptEdits',
    });

    const reject = setup();
    await reject.runtime.start();
    await reject.runtime.execute(input('pending.respond', {
      sessionId: 'session-a', requestId: 'plan-a', action: 'reject',
      value: { feedback: 'Add rollback' },
    }, { idempotencyKey: 'plan-reject', expectedRevision: 0 }));
    expect(respondExitPlanMode).toHaveBeenLastCalledWith('session-a', 'plan-a', {
      decision: 'keep-planning', feedback: 'Add rollback',
    });

    const bypass = setup();
    await bypass.runtime.start();
    await bypass.runtime.execute(input('pending.respond', {
      sessionId: 'session-a', requestId: 'plan-a', action: 'accept',
      value: { targetMode: 'bypassPermissions' },
    }, { idempotencyKey: 'plan-bypass', expectedRevision: 0 }));
    expect(respondExitPlanMode).toHaveBeenLastCalledWith('session-a', 'plan-a', {
      decision: 'approve-bypass',
    });
  });

  it('merges and resolves Core MCP presentations before provider pending', async () => {
    const respond = vi.fn(() => 'denied' as const);
    const { runtime } = harness({
      presentations: {
        list: () => [{
          id: 'mcp-plan-a',
          sessionId: 'session-a',
          kind: 'exit-plan',
          status: 'pending',
          createdAt: 1,
          expiresAt: null,
          display: {
            schema: 'agent-deck.mcp-plan.v1',
            plan: '# Plan',
          },
        }],
        respond,
      },
    });
    await runtime.start();
    await expect(runtime.execute(input('pending.list', { sessionId: 'session-a' })))
      .resolves.toMatchObject({
        result: { requests: [{ id: 'mcp-plan-a', kind: 'exit-plan' }] },
      });
    await expect(runtime.execute(input('pending.respond', {
      sessionId: 'session-a',
      requestId: 'mcp-plan-a',
      action: 'reject',
      value: { feedback: 'Revise it' },
    }, { idempotencyKey: 'plan-intent', expectedRevision: 0 }))).resolves.toMatchObject({
      result: { status: 'denied', revision: 1 },
    });
    expect(respond).toHaveBeenCalledWith(
      'session-a',
      'mcp-plan-a',
      'reject',
      { feedback: 'Revise it' },
    );
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
