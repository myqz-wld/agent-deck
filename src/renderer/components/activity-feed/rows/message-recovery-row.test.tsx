// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { MessageBubble } from './message-row';
import { resendRecoveredLocalMessage } from './resend-recovered-message';

vi.mock('./resend-recovered-message', () => ({ resendRecoveredLocalMessage: vi.fn() }));
vi.mock('@renderer/components/UploadedImageThumb', () => ({
  UploadedImageThumb: ({ alt }: { alt: string }) => <img alt={alt} />,
}));
vi.mock('@renderer/components/ImageLightbox', () => ({ ImageLightbox: () => <div role="dialog" aria-label="附件预览" /> }));
const original = '  原始消息\n包含换行与空格  ';
const event = (status: string): AgentEvent => ({
  sessionId: 'session-a', agentId: 'claude-code', kind: 'message', ts: 1,
  payload: { role: 'system', error: true, text: original,
    messageDeliveryRecovery: { status, messageId: 'input-a', attachmentCount: 1 },
    attachments: [{ kind: 'uploaded', path: '/synthetic/image.png', mime: 'image/png', bytes: 1 }],
  },
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('retained user input', () => {
  it('resends only on click, blocks duplicate clicks, and reports enqueue rather than acceptance', async () => {
    let resolve!: () => void;
    vi.mocked(resendRecoveredLocalMessage).mockReturnValue(new Promise<void>((done) => { resolve = done; }));
    render(<MessageBubble event={event('unknown')} agentId="claude-code" />);
    expect(screen.getByText('消息送达情况未知，原文已保留')).toBeTruthy();
    expect(screen.getByText(/以免重复执行/)).toBeTruthy();
    expect(resendRecoveredLocalMessage).not.toHaveBeenCalled();
    const button = screen.getByRole('button', { name: '重新发送' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(resendRecoveredLocalMessage).toHaveBeenCalledOnce();
    expect(resendRecoveredLocalMessage).toHaveBeenCalledWith('claude-code', 'session-a', expect.objectContaining({
      text: original, attachmentCount: 1,
    }));
    expect(screen.getByRole('button', { name: '发送中…' })).toHaveProperty('disabled', true);
    await act(async () => resolve());
    expect(screen.getByRole('button', { name: '已加入队列' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('status').textContent).toContain('等待 Claude 确认接收');
    expect(screen.queryByRole('button', { name: '复制原文' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看待恢复附件 1' }));
    expect(screen.getByRole('dialog', { name: '附件预览' })).toBeTruthy();
  });

  it('retains text and attachments on failure and lets the owner retry explicitly', async () => {
    vi.mocked(resendRecoveredLocalMessage).mockRejectedValueOnce(new Error('连接中断'))
      .mockResolvedValueOnce(undefined);
    render(<MessageBubble event={event('not-sent')} agentId="claude-code" />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '重新发送' })));
    expect(screen.getByRole('alert').textContent).toContain('连接中断');
    expect(document.querySelector('pre')?.textContent).toBe(original);
    expect(screen.getByRole('img', { name: '待恢复附件 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新发送' })).toHaveProperty('disabled', false);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '重新发送' })));
    expect(resendRecoveredLocalMessage).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not route a remote record into the Local sender', () => {
    render(<MessageBubble event={event('not-sent')} agentId="claude-code" showAttachments={false} />);
    expect(screen.getByRole('button', { name: '重新发送' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: '重新发送' }));
    expect(resendRecoveredLocalMessage).not.toHaveBeenCalled();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('isolates completion from a replacement conversation', async () => {
    let resolve!: () => void;
    vi.mocked(resendRecoveredLocalMessage).mockReturnValue(new Promise<void>((done) => { resolve = done; }));
    const view = render(<MessageBubble event={event('unknown')} agentId="claude-code" />);
    fireEvent.click(screen.getByRole('button', { name: '重新发送' }));
    view.rerender(<MessageBubble event={{ ...event('unknown'), sessionId: 'session-b' }} agentId="claude-code" />);
    await act(async () => resolve());
    expect(screen.getByRole('button', { name: '重新发送' })).toHaveProperty('disabled', false);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
