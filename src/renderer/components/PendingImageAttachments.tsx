import { useState, type JSX } from 'react';
import type { UploadedAttachmentEntry } from '@renderer/hooks/useImageAttachments';
import { DataUrlImageLightbox } from './ImageLightbox';
import { CloseIcon } from './icons';

interface Props {
  attachments: UploadedAttachmentEntry[];
  getPreviewDataUrl: (id: string) => string | null;
  onRemove: (id: string) => void;
  variant?: 'compact' | 'detailed';
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function attachmentLabel(attachment: UploadedAttachmentEntry, index: number): string {
  return attachment.name?.trim() || `附件图片 ${index + 1}`;
}

/**
 * 待发送图片的共享缩略图列表。完整 base64 仍留在 hook ref 中，只有用户
 * 点击某张图时才通过 getPreviewDataUrl 读取，避免大图进 React state。
 */
export function PendingImageAttachments({
  attachments,
  getPreviewDataUrl,
  onRemove,
  variant = 'compact',
}: Props): JSX.Element | null {
  const [previewId, setPreviewId] = useState<string | null>(null);
  if (attachments.length === 0) return null;

  const previewIndex = previewId
    ? attachments.findIndex((attachment) => attachment.id === previewId)
    : -1;
  const previewAttachment = previewIndex >= 0 ? attachments[previewIndex] : undefined;
  const previewDataUrl = previewAttachment ? getPreviewDataUrl(previewAttachment.id) : null;
  const detailed = variant === 'detailed';

  return (
    <>
      <div
        aria-label="待发送附件"
        className={detailed
          ? 'flex max-h-32 flex-wrap gap-2 overflow-y-auto scrollbar-deck'
          : 'flex min-w-0 flex-wrap gap-1.5'}
      >
        {attachments.map((attachment, index) => {
          const label = attachmentLabel(attachment, index);
          const details = `${formatBytes(attachment.bytes)} · ${attachment.mime}`;
          const compression = attachment.originalBytes
            ? `已自动压缩 ${formatBytes(attachment.originalBytes)} → ${formatBytes(attachment.bytes)}`
            : null;
          return (
            <div
              key={attachment.id}
              className={detailed
                ? 'relative flex min-w-[180px] max-w-[260px] flex-1 items-center gap-2 rounded-lg border border-deck-border bg-black/20 p-2 pr-7'
                : 'relative shrink-0'}
            >
              <button
                type="button"
                onClick={() => setPreviewId(attachment.id)}
                aria-label={`放大查看附件：${label}`}
                title={`${label}\n${details}${compression ? `\n${compression}` : ''}\n点击放大查看`}
                className="shrink-0 rounded outline-none focus-visible:ring-1 focus-visible:ring-status-working"
              >
                <img
                  src={attachment.thumbnailDataUrl}
                  alt={label}
                  className={`${detailed ? 'h-14 w-14' : 'h-9 w-9'} rounded border border-deck-border object-cover`}
                />
              </button>
              {detailed && (
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[10px] text-deck-text" title={label}>{label}</div>
                  <div className="mt-0.5 text-[9px] text-deck-muted">{details}</div>
                  {compression && (
                    <div className="mt-0.5 text-[9px] text-deck-muted/80">{compression}</div>
                  )}
                </div>
              )}
              <button
                type="button"
                onClick={() => onRemove(attachment.id)}
                className={detailed
                  ? 'absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full text-deck-muted hover:bg-white/10 hover:text-status-waiting'
                  : 'absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-deck-bg text-[10px] text-deck-muted shadow hover:text-status-waiting'}
                aria-label="移除附件"
                title={`移除 ${label}`}
              >
                <CloseIcon className="h-2.5 w-2.5" />
              </button>
            </div>
          );
        })}
      </div>
      {previewAttachment && previewDataUrl && (
        <DataUrlImageLightbox
          onClose={() => setPreviewId(null)}
          dataUrl={previewDataUrl}
          alt={`放大的${attachmentLabel(previewAttachment, previewIndex)}`}
        />
      )}
    </>
  );
}
