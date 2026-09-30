import { describe, expect, it } from 'vitest';
import type { SessionHistoryEntryDto } from '@contracts/index';
import { credential, flush, messageEvent, onlyClient, pending, select, setup } from './__tests__/fixture';
import { readFeishuAssistantMessage } from './notification-message';
import { resolveGatewayLimits } from './gateway-config';
import { validateCoreNotificationEvent } from './subscription-events';

function entry(id: number, content: string, role: SessionHistoryEntryDto['role'] = 'assistant'):
SessionHistoryEntryDto {
  return { id: `event-${id}`, sessionId: 'session-1', sequence: id, role, content, createdAt: id };
}

function persisted(id = 17, kind = 'message', revision = 100) {
  return {
    instanceId: credential.instanceId, revision, kind: 'event.persisted', entityId: 'session-1',
    payload: { eventId: id, kind, adapterId: 'grok-build', timestamp: id, text: 'untrusted-push-body' },
  };
}

describe('Feishu authoritative assistant responses', () => {
  it('delivers the actual persisted assistant event instead of a status notice or push payload', async () => {
    const test = setup();
    await select(test.gateway);
    await test.gateway.handle(messageEvent('subscribe-replies', '/subscribe'));
    const client = onlyClient(test.clients);
    client.histories.set('session-1', [entry(18, 'newer unrelated reply'), entry(17, '检查完成，测试通过。')]);
    test.transport.messages.length = 0;
    client.emit(persisted());
    await flush(); await flush();
    expect(test.transport.messages).toHaveLength(1);
    expect(test.transport.messages[0]).toMatchObject({ kind: 'notification', text: '检查完成，测试通过。', cards: [] });
    expect(JSON.stringify(test.transport.messages)).not.toMatch(/untrusted-push-body|newer unrelated/);
    expect(test.store.getCursor(credential.instanceId, credential.credentialId, 'chat-1')?.revision).toBe(100);
    await test.gateway.close();
  });

  it('consumes user/thinking events without echo and reads native pending requests', async () => {
    const test = setup();
    await select(test.gateway);
    await test.gateway.handle(messageEvent('subscribe-native-events', '/subscribe'));
    const client = onlyClient(test.clients);
    client.histories.set('session-1', [entry(17, 'user message', 'user')]);
    test.transport.messages.length = 0;
    client.emit(persisted());
    client.emit(persisted(18, 'thinking', 101));
    await flush(); await flush();
    expect(test.transport.messages).toHaveLength(0);
    client.pending.set('session-1', [pending()]);
    client.emit(persisted(19, 'waiting-for-user', 102));
    await flush(); await flush();
    expect(test.transport.messages).toHaveLength(1);
    expect(test.transport.messages[0].cards).toHaveLength(1);
    await test.gateway.close();
  });

  it.each(['group', 'unsubscribed', 'different-session'] as const)('does not read or expose history for %s', async (mode) => {
    const test = setup();
    const chatType = mode === 'group' ? 'group' : 'p2p';
    await test.gateway.handle(messageEvent('select-protected', '/select session-1', { chatType }));
    if (mode !== 'unsubscribed') {
      await test.gateway.handle(messageEvent('subscribe-protected', '/subscribe', { chatType }));
    }
    const client = onlyClient(test.clients);
    client.histories.set('session-1', [entry(17, 'private answer')]);
    test.transport.messages.length = 0;
    client.calls.length = 0;
    client.emit({ ...persisted(), ...(mode === 'different-session' ? { entityId: 'session-2' } : {}) });
    await flush(); await flush();
    expect(test.transport.messages).toHaveLength(0);
    expect(client.calls.some(call => call.method === 'session.history')).toBe(false);
    await test.gateway.close();
  });

  it('retains only bounded event identity metadata in the queue', () => {
    expect(validateCoreNotificationEvent(persisted(), credential, 99)).toEqual({
      instanceId: credential.instanceId, revision: 100, kind: 'event.persisted', entityId: 'session-1',
      persisted: { eventId: 17, kind: 'message' },
    });
    for (const id of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => validateCoreNotificationEvent(persisted(id), credential, 99))
        .toThrow('Persisted message identity');
    }
  });

  it('rechecks unsubscribe after asynchronous history lookup before sending private text', async () => {
    const test = setup();
    await select(test.gateway);
    await test.gateway.handle(messageEvent('subscribe-before-read', '/subscribe'));
    const client = onlyClient(test.clients);
    client.requestHook = ({ method }) => {
      if (method !== 'session.history') return undefined;
      const subscription = test.store.getSubscription(credential.instanceId,
        credential.credentialId, 'chat-1', 'session-1')!;
      test.store.putSubscription({ ...subscription, status: 'inactive' });
      return { entries: [entry(17, 'private late reply')], nextCursor: null, revision: 100 };
    };
    test.transport.messages.length = 0;
    client.emit(persisted());
    await flush(); await flush();
    expect(test.transport.messages).toHaveLength(0);
    await test.gateway.close();
  });

  it('follows bounded history pages to the exact event and permits the Core 8-KiB history field', async () => {
    const test = setup();
    await select(test.gateway);
    const client = onlyClient(test.clients);
    const text = 'a'.repeat(8_192) + '…';
    client.requestHook = ({ method, params }) => method !== 'session.history' ? undefined : {
      entries: (params as { cursor?: string }).cursor ? [entry(17, text)] : [entry(23, 'a later answer')],
      nextCursor: (params as { cursor?: string }).cursor ? null : 'history-page-1', revision: 100,
    };
    const result = await readFeishuAssistantMessage(
      { client, hello: client.hello, subscription: null },
      validateCoreNotificationEvent(persisted(), credential, 99),
      resolveGatewayLimits(undefined), () => 2_000,
    );
    expect(result).toBe(text);
    expect(client.calls.filter(call => call.method === 'session.history')).toHaveLength(2);
    await test.gateway.close();
  });

  it('reports unavailable older content without substituting a different response', async () => {
    const test = setup();
    await select(test.gateway);
    const client = onlyClient(test.clients);
    client.histories.set('session-1', [entry(25, 'do not send this')]);
    const result = await readFeishuAssistantMessage(
      { client, hello: client.hello, subscription: null },
      validateCoreNotificationEvent(persisted(), credential, 99),
      resolveGatewayLimits(undefined), () => 2_000,
    );
    expect(result).toContain('/history');
    expect(result).not.toContain('do not send');
    await test.gateway.close();
  });
});
