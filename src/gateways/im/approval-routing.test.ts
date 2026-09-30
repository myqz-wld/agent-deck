import { describe, expect, it } from 'vitest';
import { parseFeishuCommand } from './commands';
import { credential, flush, messageEvent, onlyClient, session, setup } from './__tests__/fixture';

describe('separate assistant and work runtime controls', () => {
  it.each([
    { target: 'assistant', subscribed: true, failSubscribe: false },
    { target: 'work', subscribed: true, failSubscribe: false },
    { target: 'assistant', subscribed: false, failSubscribe: false },
    { target: 'assistant', subscribed: true, failSubscribe: true },
  ])('rebinds the exact target and preserves subscription intent across replacement: %j', async ({ target, subscribed, failSubscribe }) => {
    const t = setup();
    await t.gateway.handle(messageEvent('choose-chat', '/settings chat claude-code'));
    await t.gateway.handle(messageEvent('choose-work', '/settings session claude-code'));
    await t.gateway.handle(messageEvent('chat', '你好'));
    await t.gateway.handle(messageEvent('work', '/new'));
    const client = onlyClient(t.clients);
    const before = t.store.getContext(credential.instanceId, credential.credentialId, 'chat-1')!;
    const oldId = target === 'assistant' ? before.assistantSessionId! : before.activeSessionId!;
    const prefix = target === 'assistant' ? '/chat ' : '/';
    if (!subscribed) await t.gateway.handle(messageEvent('unsubscribe', `${prefix}unsubscribe`));
    client.requestHook = call => {
      if (failSubscribe && call.method === 'subscription.set') throw new Error('Synthetic reconnect failure');
      if (call.method !== 'session.runtime.update') return undefined;
      client.sessions.set('replacement-session', session('replacement-session', 'claude-code'));
      return { effect: 'restart-required', replacementSessionId: 'replacement-session',
        controls: { adapterId: 'claude-code', values: { claudeCodeSandbox: 'strict' }, revision: ++client.revision } };
    };
    expect((await t.gateway.handle(messageEvent('replace', `${prefix}runtime-set 10 {"claudeCodeSandbox":"strict"}`))).code).toBe('accepted');
    const after = t.store.getContext(credential.instanceId, credential.credentialId, 'chat-1')!;
    expect(after.assistantSessionId).toBe(target === 'assistant' ? 'replacement-session' : before.assistantSessionId);
    expect(after.activeSessionId).toBe(target === 'work' ? 'replacement-session' : before.activeSessionId);
    expect(t.store.getSubscription(credential.instanceId, credential.credentialId, 'chat-1', oldId)?.status).toBe('inactive');
    expect(t.store.getSubscription(credential.instanceId, credential.credentialId, 'chat-1', 'replacement-session'))
      .toMatchObject({ status: subscribed && !failSubscribe ? 'active' : 'inactive', purpose: target === 'assistant' ? 'assistant' : 'session' });
    if (failSubscribe) expect(t.transport.messages.at(-1)?.text).toContain('/chat subscribe');
    await t.gateway.handle(messageEvent('replace', `${prefix}runtime-set 10 {"claudeCodeSandbox":"strict"}`));
    expect(client.calls.filter(call => call.method === 'session.runtime.update')).toHaveLength(1);
    expect(client.preferences.conversation.claudeCodeSandbox).toBeUndefined();
    expect(client.preferences.session.claudeCodeSandbox).toBeUndefined();
    await t.gateway.close();
  });

  it('routes reads, displayed edit commands and writes to the explicitly selected purpose', async () => {
    expect(parseFeishuCommand('/chat runtime-set 8 {\n"approvalPolicy":"on-request"\n}'))
      .toEqual({ kind: 'runtime-update', target: 'assistant', expectedRevision: 8, patch: { approvalPolicy: 'on-request' } });
    const t = setup();
    await t.gateway.handle(messageEvent('chat', '你好'));
    await t.gateway.handle(messageEvent('work', '/new'));
    const context = t.store.getContext(credential.instanceId, credential.credentialId, 'chat-1')!;
    const client = onlyClient(t.clients);
    await t.gateway.handle(messageEvent('chat-runtime', '/chat runtime'));
    expect(t.transport.messages.at(-1)?.text).toContain('/chat runtime-set');
    await t.gateway.handle(messageEvent('work-runtime', '/runtime'));
    expect(t.transport.messages.at(-1)?.text).toContain('/runtime-set');
    expect(t.transport.messages.at(-1)?.text).not.toContain('/chat runtime-set');
    await t.gateway.handle(messageEvent('set-chat', '/chat runtime-set 10 {"approvalPolicy":"on-request"}'));
    await t.gateway.handle(messageEvent('set-work', '/runtime-set 11 {"codexSandbox":"read-only"}'));
    expect(client.calls.filter(c => c.method === 'session.runtime.update').map(c => c.params)).toEqual([
      { sessionId: context.assistantSessionId, patch: { approvalPolicy: 'on-request' } },
      { sessionId: context.activeSessionId, patch: { codexSandbox: 'read-only' } },
    ]);
    expect(client.preferences.conversation.approvalPolicy).toBeUndefined();
    await t.gateway.close();
  });

  it('does not let a missing unrelated subscription block an approval result or the next assistant reply', async () => {
    const t = setup();
    await t.gateway.handle(messageEvent('chat', '你好'));
    await t.gateway.handle(messageEvent('work', '/new'));
    const client = onlyClient(t.clients);
    const context = t.store.getContext(credential.instanceId, credential.credentialId, 'chat-1')!;
    client.requestHook = call => {
      if (call.method === 'pending.list' && (call.params as { sessionId: string }).sessionId === context.activeSessionId) {
        throw Object.assign(new Error('Missing old work session'), { code: 'not_found' });
      }
      return undefined;
    };
    client.calls.length = 0; t.transport.messages.length = 0;
    client.emit({ instanceId: credential.instanceId, revision: 100, kind: 'pending.responded',
      entityId: context.assistantSessionId, payload: {} });
    await flush(); await flush();
    expect(client.calls.filter(c => c.method === 'pending.list').map(c => c.params))
      .toEqual([{ sessionId: context.assistantSessionId }]);
    expect(t.transport.messages).toHaveLength(0);
    client.histories.set(context.assistantSessionId!, [{ id: 'event-30', sessionId: context.assistantSessionId!,
      sequence: 30, role: 'assistant', content: '待办已创建。', createdAt: 30 }]);
    client.emit({ instanceId: credential.instanceId, revision: 101, kind: 'event.persisted',
      entityId: context.assistantSessionId, payload: { eventId: 30, kind: 'message' } });
    await flush(); await flush();
    expect(t.transport.messages.at(-1)?.text).toBe('待办已创建。');
    expect(t.transport.messages.at(-1)?.presentation).toBeUndefined();
    await t.gateway.close();
  });
});
