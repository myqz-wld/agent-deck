import { useMemo, useState, type JSX } from 'react';
import type { UploadedAttachmentRef } from '@shared/types';
import {
  ExpandableContent,
  type MessageContentPayload,
} from '@renderer/components/expandable-content';
import { MarkdownText } from '@renderer/components/MarkdownText';
import { UploadedImageThumb } from '@renderer/components/UploadedImageThumb';
import { ImageLightbox } from '@renderer/components/ImageLightbox';
import type { RenderMode } from '../shared';
import {
  createMessageContentPayload,
  type NormalizedAgentMessage,
} from './message-content';

interface Props {
  sessionId: string;
  messageId: string;
  revision: number;
  title: string;
  message: NormalizedAgentMessage;
  mode: RenderMode;
  onToggleMode: () => void;
}

export function MessageContentViewer({
  sessionId,
  messageId,
  revision,
  title,
  message,
  mode,
  onToggleMode,
}: Props): JSX.Element {
  const payload = useMemo<MessageContentPayload>(
    () => createMessageContentPayload(message, mode),
    [message, mode],
  );

  return (
    <ExpandableContent<MessageContentPayload>
      identity={{ sessionId, kind: 'message', messageId, revision }}
      payload={payload}
      title={title}
      triggerLabel="展开消息详情"
      actions={message.text && !message.isError ? (
        <button
          type="button"
          onClick={onToggleMode}
          className="min-h-11 rounded px-3 text-xs text-deck-muted hover:bg-white/10 hover:text-deck-text"
        >
          {mode === 'markdown' ? '显示纯文本' : '显示 Markdown'}
        </button>
      ) : null}
    >
      {({ payload: selected }) => (
        <ExpandedMessage
          payload={selected}
          mode={mode}
          isError={message.isError}
          attachmentRefs={message.attachments}
          handOffContext={message.handOffContext}
        />
      )}
    </ExpandableContent>
  );
}

export function ExpandedMessage({
  payload,
  mode,
  isError,
  attachmentRefs,
  handOffContext,
}: {
  payload: MessageContentPayload;
  mode: RenderMode;
  isError: boolean;
  attachmentRefs: readonly UploadedAttachmentRef[];
  handOffContext?: string | null;
}): JSX.Element {
  const [lightboxPath, setLightboxPath] = useState<string | null>(null);
  const markdown = mode === 'markdown' && !isError;
  return (
    <div className="min-w-0 space-y-3">
      {(payload.metadata?.wireFrom || payload.metadata?.handOff) && (
        <dl className="grid min-w-0 grid-cols-[max-content_1fr] gap-x-3 gap-y-1 rounded border border-deck-border bg-white/[0.02] p-3 text-xs">
          {payload.metadata.wireFrom && (
            <>
              <dt className="text-deck-muted">来源</dt>
              <dd className="min-w-0 break-words">
                {String(payload.metadata.wireFrom)}
                {payload.metadata.wireAdapter ? ` · ${String(payload.metadata.wireAdapter)}` : ''}
              </dd>
            </>
          )}
          {payload.metadata.handOff && (
            <>
              <dt className="text-deck-muted">上下文</dt>
              <dd>{String(payload.metadata.handOff)}</dd>
            </>
          )}
        </dl>
      )}
      {handOffContext && (
        <details className="rounded border border-cyan-500/30 bg-cyan-500/5 p-3">
          <summary className="cursor-pointer text-xs text-cyan-200">查看接力上下文</summary>
          <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-cyan-100/85">
            {handOffContext}
          </pre>
        </details>
      )}
      <div className={`min-w-0 break-words text-sm leading-relaxed ${markdown ? '' : 'whitespace-pre-wrap'}`}>
        {payload.text
          ? markdown
            ? <MarkdownText text={payload.text} />
            : payload.text
          : <span className="text-deck-muted">（空消息）</span>}
      </div>
      {attachmentRefs.length > 0 && (
        <div className="flex flex-wrap gap-3" aria-label="消息附件">
          {attachmentRefs.map((attachment, index) => (
            <UploadedImageThumb
              key={`${attachment.path}-${index}`}
              path={attachment.path}
              size={120}
              alt={payload.attachments[index]?.name ?? `附件图片 ${index + 1}`}
              onClick={() => setLightboxPath(attachment.path)}
            />
          ))}
        </div>
      )}
      {lightboxPath && (
        <ImageLightbox
          path={lightboxPath}
          alt="放大的附件图片"
          onClose={() => setLightboxPath(null)}
        />
      )}
    </div>
  );
}
