import { describe, expect, it } from 'vitest';
import { FEISHU_ASSISTANT_SETUP_VERSION, FEISHU_CONVERSATION_SETUP, FEISHU_CONVERSATION_UPDATE } from './conversation-prompt';
import { credential, messageEvent, onlyClient, select, setup } from './__tests__/fixture';

describe('retained assistant setup', () => {
  it('updates an older assistant once without creating a new chat or changing work selection', async () => {
    const t = setup(); await select(t.gateway);
    await t.gateway.handle(messageEvent('first-chat', 'Remember a test word.'));
    const before = t.store.getContext(credential.instanceId, credential.credentialId, 'chat-1')!;
    const row = t.store.getSubscription(credential.instanceId, credential.credentialId, 'chat-1', before.assistantSessionId!)!;
    const { assistantSetupVersion: _older, ...legacy } = row; t.store.putSubscription(legacy);
    const client = onlyClient(t.clients); client.calls.length = 0;
    await t.gateway.handle(messageEvent('after-upgrade', 'What was the test word?'));
    await t.gateway.handle(messageEvent('following-turn', 'Continue.'));
    expect(client.calls.filter(c => c.method === 'session.console.create')).toEqual([]);
    expect(client.calls.filter(c => c.method === 'session.send').map(c => (c.params as { text: string }).text))
      .toEqual([FEISHU_CONVERSATION_UPDATE, 'What was the test word?', 'Continue.']);
    expect(t.store.getContext(credential.instanceId, credential.credentialId, 'chat-1')).toEqual(before);
    expect(t.store.getSubscription(credential.instanceId, credential.credentialId, 'chat-1', before.assistantSessionId!)?.assistantSetupVersion)
      .toBe(FEISHU_ASSISTANT_SETUP_VERSION);
    expect(FEISHU_CONVERSATION_UPDATE).toContain('catgirl');
    expect(FEISHU_CONVERSATION_UPDATE).toContain('Retain its conversation history');
    await t.gateway.close();
  });

  it('initializes new assistants with the current persona without a duplicate setup send', async () => {
    const t = setup();
    await t.gateway.handle(messageEvent('new-assistant', '你好'));
    const client = onlyClient(t.clients);
    expect(client.calls.find(c => c.method === 'session.console.create')).toMatchObject({ params: { initialMessage: FEISHU_CONVERSATION_SETUP } });
    expect(client.calls.filter(c => c.method === 'session.send').map(c => (c.params as { text: string }).text)).toEqual(['你好']);
    expect(t.transport.messages).toEqual([]);
    await t.gateway.close();
  });

  it('reuses the same setup identity when acceptance is lost and preserves explicit unsubscribe', async () => {
    const t = setup(); await t.gateway.handle(messageEvent('bootstrap', '你好'));
    const context = t.store.getContext(credential.instanceId, credential.credentialId, 'chat-1')!;
    const row = t.store.getSubscription(credential.instanceId, credential.credentialId, 'chat-1', context.assistantSessionId!)!;
    const { assistantSetupVersion: _older, ...legacy } = row;
    t.store.putSubscription({ ...legacy, status: 'inactive' });
    const client = onlyClient(t.clients); let lose = true;
    client.requestHook = c => {
      if (c.method === 'session.send' && (c.params as { text: string }).text === FEISHU_CONVERSATION_UPDATE && lose) {
        lose = false; throw Object.assign(new Error('Acceptance response lost'), { code: 'deadline_exceeded' });
      }
    };
    const input = messageEvent('setup-retry', '继续');
    await expect(t.gateway.handle(input)).rejects.toMatchObject({ code: 'deadline_exceeded' });
    await t.gateway.handle(input);
    const updates = client.calls.filter(c => c.method === 'session.send' && (c.params as { text: string }).text === FEISHU_CONVERSATION_UPDATE);
    expect(updates).toHaveLength(2);
    expect(new Set(updates.map(c => c.options?.idempotencyKey)).size).toBe(1);
    expect(t.store.getSubscription(credential.instanceId, credential.credentialId, 'chat-1', context.assistantSessionId!)?.status).toBe('inactive');
    await t.gateway.close();
  });
});
