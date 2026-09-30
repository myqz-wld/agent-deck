import { describe, expect, it } from 'vitest';
import { parseFeishuCommand } from './commands';
import { credential, flush, messageEvent, onlyClient, select, setup } from './__tests__/fixture';

describe('Feishu readable names', () => {
  it('supports names with spaces and Unicode but rejects empty and multiline names', () => {
    expect(parseFeishuCommand('/rename 飞书 连接验证')).toEqual({ kind: 'rename', title: '飞书 连接验证' });
    expect(parseFeishuCommand('/chat rename 日常助手')).toEqual({ kind: 'rename', target: 'assistant', title: '日常助手' });
    for (const input of ['/rename', '/rename 一\n二', '/rename ' + '猫'.repeat(171)]) expect(() => parseFeishuCommand(input)).toThrow();
  });

  it('renames selected work in Core and places its ID below the readable header', async () => {
    const t = setup(); await select(t.gateway);
    const client = onlyClient(t.clients); const before = { ...client.sessions.get('session-1')! };
    await t.gateway.handle(messageEvent('name-work', '/rename 连接验证'));
    expect(client.sessions.get('session-1')).toEqual({ ...before, title: '连接验证' });
    expect(t.transport.messages.at(-1)?.presentation).toEqual({ title: '工作会话 · 连接验证 · 名称已更新',
      standalone: true, footer: '会话 ID：session-1' });
    const updates = client.calls.filter(c => c.method === 'session.name.update');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ params: { sessionId: 'session-1', title: '连接验证', expectedTitle: before.title },
      options: { idempotencyKey: 'feishu:name-work' } });
    await t.gateway.close();
  });

  it('keeps work selection separate when renaming an assistant chat', async () => {
    const t = setup(); await select(t.gateway);
    await t.gateway.handle(messageEvent('chat', '你好'));
    const before = t.store.getContext(credential.instanceId, credential.credentialId, 'chat-1')!;
    const client = onlyClient(t.clients);
    await t.gateway.handle(messageEvent('name-chat', '/chat rename 日常助手'));
    expect(client.sessions.get(before.assistantSessionId!)?.title).toBe('日常助手');
    expect(client.sessions.get('session-1')?.title).toBe('Title session-1');
    expect(t.store.getContext(credential.instanceId, credential.credentialId, 'chat-1')).toEqual(before);
    await t.gateway.close();
  });

  it('delivers work output even when its cosmetic name lookup times out', async () => {
    const t = setup(); await select(t.gateway);
    await t.gateway.handle(messageEvent('subscribe-work', '/subscribe'));
    const client = onlyClient(t.clients);
    client.requestHook = call => {
      if (call.method === 'session.console.get') throw Object.assign(new Error('Synthetic timeout'), { code: 'deadline_exceeded' });
    };
    client.histories.set('session-1', [{ id: 'event-20', sequence: 20, sessionId: 'session-1',
      role: 'assistant', content: '工作结果', createdAt: 20 }]);
    t.transport.messages.length = 0;
    client.emit({ instanceId: credential.instanceId, revision: 100, kind: 'event.persisted', entityId: 'session-1',
      payload: { eventId: 20, kind: 'message', role: 'assistant' } });
    await flush(); await flush();
    expect(t.transport.messages).toHaveLength(1);
    expect(t.transport.messages[0]).toMatchObject({ text: '工作结果', presentation: {
      title: '工作会话 · 未命名会话', footer: '会话 ID：session-1' } });
    expect(client.calls.filter(c => c.method === 'session.console.get').at(-1)?.options?.deadlineMs).toBeLessThanOrEqual(500);
    expect(t.store.getCursor(credential.instanceId, credential.credentialId, 'chat-1')?.revision).toBe(100);
    await t.gateway.close();
  });
});
