// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageDeliveryRecovery } from '@shared/message-delivery-recovery';
import { resendRecoveredLocalMessage } from './resend-recovered-message';

const mocks = vi.hoisted(() => ({ updateComposer: vi.fn() }));
vi.mock('@renderer/stores/session-store', () => ({
  useSessionStore: { getState: () => ({ updateComposer: mocks.updateComposer }) },
}));
const message: MessageDeliveryRecovery = {
  status: 'unknown', messageId: 'input-a', text: '  original\ntext  ', textTruncated: false,
  attachmentCount: 1,
  attachments: [{ kind: 'uploaded', path: '/synthetic/image.png', mime: 'image/png', bytes: 1 }],
};
const load = vi.fn();
const send = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  load.mockResolvedValue({ ok: true, dataUrl: 'data:image/png;base64,YQ==', mime: 'image/png', bytes: 1 });
  send.mockResolvedValue({ messageId: 'new-input', sessionId: 'session-a' });
  Object.defineProperty(window, 'api', { configurable: true,
    value: { loadUploadedImage: load, sendAdapterMessage: send } });
});

describe('Local recovery resending', () => {
  it('loads all retained attachments and preserves the original text and existing composer draft', async () => {
    let draft = { text: 'unsent new draft', queueRefreshVersion: 2 };
    mocks.updateComposer.mockImplementation((_id, update) => { draft = update(draft); });
    await resendRecoveredLocalMessage('claude-code', 'session-a', message);
    expect(load).toHaveBeenCalledWith('/synthetic/image.png');
    expect(send).toHaveBeenCalledWith('claude-code', 'session-a', {
      text: message.text, attachments: [{ kind: 'image', base64: 'YQ==', mime: 'image/png', bytes: 1 }],
    });
    expect(draft).toEqual({ text: 'unsent new draft', queueRefreshVersion: 3 });
  });

  it('supports attachment-only messages and refreshes a redirected target queue', async () => {
    send.mockResolvedValue({ messageId: 'new-input', sessionId: 'handoff-target' });
    await resendRecoveredLocalMessage('claude-code', 'session-a', { ...message, text: '' });
    expect(send.mock.calls[0]![2].text).toBe('');
    expect(mocks.updateComposer.mock.calls.map(([id]) => id)).toEqual(['session-a', 'handoff-target']);
  });

  it('does not submit partial content when an attachment is missing', async () => {
    load.mockResolvedValue({ ok: false, reason: 'enoent' });
    await expect(resendRecoveredLocalMessage('claude-code', 'session-a', message)).rejects.toThrow('附件无法读取');
    expect(send).not.toHaveBeenCalled();
    expect(mocks.updateComposer).not.toHaveBeenCalled();
  });

  it.each([{ textTruncated: true }, { attachments: [] }])('rejects an incomplete recovery record (%j)', async (patch) => {
    await expect(resendRecoveredLocalMessage('claude-code', 'session-a', { ...message, ...patch })).rejects.toThrow();
    expect(load).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not claim success when the ordinary sending API rejects', async () => {
    send.mockRejectedValue(new Error('transport unavailable'));
    await expect(resendRecoveredLocalMessage('claude-code', 'session-a', message)).rejects.toThrow('transport unavailable');
    expect(mocks.updateComposer).not.toHaveBeenCalled();
  });
});
