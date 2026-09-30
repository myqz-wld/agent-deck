import { describe, expect, it } from 'vitest';
import type { FeishuAgentDeckClientFactory } from './types';
import { credential, FakeCoreClient, messageEvent, onlyClient, setup } from './__tests__/fixture';

describe('assistant purpose registration across gateway connections', () => {
  it('registers before the first unchanged owner input, caches within the connection and preserves work selection', async () => {
    const t = setup();
    await t.gateway.handle(messageEvent('work-first', '/select session-1'));
    await t.gateway.handle(messageEvent('chat-first', '只查询工作会话'));
    const client = onlyClient(t.clients); const methods = client.calls.map(call => call.method);
    expect(methods.indexOf('feishu.assistants.register')).toBeLessThan(methods.indexOf('session.send'));
    const context = t.store.getContext(credential.instanceId, credential.credentialId, 'chat-1')!;
    const registration = client.calls.find(call => call.method === 'feishu.assistants.register')!;
    expect(registration.params).toEqual({ sessionIds: [context.assistantSessionId] });
    expect(client.calls.find(call => call.method === 'session.send')?.params).toMatchObject({ text: '只查询工作会话' });
    expect(context.activeSessionId).toBe('session-1');
    await t.gateway.handle(messageEvent('chat-next', '继续'));
    expect(client.calls.filter(call => call.method === 'feishu.assistants.register')).toHaveLength(1);
    await t.gateway.close();
  });

  it('reconciles v5 assistant histories after reconnect without creating another provider session or enabling notifications', async () => {
    const first = setup();
    await first.gateway.handle(messageEvent('old-chat', '你好'));
    await first.gateway.handle(messageEvent('old-off', '/chat unsubscribe'));
    await first.gateway.handle(messageEvent('new-chat', '/chat new'));
    const oldClient = onlyClient(first.clients);
    await first.gateway.close();
    let recoveredClient!: FakeCoreClient;
    const factory: FeishuAgentDeckClientFactory = input => {
      const client = new FakeCoreClient(input);
      for (const [id, row] of oldClient.sessions) client.sessions.set(id, row);
      recoveredClient = client;
      return client;
    };
    const resumed = setup({ store: first.store, clientFactory: factory });
    await resumed.gateway.handle(messageEvent('resume', '还记得之前的聊天吗？'));
    const params = recoveredClient.calls.find(call => call.method === 'feishu.assistants.register')?.params;
    const assistantIds = resumed.store.listSubscriptions(credential.instanceId, credential.credentialId, 'chat-1')
      .filter(row => row.purpose === 'assistant').map(row => row.sessionId).sort();
    expect(params).toEqual({ sessionIds: assistantIds });
    expect(recoveredClient.calls.some(call => call.method === 'session.console.create')).toBe(false);
    expect(resumed.store.listSubscriptions(credential.instanceId, credential.credentialId, 'chat-1')
      .some(row => row.purpose === 'assistant' && row.status === 'inactive')).toBe(true);
    await resumed.gateway.close();
  });

  it('does not forward a user turn if registration cannot prove the current assistant exists', async () => {
    const t = setup(); await t.gateway.handle(messageEvent('prime', '/help'));
    const client = onlyClient(t.clients);
    client.requestHook = call => call.method === 'feishu.assistants.register'
      ? { registeredSessionIds: [], revision: 10 } : undefined;
    expect((await t.gateway.handle(messageEvent('missing', '你好'))).code).toBe('not_found');
    expect(client.calls.some(call => call.method === 'session.send')).toBe(false);
    expect(t.transport.messages.at(-1)?.text).toContain('助手聊天');
    await t.gateway.close();
  });

  it('does not register or expose assistant identities through a group work command', async () => {
    const t = setup();
    await t.gateway.handle(messageEvent('group-select', '/select session-1', { chatType: 'group' }));
    await t.gateway.handle(messageEvent('group-send', '/send 只查询', { chatType: 'group' }));
    expect(onlyClient(t.clients).calls.some(call => call.method === 'feishu.assistants.register')).toBe(false);
    await t.gateway.close();
  });
});
