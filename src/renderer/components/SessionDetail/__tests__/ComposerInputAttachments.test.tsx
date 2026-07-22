// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { UploadedAttachmentEntry } from '@renderer/hooks/useImageAttachments';
import { ComposerInput } from '../composer-sdk/ComposerInput';

const attachment: UploadedAttachmentEntry = {
  id: 'attachment-1',
  thumbnailDataUrl: 'data:image/jpeg;base64,dGh1bWI=',
  mime: 'image/png',
  bytes: 2048,
  name: 'draft.png',
};

afterEach(cleanup);

describe('ComposerInput pending image attachments', () => {
  it('shows attachment details in the expanded editor and previews the unsent full image', () => {
    const onRemoveAttachment = vi.fn();
    render(
      <ComposerInput
        text="inspect the image"
        placeholder="编辑消息"
        submitLabel="发送"
        busy={false}
        canSubmit
        attachments={[attachment]}
        getAttachmentPreviewDataUrl={() => 'data:image/png;base64,ZnVsbA=='}
        onRemoveAttachment={onRemoveAttachment}
        onTextChange={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(true)}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '放大输入框' }));
    const expanded = screen.getByRole('dialog', { name: '放大消息输入框' });
    expect(within(expanded).getByText('待发送附件（1）')).toBeTruthy();
    expect(within(expanded).getByText('draft.png')).toBeTruthy();
    expect(within(expanded).getByText('2.0KB · image/png')).toBeTruthy();

    fireEvent.click(within(expanded).getByRole('button', {
      name: '放大查看附件：draft.png',
    }));
    const preview = screen.getByRole('dialog', { name: '图片预览' });
    expect(within(preview).getByRole('img').getAttribute('src'))
      .toBe('data:image/png;base64,ZnVsbA==');
    const closePreview = within(preview).getByRole('button', { name: '关闭预览' });
    expect(document.activeElement).toBe(closePreview);
    fireEvent.keyDown(closePreview, { key: 'Tab' });
    expect(document.activeElement).toBe(closePreview);

    fireEvent.keyDown(preview, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '图片预览' })).toBeNull();
    expect(screen.getByRole('dialog', { name: '放大消息输入框' })).toBeTruthy();

    fireEvent.click(within(expanded).getByRole('button', { name: '移除附件' }));
    expect(onRemoveAttachment).toHaveBeenCalledWith('attachment-1');
  });
});
