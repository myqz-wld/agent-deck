import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, CreateSessionOptions } from '@main/adapters/types';
import type { LoadImageBlobResult, UploadedAttachmentInput, UploadedAttachmentRef } from '@shared/types';
import {
  deliverHandOffLateMessages,
  type HandOffLateMessageDeliveryDeps,
} from '../late-message-delivery';
import type { HandOffLateMessage } from '../source-precondition';

const target = { agentId: 'codex-cli', cwd: '/repo' } as CreateSessionOptions;

function lateMessage(
  eventId: number,
  text: string,
  attachments: UploadedAttachmentRef[] = [],
): HandOffLateMessage {
  return { eventId, text, attachments, origin: 'user' };
}

function adapterWithQueue(
  enqueueMessage: ReturnType<typeof vi.fn>,
): AgentAdapter {
  return { enqueueMessage } as unknown as AgentAdapter;
}

function makeDeps(options: {
  adapter?: AgentAdapter;
  loadAttachment?: (path: string) => Promise<LoadImageBlobResult>;
  writeAttachment?: (input: UploadedAttachmentInput) => Promise<UploadedAttachmentRef>;
} = {}): HandOffLateMessageDeliveryDeps {
  return {
    getAdapter: vi.fn(() => options.adapter),
    loadAttachment: vi.fn(
      options.loadAttachment ??
        (async () => {
          throw new Error('loadAttachment should not be called');
        }),
    ),
    writeAttachment: vi.fn(
      options.writeAttachment ??
        (async () => {
          throw new Error('writeAttachment should not be called');
        }),
    ),
  };
}

describe('deliverHandOffLateMessages', () => {
  it('queues late messages on the successor in source-event order', async () => {
    const deliveryOrder: string[] = [];
    const enqueueMessage = vi.fn(async (_sid: string, text: string) => {
      deliveryOrder.push(text);
    });
    const deps = makeDeps({ adapter: adapterWithQueue(enqueueMessage) });

    const created = await deliverHandOffLateMessages(
      {
        successorSessionId: 'successor',
        target,
        messages: [lateMessage(41, 'first late input'), lateMessage(42, 'second late input')],
      },
      deps,
    );

    expect(deliveryOrder).toEqual(['first late input', 'second late input']);
    expect(enqueueMessage.mock.calls).toEqual([
      ['successor', 'first late input', undefined, { bypassQueueLimit: true }],
      ['successor', 'second late input', undefined, { bypassQueueLimit: true }],
    ]);
    expect(deps.loadAttachment).not.toHaveBeenCalled();
    expect(deps.writeAttachment).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });

  it('clones attachments and queues only the cloned paths', async () => {
    const enqueueMessage = vi.fn(async () => undefined);
    const sourceAttachment: UploadedAttachmentRef = {
      kind: 'uploaded',
      path: '/uploads/source.png',
      mime: 'image/png',
      bytes: 6,
    };
    const clonedAttachment: UploadedAttachmentRef = {
      kind: 'uploaded',
      path: '/uploads/cloned.png',
      mime: 'image/png',
      bytes: 6,
    };
    const deps = makeDeps({
      adapter: adapterWithQueue(enqueueMessage),
      loadAttachment: async () => ({
        ok: true,
        dataUrl: 'data:image/png;base64,c291cmNl',
        mime: 'image/png',
        bytes: 6,
      }),
      writeAttachment: async () => clonedAttachment,
    });

    const created = await deliverHandOffLateMessages(
      {
        successorSessionId: 'successor',
        target,
        messages: [lateMessage(43, 'late input with image', [sourceAttachment])],
      },
      deps,
    );

    expect(deps.loadAttachment).toHaveBeenCalledWith('/uploads/source.png');
    expect(deps.writeAttachment).toHaveBeenCalledWith({
      kind: 'image',
      base64: 'c291cmNl',
      mime: 'image/png',
      bytes: 6,
    });
    expect(enqueueMessage).toHaveBeenCalledWith(
      'successor',
      'late input with image',
      [clonedAttachment],
      { bypassQueueLimit: true },
    );
    expect(enqueueMessage).not.toHaveBeenCalledWith(
      'successor',
      'late input with image',
      [sourceAttachment],
      { bypassQueueLimit: true },
    );
    expect(created).toEqual([clonedAttachment]);
  });

  it('fails before queueing when an attachment cannot be loaded', async () => {
    const enqueueMessage = vi.fn(async () => undefined);
    const deps = makeDeps({
      adapter: adapterWithQueue(enqueueMessage),
      loadAttachment: async () => ({ ok: false, reason: 'enoent' }),
    });

    await expect(
      deliverHandOffLateMessages(
        {
          successorSessionId: 'successor',
          target,
          messages: [
            lateMessage(44, 'missing image', [
              { kind: 'uploaded', path: '/uploads/missing.png', mime: 'image/png', bytes: 6 },
            ]),
          ],
        },
        deps,
      ),
    ).rejects.toThrow('late handoff attachment cannot be read: enoent');

    expect(deps.writeAttachment).not.toHaveBeenCalled();
    expect(enqueueMessage).not.toHaveBeenCalled();
  });

  it('fails before queueing when attachment cloning fails', async () => {
    const enqueueMessage = vi.fn(async () => undefined);
    const firstClone: UploadedAttachmentRef = {
      kind: 'uploaded',
      path: '/uploads/first-clone.png',
      mime: 'image/png',
      bytes: 6,
    };
    let writes = 0;
    const deps = makeDeps({
      adapter: adapterWithQueue(enqueueMessage),
      loadAttachment: async () => ({
        ok: true,
        dataUrl: 'data:image/png;base64,c291cmNl',
        mime: 'image/png',
        bytes: 6,
      }),
      writeAttachment: async () => {
        writes += 1;
        if (writes === 1) return firstClone;
        throw new Error('clone write failed');
      },
    });

    const delivery = deliverHandOffLateMessages(
        {
          successorSessionId: 'successor',
          target,
          messages: [
            lateMessage(45, 'unclonable image', [
              { kind: 'uploaded', path: '/uploads/source.png', mime: 'image/png', bytes: 6 },
              { kind: 'uploaded', path: '/uploads/source-2.png', mime: 'image/png', bytes: 6 },
            ]),
          ],
        },
        deps,
      );
    await expect(delivery).rejects.toThrow('clone write failed');
    await expect(delivery).rejects.toMatchObject({ createdAttachments: [firstClone] });

    expect(enqueueMessage).not.toHaveBeenCalled();
  });

  it('reports every created clone when successor queueing fails', async () => {
    const clonedAttachment: UploadedAttachmentRef = {
      kind: 'uploaded',
      path: '/uploads/queue-failed-clone.png',
      mime: 'image/png',
      bytes: 6,
    };
    const deps = makeDeps({
      adapter: adapterWithQueue(vi.fn(async () => {
        throw new Error('queue full');
      })),
      loadAttachment: async () => ({
        ok: true,
        dataUrl: 'data:image/png;base64,c291cmNl',
        mime: 'image/png',
        bytes: 6,
      }),
      writeAttachment: async () => clonedAttachment,
    });

    await expect(
      deliverHandOffLateMessages(
        {
          successorSessionId: 'successor',
          target,
          messages: [
            lateMessage(46, 'queue failure', [
              { kind: 'uploaded', path: '/uploads/source.png', mime: 'image/png', bytes: 6 },
            ]),
          ],
        },
        deps,
      ),
    ).rejects.toMatchObject({
      message: 'queue full',
      createdAttachments: [clonedAttachment],
    });
  });

  it.each([
    ['adapter is missing', undefined],
    ['adapter cannot enqueue', {} as AgentAdapter],
  ])('fails when %s', async (_label, adapter) => {
    const deps = makeDeps({ adapter });

    await expect(
      deliverHandOffLateMessages(
        {
          successorSessionId: 'successor',
          target,
          messages: [lateMessage(47, 'must be queued')],
        },
        deps,
      ),
    ).rejects.toThrow('adapter "codex-cli" cannot queue late handoff messages');

    expect(deps.loadAttachment).not.toHaveBeenCalled();
    expect(deps.writeAttachment).not.toHaveBeenCalled();
  });
});
