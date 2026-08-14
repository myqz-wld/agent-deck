import { describe, expect, it, vi } from 'vitest';
import {
  FeishuTransportNotAcceptedError,
  type FeishuDeliveryAttemptContext,
  type FeishuOutboundMessage,
  type FeishuPendingAction,
} from '@gateways/im';
import { FEISHU_ACTION_PROTOCOL } from './action-envelope';
import { renderFeishuCard } from './card-renderer';
import { mapFeishuCardActionEvent, mapFeishuMessageEvent } from './mapper';
import { HmacPendingActionNonce } from './nonce';
import { FeishuSourceRegistry } from './source-registry';
import { OfficialFeishuTransport } from './transport';
import type { FeishuOpenApiPort } from './types';

const APP_ID = 'cli_0123456789abcdef';
const TENANT_KEY = 'tenant_key_1';
const NOW = 1_710_000_000_000;

function rawMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: '2.0',
    event_id: 'evt_message_1',
    event_type: 'im.message.receive_v1',
    create_time: String(NOW * 1_000),
    token: 'verification_token',
    app_id: APP_ID,
    tenant_key: TENANT_KEY,
    sender: {
      sender_id: { open_id: 'ou_owner_1', union_id: 'on_union_1' },
      sender_type: 'user',
      tenant_key: TENANT_KEY,
    },
    message: {
      message_id: 'om_message_1',
      create_time: String(NOW),
      chat_id: 'oc_chat_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '/sessions' }),
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot_1' } }],
    },
    ...overrides,
  };
}

function pendingAction(action: FeishuPendingAction['action']): Omit<FeishuPendingAction, 'value'> {
  return {
    name: 'pending.respond',
    instanceId: 'instance_1',
    credentialId: 'credential_1',
    chatId: 'oc_chat_1',
    chatType: 'p2p',
    sessionId: 'session_1',
    requestId: 'request_1',
    revision: 7,
    contentDigest: 'sha256_digest_1',
    action,
    nonce: 'v1.valid_nonce',
  };
}

function rawCard(
  action: FeishuPendingAction['action'] = 'approve',
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: '2.0',
    event_id: 'evt_card_1',
    event_type: 'card.action.trigger',
    create_time: String(NOW * 1_000),
    token: 'callback_token',
    app_id: APP_ID,
    tenant_key: TENANT_KEY,
    operator: { open_id: 'ou_owner_1', tenant_key: TENANT_KEY, name: 'Owner' },
    host: 'im_message',
    context: { open_chat_id: 'oc_chat_1', open_message_id: 'om_card_1' },
    action: {
      tag: 'button',
      value: {
        protocol: FEISHU_ACTION_PROTOCOL,
        action: pendingAction(action),
        expiresAt: NOW + 30_000,
      },
      ...extra,
    },
  };
}

function attempt(signal = new AbortController().signal): FeishuDeliveryAttemptContext {
  return {
    attempt: 1,
    transportTry: 1,
    deadlineAt: NOW + 1_000,
    signal,
    remainingMs: () => 1_000,
  };
}

function signer(lifetime = 1_800_000): HmacPendingActionNonce {
  return new HmacPendingActionNonce(Buffer.alloc(32, 9), {
    now: () => NOW,
    defaultLifetimeMs: lifetime,
  });
}

function outbound(
  overrides: Partial<FeishuOutboundMessage> = {},
): FeishuOutboundMessage {
  return {
    eventId: 'evt_message_1',
    instanceId: 'instance_1',
    credentialId: 'credential_1',
    chatId: 'oc_chat_1',
    kind: 'reply',
    text: 'Ready',
    cards: [],
    ...overrides,
  };
}

function fakeApi() {
  const calls: Array<{ operation: string; input: unknown }> = [];
  const api: FeishuOpenApiPort = {
    reply: vi.fn(async (input) => {
      calls.push({ operation: 'reply', input });
      return { code: 0, data: { message_id: 'om_reply' } };
    }),
    create: vi.fn(async (input) => {
      calls.push({ operation: 'create', input });
      return { code: 0, data: { message_id: 'om_created' } };
    }),
    patchCard: vi.fn(async (input) => {
      calls.push({ operation: 'patch', input });
      return { code: 0 };
    }),
  };
  return { api, calls };
}

describe('strict Feishu SDK event mapping', () => {
  const options = { appId: APP_ID, tenantKey: TENANT_KEY, now: () => NOW };

  it('maps only a pinned tenant user text event and preserves the provider source in memory', () => {
    const mapped = mapFeishuMessageEvent(rawMessage(), options);
    expect(mapped.event).toMatchObject({
      kind: 'message',
      eventId: 'evt_message_1',
      chatId: 'oc_chat_1',
      openId: 'ou_owner_1',
      text: '/sessions',
      occurredAt: NOW,
    });
    expect(mapped.source).toEqual({
      eventId: 'evt_message_1',
      chatId: 'oc_chat_1',
      messageId: 'om_message_1',
      kind: 'message',
      occurredAt: NOW,
    });
  });

  it.each([
    [rawMessage({ tenant_key: 'another_tenant' }), 'access_denied'],
    [rawMessage({ surprise: true }), 'unknown_field'],
    [rawMessage({ message: { ...(rawMessage().message as object), message_type: 'image' } }), 'unknown_command'],
    [rawMessage({ sender: { sender_id: { open_id: 'ou_owner_1' }, sender_type: 'bot', tenant_key: TENANT_KEY } }), 'access_denied'],
  ])('rejects unknown, cross-tenant, bot, and unsupported message shapes', (raw, code) => {
    expect(() => mapFeishuMessageEvent(raw, options)).toThrow(expect.objectContaining({ code }));
  });

  it('maps a bound button callback and rejects expired or ambiguous callback shapes', () => {
    const mapped = mapFeishuCardActionEvent(rawCard(), options);
    expect(mapped.event).toMatchObject({
      kind: 'card-action',
      openId: 'ou_owner_1',
      action: { action: 'approve', requestId: 'request_1', revision: 7 },
    });
    expect(() => mapFeishuCardActionEvent(
      rawCard('approve', { option: 'unexpected' }),
      options,
    )).toThrow(expect.objectContaining({ code: 'unknown_command' }));
    const expired = rawCard();
    ((expired.action as Record<string, unknown>).value as Record<string, unknown>).expiresAt = NOW - 1;
    expect(() => mapFeishuCardActionEvent(expired, options))
      .toThrow(expect.objectContaining({ code: 'invalid_nonce' }));
  });

  it('maps exactly the issued form fields back to Core question ids', () => {
    const raw = rawCard('submit', {
      form_value: { q_a: 'first', q_b: ['second'] },
    });
    const value = (raw.action as Record<string, unknown>).value as Record<string, unknown>;
    value.fields = [
      { providerKey: 'q_a', questionId: 'question-a' },
      { providerKey: 'q_b', questionId: 'question-b' },
    ];
    const mapped = mapFeishuCardActionEvent(raw, options);
    expect(mapped.event).toMatchObject({
      action: { value: { 'question-a': 'first', 'question-b': ['second'] } },
    });
    ((raw.action as Record<string, unknown>).form_value as Record<string, unknown>).extra = 'no';
    expect(() => mapFeishuCardActionEvent(raw, options))
      .toThrow(expect.objectContaining({ code: 'invalid_event' }));
  });
});

describe('official API transport and modern cards', () => {
  it('reuses one bounded provider uuid for safe reply reconciliation', async () => {
    const { api, calls } = fakeApi();
    const sources = new FeishuSourceRegistry();
    const transport = new OfficialFeishuTransport(
      { instanceId: 'instance_1' }, api, sources, signer(),
    );
    const source = {
      eventId: 'evt_message_1', chatId: 'oc_chat_1', messageId: 'om_message_1',
      kind: 'message' as const, occurredAt: NOW,
    };
    await sources.within(source, async () => {
      await transport.deliver(outbound(), attempt());
      await transport.deliver(outbound(), attempt());
    });
    const uuids = calls.map((call) => (call.input as { uuid: string }).uuid);
    expect(new Set(uuids).size).toBe(1);
    expect(uuids[0]).toMatch(/^ad-[A-Za-z0-9_-]{43}$/);
    expect(uuids[0].length).toBeLessThanOrEqual(50);
  });

  it('creates notifications, patches callback cards, and isolates chats', async () => {
    const { api, calls } = fakeApi();
    const sources = new FeishuSourceRegistry();
    const transport = new OfficialFeishuTransport(
      { instanceId: 'instance_1' }, api, sources, signer(),
    );
    await transport.deliver(outbound({
      eventId: 'notification_1', kind: 'notification', chatId: 'oc_chat_2',
    }), attempt());
    await sources.within({
      eventId: 'evt_card_1', chatId: 'oc_chat_1', messageId: 'om_card_1',
      kind: 'card-action', occurredAt: NOW,
    }, () => transport.deliver(outbound({
      eventId: 'evt_card_1', kind: 'card-update', text: 'Updated',
    }), attempt()));
    expect(calls).toMatchObject([
      { operation: 'create', input: { chatId: 'oc_chat_2' } },
      { operation: 'patch', input: { messageId: 'om_card_1' } },
    ]);
    await expect(sources.within({
      eventId: 'evt_message_1', chatId: 'oc_other', messageId: 'om_message_1',
      kind: 'message', occurredAt: NOW,
    }, () => transport.deliver(outbound(), attempt())))
      .rejects.toMatchObject({ code: 'event_identity_mismatch' });
  });

  it('renders schema 2.0 callback behaviors without unbound action payloads', () => {
    const action = pendingAction('approve');
    const content = renderFeishuCard(outbound({
      cards: [{
        title: 'Approval', requestId: 'request_1', sessionId: 'session_1', state: 'pending',
        createdAt: NOW, presentedAt: NOW, expiresAt: null, presentationLifetimeMs: 1_800_000,
        display: { summary: 'review' }, buttons: [{ label: 'Approve', action }],
      }],
    }), signer());
    const card = JSON.parse(content);
    expect(card).toMatchObject({ schema: '2.0', config: { update_multi: true } });
    const button = card.body.elements.find((element: { tag: string }) => element.tag === 'button');
    expect(button.behaviors[0]).toMatchObject({
      type: 'callback',
      value: {
        protocol: FEISHU_ACTION_PROTOCOL,
        action: expect.objectContaining({
          requestId: action.requestId,
          revision: action.revision,
          action: action.action,
          nonce: expect.stringMatching(/^v1\.[0-9]+\.[A-Za-z0-9_-]{43}$/),
        }),
      },
    });
  });

  it('starts the presentation lifetime when the card is issued, not when Core created it', () => {
    const action = pendingAction('approve');
    const content = renderFeishuCard(outbound({
      cards: [{
        title: 'Old request', requestId: 'request_1', sessionId: 'session_1', state: 'pending',
        createdAt: NOW - 40 * 60_000,
        presentedAt: NOW,
        expiresAt: null,
        presentationLifetimeMs: 30 * 60_000,
        display: { summary: 'review' },
        buttons: [{ label: 'Approve', action }],
      }],
    }), signer());
    const card = JSON.parse(content);
    const button = card.body.elements.find((element: { tag: string }) => element.tag === 'button');
    expect(button.behaviors[0].value.expiresAt).toBe(NOW + 30 * 60_000);
  });

  it('binds modern form field names to the exact Core-issued question ids', () => {
    const action = pendingAction('submit');
    const card = JSON.parse(renderFeishuCard(outbound({
      cards: [{
        title: 'Questions', requestId: 'request_1', sessionId: 'session_1', state: 'pending',
        createdAt: NOW, presentedAt: NOW, expiresAt: null, presentationLifetimeMs: 0,
        display: {
          prompt: 'Questions',
          questionIds: ['question-a', 'question-b'],
          questions: [{
            id: 'question-a', question: 'Question A?', multiSelect: false, options: [],
          }, {
            id: 'question-b', question: 'Question B?', multiSelect: false, options: [],
          }],
        },
        buttons: [{ label: 'Submit', action }],
      }],
    }), signer(0)));
    const form = card.body.elements.find((element: { tag: string }) => element.tag === 'form');
    const callback = form.elements.at(-1).behaviors[0].value;
    expect(callback.expiresAt).toBeNull();
    expect(callback.fields.map((field: { questionId: string }) => field.questionId))
      .toEqual(['question-a', 'question-b']);
    expect(form.elements.slice(0, 2).map((field: { name: string }) => field.name))
      .toEqual(callback.fields.map((field: { providerKey: string }) => field.providerKey));
  });

  it('classifies pre-invocation aborts and explicit provider rejection as definitely not accepted', async () => {
    const { api } = fakeApi();
    vi.mocked(api.reply).mockResolvedValueOnce({ code: 9 });
    const sources = new FeishuSourceRegistry();
    const transport = new OfficialFeishuTransport(
      { instanceId: 'instance_1' }, api, sources, signer(),
    );
    const source = {
      eventId: 'evt_message_1', chatId: 'oc_chat_1', messageId: 'om_message_1',
      kind: 'message' as const, occurredAt: NOW,
    };
    await expect(sources.within(source, () => transport.deliver(outbound(), attempt())))
      .rejects.toBeInstanceOf(FeishuTransportNotAcceptedError);
    const controller = new AbortController();
    controller.abort();
    await expect(sources.within(source, () => transport.deliver(outbound(), attempt(controller.signal))))
      .rejects.toBeInstanceOf(FeishuTransportNotAcceptedError);
    vi.mocked(api.reply).mockRejectedValueOnce(new Error('secret-bearing SDK failure'));
    await expect(sources.within(source, () => transport.deliver(outbound(), attempt())))
      .rejects.toThrow('Feishu provider transport outcome is unknown');
  });
});
