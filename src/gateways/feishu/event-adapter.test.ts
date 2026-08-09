import { describe, expect, it, vi } from 'vitest';
import {
  FeishuGatewayError,
  type FeishuCallbackResult,
  type FeishuSessionConsoleGateway,
} from '@gateways/im';
import { createFeishuAuditBundle } from './audit';
import { FeishuSdkEventAdapter } from './event-adapter';
import { FeishuSourceRegistry } from './source-registry';
import type { FeishuOperationalAuditEntry } from './types';

const APP_ID = 'cli_0123456789abcdef';
const TENANT_KEY = 'tenant_1';
const NOW = 1_710_000_000_000;
const accepted: FeishuCallbackResult = {
  acknowledged: true,
  duplicate: false,
  code: 'accepted',
  toast: 'Accepted',
};

function rawMessage(eventId: string, chatId: string, messageId: string): Record<string, unknown> {
  return {
    schema: '2.0',
    event_id: eventId,
    event_type: 'im.message.receive_v1',
    create_time: String(NOW * 1_000),
    token: 'verification_token',
    app_id: APP_ID,
    tenant_key: TENANT_KEY,
    sender: {
      sender_id: { open_id: `ou_${chatId}` },
      sender_type: 'user',
      tenant_key: TENANT_KEY,
    },
    message: {
      message_id: messageId,
      create_time: String(NOW),
      chat_id: chatId,
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '/sessions' }),
    },
  };
}

function fixture(handle: (event: unknown) => Promise<FeishuCallbackResult>) {
  const entries: FeishuOperationalAuditEntry[] = [];
  const sources = new FeishuSourceRegistry();
  const gateway = { handle: vi.fn(handle) } as unknown as FeishuSessionConsoleGateway;
  const audit = createFeishuAuditBundle({
    appId: APP_ID,
    tenantKey: TENANT_KEY,
    instanceId: 'instance_1',
    topology: 'server-core',
  }, {
    now: () => NOW,
    setTimer: () => ({ cancel: () => undefined }),
  }, (entry) => entries.push(entry));
  return {
    sources,
    entries,
    adapter: new FeishuSdkEventAdapter(
      gateway,
      { appId: APP_ID, tenantKey: TENANT_KEY, now: () => NOW },
      sources,
      audit,
    ),
  };
}

describe('Feishu official-SDK event adapter', () => {
  it('keeps provider reply sources in memory only for the active callback', async () => {
    let seen: unknown;
    const state = fixture(async (event) => {
      seen = state.sources.get((event as { eventId: string }).eventId);
      return accepted;
    });
    await state.adapter.onMessage(rawMessage('evt_1', 'oc_chat_1', 'om_1'));
    expect(seen).toMatchObject({
      eventId: 'evt_1', chatId: 'oc_chat_1', messageId: 'om_1', kind: 'message',
    });
    expect(state.sources.size()).toBe(0);
  });

  it('isolates simultaneous callbacks from different chats', async () => {
    const releases = new Map<string, () => void>();
    const state = fixture(async (event) => {
      const eventId = (event as { eventId: string }).eventId;
      await new Promise<void>((resolve) => releases.set(eventId, resolve));
      return accepted;
    });
    const first = state.adapter.handle(rawMessage('evt_1', 'oc_chat_1', 'om_1'));
    const second = state.adapter.handle(rawMessage('evt_2', 'oc_chat_2', 'om_2'));
    await vi.waitFor(() => expect(state.sources.size()).toBe(2));
    expect(state.sources.get('evt_1')).toMatchObject({ chatId: 'oc_chat_1' });
    expect(state.sources.get('evt_2')).toMatchObject({ chatId: 'oc_chat_2' });
    releases.get('evt_2')?.();
    await expect(second).resolves.toEqual(accepted);
    expect(state.sources.size()).toBe(1);
    releases.get('evt_1')?.();
    await expect(first).resolves.toEqual(accepted);
    expect(state.sources.size()).toBe(0);
  });

  it('acknowledges unsupported shapes fail closed with a fixed card toast', async () => {
    const state = fixture(async () => accepted);
    const raw = { ...rawMessage('evt_1', 'oc_chat_1', 'om_1'), untrusted: 'private text' };
    await expect(state.adapter.handle(raw)).resolves.toMatchObject({
      acknowledged: true,
      code: 'unknown_field',
      toast: 'Unsupported or invalid Feishu action',
    });
    expect(JSON.stringify(state.entries)).not.toContain('private text');
  });

  it('asks Feishu to retry only classified retryable dependency failures', async () => {
    const state = fixture(async () => {
      throw new FeishuGatewayError('delivery_failed', 'private dependency detail', true);
    });
    await expect(state.adapter.onMessage(rawMessage('evt_1', 'oc_chat_1', 'om_1')))
      .rejects.toThrow('Retryable Feishu event processing failure');
    expect(JSON.stringify(state.entries)).not.toContain('private dependency detail');
    expect(state.entries).toContainEqual(expect.objectContaining({
      operation: 'provider-event-handle',
      outcome: 'retryable-failure',
      code: 'delivery_failed',
    }));
  });
});
