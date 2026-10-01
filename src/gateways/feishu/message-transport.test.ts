import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@larksuiteoapi/node-sdk';
import type { FeishuDeliveryAttemptContext, FeishuOutboundMessage } from '@gateways/im';
import { OfficialFeishuOpenApi } from './sdk';
import { OfficialFeishuTransport } from './transport';
import { FeishuSourceRegistry } from './source-registry';
import { HmacPendingActionNonce } from './nonce';

function fixture() {
  const create = vi.fn(async (_request: unknown) => ({ code: 0, data: { message_id: 'created' } }));
  const reply = vi.fn(async (_request: unknown) => ({ code: 0, data: { message_id: 'replied' } }));
  const patch = vi.fn();
  const api = new OfficialFeishuOpenApi({ im: { v1: { message: { create, reply, patch } } } } as unknown as Client);
  const sources = new FeishuSourceRegistry();
  const transport = new OfficialFeishuTransport({ instanceId: 'instance-1' }, api, sources,
    new HmacPendingActionNonce(Buffer.alloc(32, 7)));
  return { create, reply, patch, sources, transport };
}

function message(patch: Partial<FeishuOutboundMessage> = {}): FeishuOutboundMessage {
  return { eventId: 'event-1', instanceId: 'instance-1', credentialId: 'credential-1',
    chatId: 'chat-1', kind: 'notification', text: '**完成**\n- 第一项\n- 第二项', cards: [], ...patch };
}

const attempt = (): FeishuDeliveryAttemptContext => ({ attempt: 1, transportTry: 1,
  deadlineAt: Date.now() + 5_000, signal: new AbortController().signal, remainingMs: () => 5_000 });

describe('native Markdown post delivery', () => {
  it('sends formatted assistant output through the official SDK as one untitled post', async () => {
    const t = fixture(); const input = message();
    await t.transport.deliver(input, attempt());
    const sent = t.create.mock.calls[0][0] as { data: { msg_type: string; content: string; uuid: string } };
    expect(sent.data.msg_type).toBe('post');
    expect(JSON.parse(sent.data.content)).toEqual({ zh_cn: { content: [[{ tag: 'md', text: input.text }]] } });
    expect(sent.data.uuid).toMatch(/^ad-/u);
    expect(t.create).toHaveBeenCalledTimes(1);
    expect(t.reply).not.toHaveBeenCalled();
    expect(t.patch).not.toHaveBeenCalled();
  });

  it('keeps plain conversation as text and work-session presentation as a card', async () => {
    const t = fixture();
    await t.transport.deliver(message({ text: '是星桥呀。' }), attempt());
    expect(t.create).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ msg_type: 'text' }) }));
    await t.transport.deliver(message({ presentation: { title: '工作会话 · 目录验收', standalone: true } }), attempt());
    expect(t.create).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ msg_type: 'interactive' }) }));
  });

  it('retains the original message source and UUID when replying with rich text', async () => {
    const t = fixture(); const input = message({ kind: 'reply' });
    await t.sources.within({ eventId: input.eventId, chatId: input.chatId, messageId: 'owner-message',
      kind: 'message', occurredAt: 1 }, async () => {
      await t.transport.deliver(input, attempt());
      await t.transport.deliver(input, attempt());
    });
    expect(t.reply.mock.calls[0][0]).toEqual(t.reply.mock.calls[1][0]);
    expect(t.reply).toHaveBeenCalledWith(expect.objectContaining({ path: { message_id: 'owner-message' },
      data: expect.objectContaining({ msg_type: 'post' }) }));
    expect(t.create).not.toHaveBeenCalled();
  });

  it('does not resend a different plaintext body after an uncertain provider outcome', async () => {
    const t = fixture();
    t.create.mockRejectedValueOnce(new Error('Response lost after possible acceptance'));
    await expect(t.transport.deliver(message(), attempt())).rejects.toThrow('outcome is unknown');
    expect(t.create).toHaveBeenCalledTimes(1);
    expect(t.reply).not.toHaveBeenCalled();
  });

  it('rejects oversized rich content before sending any API request', async () => {
    const t = fixture();
    await expect(t.transport.deliver(message({ text: '**中文**'.repeat(4_000) }), attempt()))
      .rejects.toMatchObject({ code: 'delivery_too_large' });
    expect(t.create).not.toHaveBeenCalled();
  });
});
