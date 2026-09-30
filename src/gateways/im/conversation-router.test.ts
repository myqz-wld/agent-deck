import { describe, expect, it } from 'vitest';
import { sessionConsoleCapabilitiesFixture } from '@contracts/session-console-capabilities.fixture';
import type { FeishuAgentDeckClientFactory } from './types';
import { FEISHU_CONVERSATION_SETUP } from './conversation-prompt';
import { FakeCoreClient, credential, flush, messageEvent, onlyClient, session, setup } from './__tests__/fixture';

describe('Feishu conversational entry', () => {
  it('creates one conversation with the last saved choice, subscribes, and sends unchanged user text', async () => {
    const t = setup();
    await expect(t.gateway.handle(messageEvent('hello', '帮我检查项目\n先看看目录'))).resolves.toMatchObject({ code: 'accepted' });
    const client = onlyClient(t.clients);
    const create = client.calls.find(c => c.method === 'session.console.create')!;
    expect(create.params).toMatchObject({
      adapterId: 'codex-cli', workingDirectory: '.', initialMessage: FEISHU_CONVERSATION_SETUP,
      projectTrust: { grant: false }, options: { approvalPolicy: 'never', codexSandbox: 'workspace-write' },
    });
    expect(JSON.stringify(create.params)).not.toContain('帮我检查项目');
    const methods = client.calls.map(c => c.method);
    expect(methods.indexOf('session.console.create')).toBeLessThan(methods.indexOf('subscription.set'));
    expect(methods.indexOf('subscription.set')).toBeLessThan(methods.indexOf('session.send'));
    expect(client.calls.find(c => c.method === 'session.send')).toMatchObject({
      params: { text: '帮我检查项目\n先看看目录' }, options: { idempotencyKey: 'feishu:hello' },
    });
    expect(t.transport.messages).toHaveLength(0);
    await t.gateway.handle(messageEvent('next', '继续'));
    expect(client.calls.filter(c => c.method === 'session.console.create')).toHaveLength(1);
    expect(client.calls.filter(c => c.method === 'session.send')).toHaveLength(2);
    expect(t.store.exportMetadataSnapshot()).not.toContain('帮我检查项目');
    await t.gateway.close();
  });

  it('serializes simultaneous first messages into one session and preserves both messages', async () => {
    const t = setup();
    await t.gateway.handle(messageEvent('prime', '/help'));
    const client = onlyClient(t.clients);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    client.requestHook = async call => { if (call.method === 'session.console.create') await blocked; };
    const first = t.gateway.handle(messageEvent('parallel-a', '第一个请求'));
    const second = t.gateway.handle(messageEvent('parallel-b', '第二个请求'));
    await flush();
    expect(client.calls.filter(c => c.method === 'session.console.create')).toHaveLength(1);
    release();
    await Promise.all([first, second]);
    expect(client.calls.filter(c => c.method === 'session.console.create')).toHaveLength(1);
    expect(client.calls.filter(c => c.method === 'session.send').map(c => (c.params as { text: string }).text))
      .toEqual(['第一个请求', '第二个请求']);
    await t.gateway.close();
  });

  it('recovers a lost create response across gateway restart without storing or duplicating user text', async () => {
    let lost = true;
    const createKeys: string[] = [];
    const clients: FakeCoreClient[] = [];
    const factory: FeishuAgentDeckClientFactory = input => {
      const client = new FakeCoreClient(input); clients.push(client);
      client.requestHook = call => {
        if (call.method !== 'session.console.create') return undefined;
        createKeys.push(call.options!.idempotencyKey!);
        client.sessions.set('recovered', session('recovered'));
        if (lost) { lost = false; throw Object.assign(new Error('reply lost'), { code: 'deadline_exceeded' }); }
        return { sessionId: 'recovered', revision: 11 };
      };
      return client;
    };
    const first = setup({ clientFactory: factory });
    await expect(first.gateway.handle(messageEvent('original', '检查这个项目'))).rejects.toMatchObject({ code: 'deadline_exceeded' });
    await first.gateway.close();
    const recovered = setup({ store: first.store, clientFactory: factory });
    await expect(recovered.gateway.handle(messageEvent('original', '检查这个项目'))).resolves.toMatchObject({ code: 'accepted' });
    expect(createKeys).toHaveLength(2);
    expect(new Set(createKeys).size).toBe(1);
    expect(clients.flatMap(c => c.calls).filter(c => c.method === 'session.send')).toHaveLength(1);
    expect((await recovered.gateway.handle(messageEvent('original', '检查这个项目'))).duplicate).toBe(true);
    await recovered.gateway.close();
  });

  it('keeps a fast initial assistant event queued until the new subscription is committed', async () => {
    const t = setup();
    await t.gateway.handle(messageEvent('prime-fast', '/help'));
    const client = onlyClient(t.clients);
    client.requestHook = async call => {
      if (call.method !== 'session.console.create') return undefined;
      client.sessions.set('fast-session', session('fast-session'));
      client.histories.set('fast-session', [{ id: 'event-17', sessionId: 'fast-session', sequence: 17,
        role: 'assistant', content: '已经准备好了。', createdAt: 17 }]);
      client.emit({ instanceId: credential.instanceId, revision: 100, kind: 'event.persisted',
        entityId: 'fast-session', payload: { eventId: 17, kind: 'message' } });
      await flush();
      return { sessionId: 'fast-session', revision: 100 };
    };
    t.transport.messages.length = 0;
    await t.gateway.handle(messageEvent('fast-user', '你好'));
    await flush(); await flush();
    expect(t.transport.messages.map(m => m.text)).toEqual(['已经准备好了。']);
    expect(t.transport.messages[0]?.presentation).toBeUndefined();
    expect(t.transport.messages[0]?.cards).toEqual([]);
    await t.gateway.close();
  });

  it('preserves explicit unsubscribe and does not automatically create conversations in groups', async () => {
    const t = setup();
    await t.gateway.handle(messageEvent('start-chat', '你好'));
    await t.gateway.handle(messageEvent('off', '/chat unsubscribe'));
    const client = onlyClient(t.clients);
    client.calls.length = 0;
    await t.gateway.handle(messageEvent('while-off', '执行现有任务'));
    expect(client.calls.some(c => c.method === 'subscription.set')).toBe(false);
    expect(t.transport.messages.at(-1)?.text).toContain('回复通知已关闭');
    await t.gateway.handle(messageEvent('group-new', '你好', { chatId: 'group-chat', chatType: 'group' }));
    expect([...t.clients.values()].flatMap(c => c.calls).some(c => c.method === 'session.console.create')).toBe(false);
    await t.gateway.close();
  });

  it('presents unavailable capability and malformed command results instead of silent failures', async () => {
    const t = setup();
    await t.gateway.handle(messageEvent('prime-errors', '/help'));
    const client = onlyClient(t.clients);
    const capabilities = sessionConsoleCapabilitiesFixture('codex-cli', '.');
    client.requestHook = call => call.method === 'session.console.capabilities'
      ? { ...capabilities, adapters: capabilities.adapters.map(a => ({ ...a, enabled: false, disabledReason: 'Unavailable' })),
        create: { ...capabilities.create, enabled: false, disabledReason: 'Unavailable' } } : undefined;
    expect((await t.gateway.handle(messageEvent('unavailable-chat', '你好'))).code).toBe('capability_unavailable');
    expect(t.transport.messages.at(-1)?.presentation?.title).toBe('助手 · 暂时无法完成');
    expect(t.transport.messages.at(-1)?.text).toContain('登录');
    expect((await t.gateway.handle(messageEvent('unknown', '/missing-command'))).code).toBe('unknown_command');
    expect(t.transport.messages.at(-1)?.text).toContain('/help');
    await t.gateway.close();
  });
});
