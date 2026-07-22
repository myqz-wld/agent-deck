// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { UploadedAttachmentEntry } from '@renderer/hooks/useImageAttachments';
import { PendingImageAttachments } from '../PendingImageAttachments';

const attachments: UploadedAttachmentEntry[] = [{
  id: 'attachment-1',
  thumbnailDataUrl: 'data:image/jpeg;base64,dGh1bWI=',
  mime: 'image/jpeg',
  bytes: 1536,
  name: 'pending.jpg',
}];

afterEach(cleanup);

describe('PendingImageAttachments', () => {
  it('opens the full pending image from the compact composer strip', () => {
    const getPreviewDataUrl = vi.fn(() => 'data:image/jpeg;base64,ZnVsbA==');
    render(
      <PendingImageAttachments
        attachments={attachments}
        getPreviewDataUrl={getPreviewDataUrl}
        onRemove={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', {
      name: '放大查看附件：pending.jpg',
    }));

    expect(getPreviewDataUrl).toHaveBeenCalledWith('attachment-1');
    const preview = screen.getByRole('dialog', { name: '图片预览' });
    expect(within(preview).getByRole('img').getAttribute('src'))
      .toBe('data:image/jpeg;base64,ZnVsbA==');
    fireEvent.click(within(preview).getByRole('button', { name: '关闭预览' }));
    expect(screen.queryByRole('dialog', { name: '图片预览' })).toBeNull();
  });
});
