import { describe, expect, it, vi } from 'vitest';
import type { FeishuOutboundMessage, FeishuPendingAction } from '@gateways/im';
import { credential, messageEvent, onlyClient, pending, select, setup } from '../im/__tests__/fixture';
import { FEISHU_ACTION_PROTOCOL } from './action-envelope';
import { createFeishuAuditBundle } from './audit';
import { FeishuSdkEventAdapter } from './event-adapter';
import { HmacPendingActionNonce } from './nonce';
import { FeishuSourceRegistry } from './source-registry';
import { OfficialFeishuTransport } from './transport';

const NOW = 1_710_000_000_000;
const LIFETIME = 30 * 60_000;

async function scenario() {
  let now = NOW;
  const clock = { now: () => now, setTimer: () => ({ cancel: () => undefined }) };
  const sources = new FeishuSourceRegistry();
  const nonce = new HmacPendingActionNonce(Buffer.alloc(32, 9), { now: clock.now });
  const api = { reply: vi.fn(), create: vi.fn(), patchCard: vi.fn() };
  const transport = new OfficialFeishuTransport({ instanceId: credential.instanceId }, api, sources, nonce);
  const messages: FeishuOutboundMessage[] = [];
  const t = setup({ nonce, clock, transport: { deliverySemantics: 'event-id-idempotent',
    deliver: async (message, attempt) => {
      messages.push(message);
      if (message.kind === 'card-update') await transport.deliver(message, attempt);
    } } });
  await select(t.gateway);
  const client = onlyClient(t.clients);
  client.pending.set('session-1', [pending()]);
  await t.gateway.handle(messageEvent('show-card', '/pending'));
  const action = messages.at(-1)!.cards[0].buttons[0].action;
  const audit = createFeishuAuditBundle({ appId: credential.appId, tenantKey: credential.tenantKey,
    instanceId: credential.instanceId, topology: 'full' }, clock, () => undefined);
  const adapter = new FeishuSdkEventAdapter(t.gateway, { appId: credential.appId,
    tenantKey: credential.tenantKey, now: clock.now }, sources, audit);
  const raw = (patch: Partial<FeishuPendingAction> = {}, expiresAt: number | null = NOW + LIFETIME) => ({
    schema: '2.0', event_id: 'click-card', event_type: 'card.action.trigger', create_time: String(now * 1_000),
    token: '', app_id: credential.appId, tenant_key: credential.tenantKey, host: 'im_message',
    operator: { open_id: credential.openId, tenant_key: credential.tenantKey },
    context: { open_chat_id: action.chatId, open_message_id: 'card-message' },
    action: { tag: 'button', value: { protocol: FEISHU_ACTION_PROTOCOL, action: { ...action, ...patch }, expiresAt } },
  });
  client.calls.length = 0;
  return { ...t, client, api, adapter, raw, sources, messages, advance: (ms: number) => { now += ms; } };
}

describe('expired approval callback guidance', () => {
  it('explains presentation expiry without calling Core, replaying work or patching the card', async () => {
    const t = await scenario();
    try {
      t.advance(LIFETIME + 1);
      expect(await t.adapter.onCardAction(t.raw())).toEqual({ toast: { type: 'warning',
        content: '这张审批卡已过期。请重新获取待确认事项；若原请求已结束，请重新发起。' } });
      expect(t.client.calls).toHaveLength(0);
      expect(t.api.patchCard).not.toHaveBeenCalled();
      expect(t.api.create).not.toHaveBeenCalled();
      expect(t.sources.size()).toBe(0);
    } finally { await t.gateway.close(); }
  });

  it('does not describe malformed expired callbacks as valid expired cards', async () => {
    const t = await scenario();
    try {
      t.advance(LIFETIME + 1);
      expect(await t.adapter.handle(t.raw({ sessionId: '' }))).toMatchObject({
        code: 'invalid_event', toast: '无法识别这次飞书操作，请刷新后重试。',
      });
      expect(t.client.calls).toHaveLength(0);
    } finally { await t.gateway.close(); }
  });

  it('keeps invalid signatures separate from expiry and never queries or approves their target', async () => {
    const t = await scenario();
    try {
      expect(await t.adapter.onCardAction(t.raw({ nonce: 'v1.invalid_nonce' }))).toEqual({
        toast: { type: 'warning', content: '这张审批卡校验未通过，请重新获取待确认事项。' },
      });
      expect(t.client.calls.filter(c => c.method.startsWith('pending.'))).toHaveLength(0);
      expect(t.api.patchCard).not.toHaveBeenCalled();
    } finally { await t.gateway.close(); }
  });

  it.each([['expired', '已过期'], ['cancelled', '已取消']] as const)(
    'removes buttons for a Core-confirmed %s request without repeating its decision', async (status, label) => {
      const t = await scenario();
      try {
        t.client.pending.set('session-1', [{ ...pending(), status }]);
        expect(await t.adapter.onCardAction(t.raw())).toMatchObject({ card: { type: 'raw', data: {
          header: { title: { content: expect.stringContaining(`审批${label}`) } },
          body: { elements: [{ tag: 'markdown', content: `该审批${label}。如需继续，请重新发起请求。` }] },
        } } });
        expect(t.client.calls.filter(c => c.method === 'pending.respond')).toHaveLength(0);
        expect(t.api.patchCard).not.toHaveBeenCalled();
        expect(t.api.create).not.toHaveBeenCalled();
      } finally { await t.gateway.close(); }
    },
  );
});
