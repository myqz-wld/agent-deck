import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@larksuiteoapi/node-sdk';
import { OfficialFeishuOpenApi } from './sdk';

describe('official Feishu OpenAPI wrapper', () => {
  it('uses the pinned SDK reply/create/patch surfaces with provider idempotency fields', async () => {
    const reply = vi.fn(async () => ({ code: 0, data: { message_id: 'om_reply' } }));
    const create = vi.fn(async () => ({ code: 0, data: { message_id: 'om_created' } }));
    const patch = vi.fn(async () => ({ code: 0 }));
    const client = {
      im: { v1: { message: { reply, create, patch } } },
    } as unknown as Client;
    const api = new OfficialFeishuOpenApi(client);

    await expect(api.reply({
      messageId: 'om_source',
      content: '{"text":"ready"}',
      messageType: 'text',
      uuid: 'ad-reply-idempotency-key',
    })).resolves.toMatchObject({ code: 0 });
    expect(reply).toHaveBeenCalledWith({
      path: { message_id: 'om_source' },
      data: {
        content: '{"text":"ready"}',
        msg_type: 'text',
        uuid: 'ad-reply-idempotency-key',
      },
    });

    await api.create({
      chatId: 'oc_chat_1',
      content: '{"schema":"2.0"}',
      messageType: 'interactive',
      uuid: 'ad-create-idempotency-key',
    });
    expect(create).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_chat_1',
        content: '{"schema":"2.0"}',
        msg_type: 'interactive',
        uuid: 'ad-create-idempotency-key',
      },
    });

    await api.patchCard({ messageId: 'om_card', content: '{"schema":"2.0"}' });
    expect(patch).toHaveBeenCalledWith({
      path: { message_id: 'om_card' },
      data: { content: '{"schema":"2.0"}' },
    });
  });
});
