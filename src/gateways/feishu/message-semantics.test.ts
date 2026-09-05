import { describe, expect, it } from 'vitest';
import { EventDispatcher } from '@larksuiteoapi/node-sdk';
import type { SessionHistoryEntryDto } from '@contracts/index';
import type { StoredAgentEvent } from '@shared/types';
import { serverCoreHistoryEntry } from '@hosts/server-core/runtime-history';
import { credential, messageEvent, onlyClient, select, setup } from '@gateways/im/__tests__/fixture';
import { parseFeishuCommand } from '@gateways/im/commands';
import { createFeishuAuditBundle } from './audit';
import { FeishuSdkEventAdapter } from './event-adapter';
import { mapFeishuMessageEvent } from './mapper';
import { FeishuSourceRegistry } from './source-registry';

const now = 1_710_000_000_000;
const botOpenId = 'ou_bot';
const options = { appId: credential.appId, tenantKey: credential.tenantKey, now: () => now, botOpenId };
const botMention = { key: '@_user_1', id: { open_id: botOpenId }, name: 'Agent Deck', tenant_key: credential.tenantKey };
const otherMention = { key: '@_user_2', id: { open_id: 'ou_other' }, name: 'Someone else' };
const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };

function rawEvent(text: string, group = false, mentions = group ? [botMention] : []) {
  return {
    schema: '2.0',
    header: {
      app_id: credential.appId, tenant_key: credential.tenantKey, event_id: 'evt_text',
      event_type: 'im.message.receive_v1', create_time: String(now * 1000), token: 'fixture_token',
    },
    event: {
      sender: { sender_id: { open_id: credential.openId }, sender_type: 'user', tenant_key: credential.tenantKey },
      message: {
        message_id: 'om_text', create_time: String(now), chat_id: 'chat-1',
        chat_type: group ? 'group' : 'p2p', message_type: 'text', content: JSON.stringify({ text }), mentions,
      },
    },
  };
}

function flatEvent(text: string, group = false, mentions?: typeof botMention[]) {
  const raw = rawEvent(text, group, mentions);
  return { schema: raw.schema, ...raw.header, ...raw.event };
}

function map(text: string, group = false, mentions?: typeof botMention[]) {
  const event = mapFeishuMessageEvent(flatEvent(text, group, mentions), options).event;
  if (event.kind !== 'message') throw new Error('Expected a message');
  return event.text;
}

function sdkFixture() {
  const fixture = setup();
  const sources = new FeishuSourceRegistry();
  const adapter = new FeishuSdkEventAdapter(fixture.gateway, options, sources,
    createFeishuAuditBundle({ ...credential }, {
      now: () => now, setTimer: () => ({ cancel() {} }),
    }, () => undefined));
  const dispatcher = new EventDispatcher({ logger }).register({
    'im.message.receive_v1': (event) => adapter.onMessage(event),
  });
  let eventSequence = 0;
  const send = async (text: string, group = false) => {
    const event = rawEvent(text, group);
    event.header.event_id = `evt_${++eventSequence}`;
    event.event.message.message_id = `om_${eventSequence}`;
    // Exercise the installed SDK's wire normalization with synthetic authenticated events.
    await dispatcher.invoke(event, { needCheck: false });
  };
  return { ...fixture, send };
}

describe('Feishu message text and addressed commands', () => {
  it('runs mention-addressed select and unsubscribe through the SDK and real gateway', async () => {
    const f = sdkFixture();
    try {
      await f.send('@_user_1 /select session-1', true);
      expect(onlyClient(f.clients).calls.some((call) => call.method === 'session.console.get')).toBe(true);
      await f.send('@_user_1 /unsubscribe', true);
      const calls = onlyClient(f.clients).calls;
      expect(calls).toContainEqual(expect.objectContaining({
        method: 'subscription.set', params: { sessionId: 'session-1', subscribed: false },
      }));
      expect(calls.filter((call) => call.method === 'session.send')).toEqual([]);
      expect(f.transport.messages).toHaveLength(2);
      await f.send('@_user_1 /history', true);
      expect(f.transport.messages.at(-1)?.text).toContain('群聊中已隐藏 history');
      expect(calls.some((call) => call.method === 'session.history')).toBe(false);
    } finally { await f.gateway.close(); }
  });

  it.each(['First line\nSecond line', 'First line\r\n\tSecond line'])('delivers multiline history and inbound text: %j', async (text) => {
    const f = sdkFixture();
    try {
      await select(f.gateway);
      const entry = serverCoreHistoryEntry({
        id: 10, sessionId: 'session-1', kind: 'message', agentId: 'codex-cli',
        payload: { role: 'assistant', text }, ts: now,
      } as StoredAgentEvent);
      onlyClient(f.clients).histories.set('session-1', [entry as unknown as SessionHistoryEntryDto]);
      f.transport.messages.length = 0;
      await f.send('/history');
      expect(f.transport.messages[0].text).toContain(JSON.stringify(text));
      await f.send(text);
      await f.send(`/send ${text}`);
      expect(onlyClient(f.clients).calls.filter((call) => call.method === 'session.send'))
        .toEqual([1, 2].map(() => expect.objectContaining({ params: { sessionId: 'session-1', text } })));
      expect(parseFeishuCommand(`/create codex-cli . -- ${text}`))
        .toMatchObject({ kind: 'create', initialMessage: text });
    } finally { await f.gateway.close(); }
  });

  it('keeps private commands, other mentions, embedded mentions and ordinary text intact', () => {
    expect(map('/unsubscribe')).toBe('/unsubscribe');
    expect(map('@_user_1 /unsubscribe', false, [botMention])).toBe('@_user_1 /unsubscribe');
    expect(map('plain text')).toBe('plain text');
    expect(map('  @_user_1\r\n\t/select session-1', true)).toBe('/select session-1');
    expect(map('@_user_1 First\nSecond', true)).toBe('First\nSecond');
    expect(map('@_user_2 /unsubscribe', true, [{ ...otherMention, tenant_key: credential.tenantKey }]))
      .toBe('@_user_2 /unsubscribe');
    expect(map('@_user_1 @_user_2 /unsubscribe', true, [botMention, { ...otherMention, tenant_key: credential.tenantKey }]))
      .toBe('@_user_2 /unsubscribe');
    expect(map('hello @_user_1 /unsubscribe', true)).toBe('hello @_user_1 /unsubscribe');
    expect(map('@_user_10 /unsubscribe', true)).toBe('@_user_10 /unsubscribe');
    expect(map('@_user_1/subscribe', true)).toBe('@_user_1/subscribe');
    expect(map('@_all /unsubscribe', true, [{ ...otherMention, key: '@_all', tenant_key: credential.tenantKey }]))
      .toBe('@_all /unsubscribe');
    expect(map('@_user_1 /unsubscribe', true, [{ ...botMention, tenant_key: 'other-tenant' }]))
      .toBe('@_user_1 /unsubscribe');
    const unknownBot = mapFeishuMessageEvent(flatEvent('@_user_1 /unsubscribe', true), { ...options, botOpenId: undefined });
    expect(unknownBot.event).toMatchObject({ text: '@_user_1 /unsubscribe' });
  });

  it.each(['\u0000', '\u000b', '\u000c', '\u001b', '\u007f', '\u0085', '\u2028', '\u2029'])('rejects forbidden text controls %j at mapper and command boundaries', (control) => {
    expect(() => map(`First${control}Second`)).toThrowError(expect.objectContaining({ code: 'invalid_event' }));
    expect(() => parseFeishuCommand(`/send First${control}Second`)).toThrowError(expect.objectContaining({ code: 'invalid_command' }));
  });

  it('retains identifier syntax, identity pinning and UTF-8 input bounds', async () => {
    for (const field of ['app_id', 'tenant_key', 'event_id'] as const) {
      const raw = flatEvent('First\nSecond');
      raw[field] += '\ninvalid';
      expect(() => mapFeishuMessageEvent(raw, options)).toThrow();
    }
    const sender = flatEvent('First\nSecond');
    sender.sender.sender_id.open_id += '\tinvalid';
    expect(() => mapFeishuMessageEvent(sender, options)).toThrow();
    expect(() => map('界'.repeat(6_000))).toThrow();
    expect(() => parseFeishuCommand('/select session-1\nother')).toThrow();
    expect(() => mapFeishuMessageEvent({ ...flatEvent('/help'), app_id: 'another-app' }, options))
      .toThrowError(expect.objectContaining({ code: 'access_denied' }));
    const f = setup();
    try {
      const result = await f.gateway.handle(messageEvent('foreign-owner', 'First\nSecond', { openId: 'other-owner' }));
      expect(result.code).toBe('access_denied');
      expect(f.clients.size).toBe(0);
    } finally { await f.gateway.close(); }
  });
});
