import { describe, expect, it } from 'vitest';
import { credential, flush, messageEvent, onlyClient, select, setup } from './__tests__/fixture';

describe('subscribed work send receipt ordering', () => {
  it('does not append an obsolete receipt when a lost acceptance is retried after the work reply', async () => {
    const t = setup();
    await select(t.gateway);
    const client = onlyClient(t.clients);
    const accepted = new Set<string>();
    let executions = 0;
    client.requestHook = call => {
      if (call.method !== 'session.send') return undefined;
      const key = call.options!.idempotencyKey!;
      if (!accepted.has(key)) {
        accepted.add(key);
        executions++;
        throw Object.assign(new Error('Core accepted; response timed out'), { code: 'deadline_exceeded' });
      }
      return { messageId: 'work-input', sequence: 40, revision: 40 };
    };
    const event = messageEvent('work-send', '/send 检查连接');
    t.transport.messages.length = 0;
    await expect(t.gateway.handle(event)).rejects.toMatchObject({ code: 'deadline_exceeded' });
    client.histories.set('session-1', [{ id: 'event-41', sessionId: 'session-1', sequence: 41,
      role: 'assistant', content: '工作会话连接正常', createdAt: 41 }]);
    client.emit({ instanceId: credential.instanceId, revision: 41, kind: 'event.persisted',
      entityId: 'session-1', payload: { eventId: 41, kind: 'message' } });
    await flush(); await flush();
    expect(t.transport.messages.map(m => m.text)).toEqual(['工作会话连接正常']);

    await expect(t.gateway.handle(event)).resolves.toMatchObject({ code: 'accepted' });
    await expect(t.gateway.handle(event)).resolves.toMatchObject({ code: 'deduplicated' });
    expect(executions).toBe(1);
    expect(client.calls.filter(c => c.method === 'session.send')).toHaveLength(2);
    expect(t.transport.messages.map(m => m.text)).toEqual(['工作会话连接正常']);
    expect(t.transport.messages[0]?.presentation?.title).toContain('工作会话');
    await t.gateway.close();
  });

  it('preserves explicit unsubscribe and tells the owner how to receive work replies', async () => {
    const t = setup();
    await select(t.gateway);
    await t.gateway.handle(messageEvent('off', '/unsubscribe'));
    t.transport.messages.length = 0;
    const client = onlyClient(t.clients);
    client.calls.length = 0;
    await t.gateway.handle(messageEvent('work-no-notify', '/send 检查连接'));
    expect(client.calls.filter(c => c.method === 'session.send')).toHaveLength(1);
    expect(client.calls.some(c => c.method === 'subscription.set')).toBe(false);
    expect(t.transport.messages).toHaveLength(1);
    expect(t.transport.messages[0]?.text).toContain('回复通知已关闭，发送 /subscribe 可以恢复');
    expect(t.transport.messages[0]?.text).not.toContain('正在处理');
    await t.gateway.close();
  });

  it('keeps group confirmation factual when no private reply subscription is available', async () => {
    const t = setup();
    await t.gateway.handle(messageEvent('group-select', '/select session-1', { chatType: 'group' }));
    t.transport.messages.length = 0;
    await t.gateway.handle(messageEvent('group-send', '/send 检查连接', { chatType: 'group' }));
    expect(t.transport.messages).toHaveLength(1);
    expect(t.transport.messages[0]?.text).toBe('消息已发送。');
    await t.gateway.close();
  });

  it('continues to show a rejected work send even with an active reply subscription', async () => {
    const t = setup();
    await select(t.gateway);
    const client = onlyClient(t.clients);
    client.requestHook = call => {
      if (call.method === 'session.send') throw Object.assign(new Error('Rejected'), { code: 'not_found' });
    };
    t.transport.messages.length = 0;
    expect((await t.gateway.handle(messageEvent('rejected-send', '/send 检查连接'))).code).toBe('not_found');
    expect(t.transport.messages).toHaveLength(1);
    expect(t.transport.messages[0]?.presentation?.title).toContain('暂时无法完成');
    await t.gateway.close();
  });
});
