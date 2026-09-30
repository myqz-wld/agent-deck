import { describe, expect, it, vi } from 'vitest';
import type { AgentDeckEventEnvelope } from '@contracts/index';
import { DEFAULT_GATEWAY_CLOCK } from '@gateways/im/gateway-config';
import { credential, flush, onlyClient, select, setup } from '@gateways/im/__tests__/fixture';
import { FeishuMessageReactions } from './message-reactions';
import { FeishuSourceRegistry } from './source-registry';
import { createFeishuAuditBundle } from './audit';
import { FeishuSdkEventAdapter } from './event-adapter';

describe('authenticated input to delivered reply progress', () => {
  it('updates the input only after the subscribed reply and native completion, even before send returns', async () => {
    const sources = new FeishuSourceRegistry();
    const api = { addReaction: vi.fn(async (_id: string, emoji: string) => ({ code: 0,
      data: { reaction_id: `r-${emoji}`, operator: { operator_id: credential.appId, operator_type: 'app' as const } } })),
      deleteReaction: vi.fn(async () => ({ code: 0 })) };
    const progress = new FeishuMessageReactions(api, sources, DEFAULT_GATEWAY_CLOCK, credential.appId, () => true, () => undefined);
    const f = setup({ progress });
    const adapter = new FeishuSdkEventAdapter(f.gateway, { appId: credential.appId, tenantKey: credential.tenantKey, now: Date.now },
      sources, createFeishuAuditBundle(credential, DEFAULT_GATEWAY_CLOCK, () => undefined));
    const raw = { schema: '2.0', app_id: credential.appId, tenant_key: credential.tenantKey, token: '',
      event_id: 'send-now', create_time: String(Date.now()), event_type: 'im.message.receive_v1',
      sender: { sender_id: { open_id: credential.openId }, sender_type: 'user', tenant_key: credential.tenantKey },
      message: { message_id: 'om_input', chat_id: 'chat-1', chat_type: 'p2p', create_time: String(Date.now()),
        message_type: 'post', content: JSON.stringify({ content: [[{ tag: 'text', text: '/send hello' }]] }) } };
    try {
      await select(f.gateway);
      const client = onlyClient(f.clients);
      client.histories.set('session-1', [{ id: 'event-101', sequence: 101, sessionId: 'session-1',
        role: 'assistant', content: '工作会话连接正常', createdAt: Date.now() }]);
      const emit = (revision: number, eventId: number, kind: string, extra = {}) => client.emit({
        instanceId: credential.instanceId, entityId: 'session-1', kind: 'event.persisted', revision,
        payload: { eventId, kind, ...extra },
      } as AgentDeckEventEnvelope);
      client.requestHook = call => {
        if (call.method === 'session.send') {
          emit(30, 100, 'message', { role: 'user', correlationId: 'feishu:send-now' });
          emit(31, 101, 'message', { role: 'assistant' });
          emit(32, 102, 'finished', { ok: true });
          client.revision = 33;
        }
      };
      f.transport.messages.length = 0;
      f.transport.holdChat = 'chat-1';
      expect(await adapter.handle(raw)).toMatchObject({ code: 'accepted' });
      await flush();
      expect(api.addReaction).toHaveBeenCalledWith('om_input', 'Typing');
      expect(api.addReaction).not.toHaveBeenCalledWith('om_input', 'DONE');
      expect(f.transport.releaseHold).not.toBeNull();
      f.transport.holdChat = null;
      f.transport.releaseHold!();
      await flush(); await flush();
      expect(f.transport.messages.map(m => m.text)).toEqual(['工作会话连接正常']);
      expect(api.addReaction).toHaveBeenLastCalledWith('om_input', 'DONE');
      expect(await adapter.handle(raw)).toMatchObject({ duplicate: true });
      expect(client.calls.filter(c => c.method === 'session.send')).toHaveLength(1);
      expect(f.store.exportMetadataSnapshot()).not.toMatch(/om_input|工作会话连接正常|hello/);
    } finally { f.transport.releaseHold?.(); await f.gateway.close(); }
  });
});
