import { describe, expect, it } from 'vitest';
import { EventDispatcher } from '@larksuiteoapi/node-sdk';
import { credential, onlyClient, setup } from '@gateways/im/__tests__/fixture';
import { createFeishuAuditBundle } from './audit';
import { FeishuSdkEventAdapter } from './event-adapter';
import { mapFeishuMessageEvent } from './mapper';
import { FeishuSourceRegistry } from './source-registry';

const now = 1_710_000_000_000;
const options = { appId: credential.appId, tenantKey: credential.tenantKey, now: () => now, botOpenId: 'ou_bot' };
function raw(content: unknown, group = false) {
  return { schema: '2.0', header: { app_id: credential.appId, tenant_key: credential.tenantKey,
    event_id: 'post-event', event_type: 'im.message.receive_v1', create_time: String(now), token: '' },
    event: { sender: { sender_id: { open_id: credential.openId }, sender_type: 'user', tenant_key: credential.tenantKey },
      message: { message_id: 'post-message', create_time: String(now), chat_id: 'chat-1',
        chat_type: group ? 'group' : 'p2p', message_type: 'post', content: JSON.stringify(content),
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, tenant_key: credential.tenantKey }] } } };
}
function map(content: unknown, group = false, overrides = {}) {
  const event = raw(content, group);
  return mapFeishuMessageEvent({ schema: event.schema, ...event.header, ...event.event }, { ...options, ...overrides }).event;
}

describe('Feishu received rich text', () => {
  it('delivers a pasted quote through the installed SDK and the actual assistant route', async () => {
    const f = setup();
    const sources = new FeishuSourceRegistry();
    const audit = createFeishuAuditBundle(credential, { now: () => now, setTimer: () => ({ cancel() {} }) }, () => undefined);
    const adapter = new FeishuSdkEventAdapter(f.gateway, options, sources, audit);
    const dispatcher = new EventDispatcher({ logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} } }).register({ 'im.message.receive_v1': value => adapter.onMessage(value) });
    try {
      const content = { title: '', content: [[{ tag: 'text', text: '沿用上次的工作配置，', style: ['bold'] }],
        [{ tag: 'text', text: '只回复连接正常。', style: [] }]], content_v2: [[{ tag: 'md', text: '> 同一内容的另一种表示' }]] };
      await dispatcher.invoke(raw(content), { needCheck: false });
      expect(onlyClient(f.clients).calls.filter(c => c.method === 'session.send')).toMatchObject([
        { params: { text: '沿用上次的工作配置，\n只回复连接正常。' } },
      ]);
      expect(sources.size()).toBe(0);
    } finally { await f.gateway.close(); }
  });

  it('keeps paragraphs, links, code and non-text placeholders without fetching attachments', () => {
    expect(map({ title: '说明', content: [[{ tag: 'a', text: '文档', href: 'https://example.test/doc' }],
      [{ tag: 'code_block', language: 'BASH', text: '/help' }],
      [{ tag: 'img', image_key: 'img_fixture' }, { tag: 'emotion', emoji_type: 'SMILE' }]] }))
      .toMatchObject({ text: '说明\n文档 (https://example.test/doc)\n\n```\n/help\n```\n\n[图片未读取][表情：SMILE]' });
    expect(map({ title: '', content_v2: [[{ tag: 'md', text: '> quoted\n\n**bold**' }]] }))
      .toMatchObject({ text: '> quoted\n\n**bold**' });
  });

  it('strips only a leading authenticated bot mention and retains other identities', () => {
    const content = { title: '', content: [[{ tag: 'at', user_id: '@_user_1' }, { tag: 'text', text: '/help' }]] };
    expect(map(content, true)).toMatchObject({ text: '/help' });
    expect(map(content, true, { botOpenId: 'different-bot' })).toMatchObject({ text: '@_user_1 /help' });
    expect(map(content, false)).toMatchObject({ text: '@_user_1 /help' });
    expect(map({ content: [[{ tag: 'at', user_id: 'all' }, { tag: 'text', text: '/help' }]] }, true))
      .toMatchObject({ text: '@_all /help' });
  });

  it.each([
    { content: [[{ tag: 'text', text: 'bad\u0000control' }]] },
    { content: [[{ tag: 'text', text: '界'.repeat(6_000) }]] },
    { content: Array.from({ length: 257 }, () => []) },
    { content: [Array.from({ length: 1_025 }, () => ({ tag: 'text', text: 'a' }))] },
    { content: [[{ tag: 'unknown', text: 'do not run' }]] },
    { content: [[{ tag: 'at', user_id: '<at id=all>' }]] },
    { content: [[{ tag: 'text', text: '' }]] },
  ])('rejects malformed or oversized rich input', value => { expect(() => map(value)).toThrow(); });
});
