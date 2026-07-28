import { useRef, type JSX } from 'react';
import type { UseImageAttachmentsResult } from '@renderer/hooks/useImageAttachments';
import { PendingImageAttachments } from '../PendingImageAttachments';
import { ImageIcon } from '../icons';
import { ExpandableAuthoringField } from '../hand-off/ExpandableTextSurface';

interface Props {
  identitySessionId: string;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  images: UseImageAttachmentsResult;
  acceptsAttachments: boolean;
  busy: boolean;
}

export function FirstMessageAuthoring({
  identitySessionId,
  prompt,
  onPromptChange,
  images,
  acceptsAttachments,
  busy,
}: Props): JSX.Element {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const removeImage = (id: string): void => {
    if (!busy) images.remove(id);
  };
  const addImageButton = (
    <button
      type="button"
      onClick={() => fileInputRef.current?.click()}
      disabled={busy || !acceptsAttachments}
      aria-label="在展开编辑中添加图片"
      title="添加图片"
      className="flex h-11 w-11 items-center justify-center rounded-md text-deck-muted hover:bg-white/10 disabled:opacity-40"
    >
      <ImageIcon className="h-4 w-4" />
    </button>
  );

  return (
    <>
      <div className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-deck-muted/70">
          第一条消息（文字或图片至少一项）
        </span>
        <ExpandableAuthoringField
          identity={{
            sessionId: identitySessionId,
            kind: 'payload',
            payloadId: 'first-message',
          }}
          title="编辑第一条消息"
          ariaLabel="第一条消息"
          value={prompt}
          onChange={onPromptChange}
          onPaste={!busy && acceptsAttachments ? images.onPaste : undefined}
          onDrop={!busy && acceptsAttachments ? images.onDrop : undefined}
          onDragOver={!busy && acceptsAttachments ? images.onDragOver : undefined}
          placeholder={
            acceptsAttachments
              ? '输入任务或问题；也可粘贴、拖放图片'
              : '输入任务或问题（当前运行时未协商图片输入能力）'
          }
          rows={3}
          maxLength={102_400}
          disabled={busy}
          attachments={images.attachments}
          getAttachmentPreviewDataUrl={images.getPreviewDataUrl}
          onRemoveAttachment={removeImage}
          expandedActions={addImageButton}
        />
      </div>

      {images.error ? (
        <div className="rounded bg-status-waiting/10 px-2 py-1 text-[11px] text-status-waiting">
          ⚠️ {images.error}{' '}
          <button
            type="button"
            onClick={images.dismissError}
            className="ml-1 underline hover:no-underline"
          >
            关闭
          </button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        <input
          ref={fileInputRef}
          type="file"
          aria-label="添加图片文件"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          disabled={busy || !acceptsAttachments}
          className="hidden"
          onChange={(event) => {
            if (!busy && acceptsAttachments) void images.add(event.target.files);
            event.target.value = '';
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy || !acceptsAttachments}
          className="rounded border border-dashed border-deck-border px-2 py-1 text-[10px] text-deck-muted hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
          title="上传图片（也可粘贴或拖放到第一条消息）"
        >
          <ImageIcon className="mr-1 inline h-3 w-3" />
          添加图片
        </button>
        <fieldset disabled={busy} className="min-w-0 border-0 p-0">
          <PendingImageAttachments
            attachments={images.attachments}
            getPreviewDataUrl={images.getPreviewDataUrl}
            onRemove={removeImage}
          />
        </fieldset>
      </div>
    </>
  );
}
