import { describe, expect, it } from 'vitest';
import { credential, FakeCoreClient, flush, messageEvent, onlyClient, setup } from './__tests__/fixture';
import { parseFeishuCommand } from './commands';

describe('independent Feishu assistant and work contexts', () => {
  it('keeps ordinary text on the assistant across work creation, selection and gateway restart', async () => {
    const t = setup();
    await t.gateway.handle(messageEvent('choose-chat', '/settings chat codex-cli {"model":"chat-model","thinking":"max"}'));
    await t.gateway.handle(messageEvent('choose-work', '/settings session codex-cli {"model":"work-model","thinking":"medium"}'));
    await t.gateway.handle(messageEvent('remember', '记住这个聊天里的要求'));
    const client = onlyClient(t.clients);
    const assistant = t.store.getContext(credential.instanceId, credential.credentialId, 'chat-1')!.assistantSessionId!;
    await t.gateway.handle(messageEvent('work-new', '/new 检查项目'));
    const context = t.store.getContext(credential.instanceId, credential.credentialId, 'chat-1')!;
    expect(context.assistantSessionId).toBe(assistant);
    expect(context.activeSessionId).not.toBe(assistant);
    const creates = client.calls.filter(c => c.method === 'session.console.create');
    expect(creates.map(c => c.params)).toEqual([
      expect.objectContaining({ options: expect.objectContaining({ model: 'chat-model', thinking: 'max' }) }),
      expect.objectContaining({ initialMessage: '检查项目', options: expect.objectContaining({ model: 'work-model', thinking: 'medium' }) }),
    ]);
    await t.gateway.handle(messageEvent('to-work', '/send 执行任务'));
    await t.gateway.handle(messageEvent('to-assistant', '我刚才说了什么'));
    expect(client.calls.filter(c => c.method === 'session.send').slice(-2).map(c => c.params)).toEqual([
      { sessionId: context.activeSessionId, text: '执行任务' },
      { sessionId: assistant, text: '我刚才说了什么' },
    ]);
    await t.gateway.handle(messageEvent('select-work', '/select session-1'));
    await t.gateway.close();
    let next!: FakeCoreClient;
    const resumed = setup({ store: t.store, clientFactory: input => {
      next = new FakeCoreClient(input);
      for (const [id, record] of client.sessions) next.sessions.set(id, record);
      return next;
    } });
    await resumed.gateway.handle(messageEvent('after-restart', '继续刚才的聊天'));
    expect(next.calls.some(c => c.method === 'session.console.create')).toBe(false);
    expect(next.calls.find(c => c.method === 'session.send')?.params)
      .toEqual({ sessionId: assistant, text: '继续刚才的聊天' });
    expect(resumed.store.getContext(credential.instanceId, credential.credentialId, 'chat-1')?.activeSessionId).toBe('session-1');
    await resumed.gateway.close();
  });

  it('resets only the assistant and preserves independent history and work notifications', async () => {
    const t = setup();
    await t.gateway.handle(messageEvent('chat', '你好'));
    await t.gateway.handle(messageEvent('work', '/new'));
    const before = t.store.getContext(credential.instanceId, credential.credentialId, 'chat-1')!;
    await t.gateway.handle(messageEvent('reset', '/chat new'));
    const after = t.store.getContext(credential.instanceId, credential.credentialId, 'chat-1')!;
    expect(after.activeSessionId).toBe(before.activeSessionId);
    expect(after.assistantSessionId).not.toBe(before.assistantSessionId);
    expect(after.assistantGeneration).toBe(before.assistantGeneration + 1);
    expect(t.store.getSubscription(credential.instanceId, credential.credentialId, 'chat-1', before.assistantSessionId!)?.status).toBe('inactive');
    expect(t.store.getSubscription(credential.instanceId, credential.credentialId, 'chat-1', before.activeSessionId!)?.status).toBe('active');
    await t.gateway.handle(messageEvent('chat-history', '/chat history'));
    await t.gateway.handle(messageEvent('work-history', '/history'));
    expect(onlyClient(t.clients).calls.filter(c => c.method === 'session.history').map(c => c.params)).toEqual([
      expect.objectContaining({ sessionId: after.assistantSessionId }),
      expect.objectContaining({ sessionId: before.activeSessionId }),
    ]);
    await t.gateway.handle(messageEvent('work-list', '/sessions'));
    expect(t.transport.messages.at(-1)?.text).not.toContain(`ID：${before.assistantSessionId}`);
    await t.gateway.handle(messageEvent('chat-list', '/chat list'));
    expect(t.transport.messages.at(-1)?.text).toContain(`ID：${before.assistantSessionId}`);
    expect(t.transport.messages.at(-1)?.text).not.toContain(`ID：${before.activeSessionId}`);
    expect((await t.gateway.handle(messageEvent('wrong-target', `/select ${before.assistantSessionId}`))).code).toBe('session_target_mismatch');
    await t.gateway.handle(messageEvent('restore-chat', `/chat select ${before.assistantSessionId}`));
    expect(t.store.getContext(credential.instanceId, credential.credentialId, 'chat-1'))
      .toMatchObject({ assistantSessionId: before.assistantSessionId, activeSessionId: before.activeSessionId });
    expect(t.store.getSubscription(credential.instanceId, credential.credentialId, 'chat-1', before.assistantSessionId!)?.status).toBe('active');
    await t.gateway.close();
  });

  it('keeps assistant replies as unlabelled text and work replies as identified cards', async () => {
    const t = setup();
    await t.gateway.handle(messageEvent('chat', '你好'));
    await t.gateway.handle(messageEvent('work', '/new'));
    const state = t.store.getContext(credential.instanceId, credential.credentialId, 'chat-1')!;
    const client = onlyClient(t.clients);
    t.transport.messages.length = 0;
    for (const [id, text, revision] of [[state.assistantSessionId!, '这是助手回答。', 101], [state.activeSessionId!, '这是工作结果。', 102]] as const) {
      client.histories.set(id, [{ id: `event-${revision}`, sessionId: id, sequence: revision, role: 'assistant', content: text, createdAt: revision }]);
      client.emit({ instanceId: credential.instanceId, revision, kind: 'event.persisted', entityId: id,
        payload: { eventId: revision, kind: 'message' } });
      await flush(); await flush();
    }
    expect(t.transport.messages).toHaveLength(2);
    expect(t.transport.messages[0]).toMatchObject({ text: '这是助手回答。', cards: [] });
    expect(t.transport.messages[0].presentation).toBeUndefined();
    expect(t.transport.messages[1]).toMatchObject({ text: '这是工作结果。',
      presentation: { title: `工作会话 · Title ${state.activeSessionId}`, standalone: true,
        footer: `会话 ID：${state.activeSessionId}` } });
    await t.gateway.close();
  });

  it('does not turn explicit work commands or group messages into assistant conversations', async () => {
    const t = setup();
    expect((await t.gateway.handle(messageEvent('work', '/send 检查项目'))).code).toBe('session_not_selected');
    expect((await t.gateway.handle(messageEvent('history', '/chat history'))).code).toBe('assistant_not_started');
    expect((await t.gateway.handle(messageEvent('group', '/chat new', { chatType: 'group' }))).code).toBe('private_configuration');
    expect([...t.clients.values()].flatMap(c => c.calls).some(c => c.method === 'session.console.create')).toBe(false);
    expect(parseFeishuCommand('/new 首行\n第二行')).toMatchObject({ kind: 'new', initialMessage: '首行\n第二行' });
    await t.gateway.close();
  });
});
