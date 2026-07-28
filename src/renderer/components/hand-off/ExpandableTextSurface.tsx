import type {
  ClipboardEventHandler,
  DragEventHandler,
  JSX,
  ReactNode,
} from 'react';
import type { UploadedAttachmentEntry } from '@renderer/hooks/useImageAttachments';
import { PendingImageAttachments } from '../PendingImageAttachments';
import {
  ExpandableContent,
  type DiagnosticContentPayload,
  type ExpandableContentIdentity,
  type MessageContentPayload,
} from '../expandable-content';

interface SharedTextSurfaceProps {
  identity: ExpandableContentIdentity;
  title: string;
  ariaLabel: string;
  value: string;
  rows: number;
  maxLength: number;
  monospace?: boolean;
}

interface ExpandableAuthoringFieldProps extends SharedTextSurfaceProps {
  onChange: (value: string) => void;
  triggerLabel?: string;
  disabled?: boolean;
  placeholder?: string;
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement>;
  onDrop?: DragEventHandler<HTMLTextAreaElement>;
  onDragOver?: DragEventHandler<HTMLTextAreaElement>;
  attachments?: readonly UploadedAttachmentEntry[];
  getAttachmentPreviewDataUrl?: (id: string) => string | null;
  onRemoveAttachment?: (id: string) => void;
  expandedActions?: ReactNode;
}

interface ExpandableTextViewerProps extends SharedTextSurfaceProps {
  excerptNotice: string;
}

function textAreaClass(monospace: boolean, expanded: boolean): string {
  const dimensions = expanded
    ? 'min-h-[55vh] flex-1 resize-none'
    : 'w-full resize-y pr-12';
  return [
    dimensions,
    'rounded border border-deck-border bg-white/[0.04] px-3 py-2',
    'text-[11px] leading-relaxed text-deck-text outline-none',
    'focus:border-white/20 disabled:opacity-50',
    monospace ? 'font-mono' : '',
  ].join(' ');
}

function CharacterCount({ value, maxLength }: {
  value: string;
  maxLength: number;
}): JSX.Element {
  return (
    <div className="text-right text-[10px] text-deck-muted">
      {value.length.toLocaleString()} / {maxLength.toLocaleString()}
    </div>
  );
}

export function ExpandableAuthoringField({
  identity,
  title,
  ariaLabel,
  value,
  onChange,
  triggerLabel,
  rows,
  maxLength,
  disabled = false,
  placeholder,
  monospace = false,
  onPaste,
  onDrop,
  onDragOver,
  attachments = [],
  getAttachmentPreviewDataUrl,
  onRemoveAttachment,
  expandedActions,
}: ExpandableAuthoringFieldProps): JSX.Element {
  const payload: MessageContentPayload = {
    kind: 'message',
    text: value,
    attachments: attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.name?.trim() || '待发送图片',
      mediaType: attachment.mime,
      size: attachment.bytes,
      metadata: attachment.originalBytes
        ? { originalBytes: attachment.originalBytes }
        : undefined,
    })),
    metadata: {
      characterCount: value.length,
      characterLimit: maxLength,
    },
  };
  const textAreaProps = {
    value,
    disabled,
    maxLength,
    placeholder,
    onPaste,
    onDrop,
    onDragOver,
    onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
      onChange(event.target.value),
  };
  const canRenderAttachments = Boolean(
    attachments.length > 0
    && getAttachmentPreviewDataUrl
    && onRemoveAttachment,
  );

  return (
    <div className="space-y-1">
      <div className="relative">
        <textarea
          {...textAreaProps}
          aria-label={ariaLabel}
          rows={rows}
          className={textAreaClass(monospace, false)}
        />
        <ExpandableContent<MessageContentPayload>
          identity={identity}
          payload={payload}
          title={title}
          triggerLabel={triggerLabel ?? `展开编辑${ariaLabel}`}
          actions={expandedActions}
          validation={<CharacterCount value={value} maxLength={maxLength} />}
        >
          <div className="flex min-h-full flex-1 flex-col gap-3">
            <textarea
              {...textAreaProps}
              aria-label={`${ariaLabel}（展开编辑）`}
              rows={rows}
              className={textAreaClass(monospace, true)}
            />
            {canRenderAttachments ? (
              <fieldset disabled={disabled} className="min-w-0 border-0 p-0">
                <PendingImageAttachments
                  attachments={[...attachments]}
                  getPreviewDataUrl={getAttachmentPreviewDataUrl!}
                  onRemove={onRemoveAttachment!}
                  variant="detailed"
                />
              </fieldset>
            ) : null}
          </div>
        </ExpandableContent>
      </div>
      <CharacterCount value={value} maxLength={maxLength} />
    </div>
  );
}

export function ExpandableTextViewer({
  identity,
  title,
  ariaLabel,
  value,
  rows,
  maxLength,
  monospace = false,
  excerptNotice,
}: ExpandableTextViewerProps): JSX.Element {
  const payload: DiagnosticContentPayload = {
    kind: 'diagnostic',
    text: value,
    severity: 'info',
    metadata: {
      boundedExcerpt: true,
      characterCount: value.length,
      characterLimit: maxLength,
    },
  };
  return (
    <div className="space-y-1">
      <p className="text-[10px] leading-relaxed text-deck-muted">{excerptNotice}</p>
      <div className="relative">
        <textarea
          aria-label={ariaLabel}
          readOnly
          value={value}
          rows={rows}
          className={textAreaClass(monospace, false)}
        />
        <ExpandableContent<DiagnosticContentPayload>
          identity={identity}
          payload={payload}
          title={title}
          triggerLabel={`展开查看${ariaLabel}`}
        >
          <textarea
            aria-label={`${ariaLabel}（展开查看）`}
            readOnly
            value={value}
            rows={rows}
            className={textAreaClass(monospace, true)}
          />
        </ExpandableContent>
      </div>
    </div>
  );
}
