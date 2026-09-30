import { describe, expect, it } from 'vitest';
import type { JsonObject } from '@contracts/index';
import { credential, flush, messageEvent, onlyClient, select, session, setup } from './__tests__/fixture';

async function fixture() {
  const t = setup();
  await select(t.gateway);
  await t.gateway.handle(messageEvent('subscribe-work', '/subscribe'));
  await t.gateway.handle(messageEvent('start-assistant', '你好'));
  const context = t.store.getContext(credential.instanceId, credential.credentialId, 'chat-1')!;
  const work = { assistantSessionId: context.assistantSessionId!, requestId: 'create-work-a' };
  const client = onlyClient(t.clients);
  const emit = async (revision: number, kind: string, entityId: string, payload: JsonObject) => {
    client.emit({ instanceId: credential.instanceId, revision, kind, entityId, payload });
    await flush(); await flush();
  };
  t.transport.messages.length = 0;
  return { ...t, context, work, client, emit };
}

describe('native assistant work registration', () => {
  it('retains early work output across a temporary ID rename, then selects only the committed work', async () => {
    const t = await fixture();
    await t.emit(100, 'feishu.work.registered', 'temporary-work', t.work);
    expect(t.store.getContext(credential.instanceId, credential.credentialId, 'chat-1')).toEqual(t.context);
    expect(t.store.getSubscription(credential.instanceId, credential.credentialId, 'chat-1', 'temporary-work')?.creation)
      .toMatchObject({ ...t.work, previousWorkSessionId: 'session-1' });
    // The temporary row may already be gone when its initial user metadata is drained.
    await t.emit(101, 'event.persisted', 'temporary-work', { eventId: 20, kind: 'message', role: 'user' });
    expect(t.client.calls.some(c => c.method === 'session.history' && (c.params as { sessionId: string }).sessionId === 'temporary-work')).toBe(false);
    t.client.sessions.set('canonical-work', { ...session('canonical-work'), title: '连接验证' });
    await t.emit(102, 'session.renamed', 'canonical-work', { fromId: 'temporary-work', toId: 'canonical-work' });
    t.client.histories.set('canonical-work', [{ id: 'event-21', sessionId: 'canonical-work', sequence: 21,
      role: 'assistant', content: '工作结果', createdAt: 21 }]);
    await t.emit(103, 'event.persisted', 'canonical-work', { eventId: 21, kind: 'message', role: 'assistant' });
    expect(t.transport.messages).toHaveLength(1);
    expect(t.transport.messages[0]).toMatchObject({ text: '工作结果', presentation: {
      title: '工作会话 · 连接验证', footer: '会话 ID：canonical-work' } });
    await t.emit(104, 'feishu.work.committed', 'canonical-work', t.work);
    expect(t.store.getContext(credential.instanceId, credential.credentialId, 'chat-1')).toMatchObject({
      activeSessionId: 'canonical-work', assistantSessionId: t.context.assistantSessionId,
      assistantGeneration: t.context.assistantGeneration,
    });
    expect(t.store.getSubscription(credential.instanceId, credential.credentialId, 'chat-1', 'temporary-work')).toBeNull();
    expect(t.store.getSubscription(credential.instanceId, credential.credentialId, 'chat-1', 'canonical-work')?.creation).toBeUndefined();
    expect(t.client.calls.filter(c => c.method === 'subscription.set' && (c.params as { sessionId: string }).sessionId === 'canonical-work')).toHaveLength(1);
    await t.gateway.close();
  });

  it('preserves a newer owner selection while retaining the new work reply subscription', async () => {
    const t = await fixture();
    t.client.sessions.set('new-work', session('new-work'));
    await t.emit(100, 'feishu.work.registered', 'new-work', t.work);
    await select(t.gateway, 'session-2', 'newer-selection');
    await t.emit(101, 'feishu.work.committed', 'new-work', t.work);
    expect(t.store.getContext(credential.instanceId, credential.credentialId, 'chat-1')?.activeSessionId).toBe('session-2');
    expect(t.store.getSubscription(credential.instanceId, credential.credentialId, 'chat-1', 'new-work')?.status).toBe('active');
    await t.gateway.close();
  });

  it('removes only the failed provisional subscription and ignores another assistant identity', async () => {
    const t = await fixture();
    await t.emit(100, 'feishu.work.registered', 'unrelated', { ...t.work, assistantSessionId: 'other-assistant' });
    expect(t.store.getSubscription(credential.instanceId, credential.credentialId, 'chat-1', 'unrelated')).toBeNull();
    await t.emit(101, 'feishu.work.registered', 'failed-work', t.work);
    await t.emit(102, 'feishu.work.failed', 'failed-work', t.work);
    expect(t.store.getContext(credential.instanceId, credential.credentialId, 'chat-1')).toEqual(t.context);
    expect(t.store.getSubscription(credential.instanceId, credential.credentialId, 'chat-1', 'failed-work')).toBeNull();
    expect(t.store.getSubscription(credential.instanceId, credential.credentialId, 'chat-1', 'session-1')).not.toBeNull();
    await t.gateway.close();
  });

  it('keeps the notification lane usable and explains a subscription capacity failure', async () => {
    const t = await fixture();
    // Fill the configured bound with identity-only inactive work records.
    for (let i = t.store.listSubscriptions(credential.instanceId, credential.credentialId, 'chat-1').length; i < t.gateway.limits.maxSubscriptionsPerChat; i++) {
      t.store.putSubscription({ instanceId: credential.instanceId, credentialId: credential.credentialId,
        chatId: 'chat-1', sessionId: `retained-${i}`, purpose: 'session', status: 'inactive', updatedAt: 1 });
    }
    t.client.sessions.set('unconnected-work', session('unconnected-work'));
    await t.emit(100, 'feishu.work.registered', 'unconnected-work', t.work);
    await t.emit(101, 'feishu.work.committed', 'unconnected-work', t.work);
    expect(t.transport.messages.at(-1)?.text).toContain('当前工作会话未切换');
    expect(t.store.getCursor(credential.instanceId, credential.credentialId, 'chat-1')?.revision).toBe(101);
    expect(t.store.getContext(credential.instanceId, credential.credentialId, 'chat-1')?.activeSessionId).toBe('session-1');
    await t.gateway.close();
  });
});
