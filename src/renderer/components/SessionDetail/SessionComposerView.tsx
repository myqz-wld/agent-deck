import { useRef, type ComponentProps, type JSX, type ReactNode } from 'react';
import type { UploadedAttachmentEntry } from '@renderer/hooks/useImageAttachments';
import { PendingImageAttachments } from '../PendingImageAttachments';
import { HandOffIcon, ImageIcon, SendIcon, StopIcon } from '../icons';
import { StableButtonContent } from '../StableButtonContent';
import { ComposerInput } from './composer-sdk/ComposerInput';

type SharedComposerInput = ComponentProps<typeof ComposerInput>;

export interface SessionComposerAction {
  readonly disabled: boolean;
  readonly label: string;
  readonly stableLabels?: readonly string[];
  readonly title: string;
  readonly onClick: () => void;
}

/** One presentation for Local and Remote composers; controllers only supply state and commands. */
export function SessionComposerView({
  controls,
  feedback,
  queue,
  input,
  attachment,
  handOff,
  interrupt,
  submit,
}: {
  controls: ReactNode;
  feedback?: ReactNode;
  queue: ReactNode;
  input: SharedComposerInput;
  attachment: {
    enabled: boolean;
    accept: string;
    attachments: UploadedAttachmentEntry[];
    getPreviewDataUrl: (id: string) => string | null;
    onRemove: (id: string) => void;
    onAdd: (files: FileList | null) => void;
    title?: string;
  };
  handOff?: SessionComposerAction;
  interrupt: SessionComposerAction;
  submit: SessionComposerAction & { busy: boolean };
}): JSX.Element {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const interruptLabels = [...new Set([
    ...(interrupt.stableLabels ?? []),
    interrupt.label,
  ])];
  const submitIdleLabels = [...new Set([
    ...(submit.stableLabels ?? []),
    ...(submit.busy ? [] : [submit.label]),
  ])];
  return (
    <div data-session-composer className="shrink-0 border-t border-deck-border px-2.5 py-2">
      {controls}
      {feedback}
      {queue}
      <ComposerInput {...input} />
      <div className="mt-1.5 flex items-center gap-1.5">
        {attachment.enabled && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept={attachment.accept}
              multiple
              className="hidden"
              onChange={(event) => {
                attachment.onAdd(event.target.files);
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-deck-muted hover:bg-white/10 hover:text-deck-text"
              title={attachment.title ?? '上传图片（也可粘贴或拖放）'}
              aria-label="上传图片"
            >
              <ImageIcon className="h-4 w-4" />
            </button>
          </>
        )}
        <PendingImageAttachments
          attachments={attachment.attachments}
          getPreviewDataUrl={attachment.getPreviewDataUrl}
          onRemove={attachment.onRemove}
        />
        <div className="flex-1" />
        {handOff && (
          <button
            type="button"
            onClick={handOff.onClick}
            disabled={handOff.disabled}
            className="h-7 shrink-0 rounded px-2.5 text-[10px] text-deck-muted hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
            title={handOff.title}
          >
            <HandOffIcon className="mr-1 inline h-3 w-3" />{handOff.label}
          </button>
        )}
        <button
          type="button"
          onClick={interrupt.onClick}
          disabled={interrupt.disabled}
          className="h-7 shrink-0 rounded px-2.5 text-[10px] text-deck-muted hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          title={interrupt.title}
        >
          <StableButtonContent
            activeKey={interrupt.label}
            variants={interruptLabels.map((label) => ({
              key: label,
              content: <><StopIcon className="mr-1 h-3 w-3" />{label}</>,
            }))}
          />
        </button>
        <button
          type="button"
          onClick={submit.onClick}
          disabled={submit.disabled}
          title={submit.title}
          className="h-7 shrink-0 rounded bg-status-working/30 px-3 text-[10px] font-medium text-status-working hover:bg-status-working/40 disabled:opacity-40"
        >
          <StableButtonContent
            activeKey={submit.busy ? 'busy' : `idle:${submit.label}`}
            variants={[
              ...submitIdleLabels.map((label) => ({
                key: `idle:${label}`,
                content: <><SendIcon className="mr-1 h-3 w-3" />{label}</>,
              })),
              { key: 'busy', content: submit.busy ? submit.label : '发送中…' },
            ]}
          />
        </button>
      </div>
    </div>
  );
}
