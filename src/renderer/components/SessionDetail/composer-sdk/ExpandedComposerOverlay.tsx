import { useModalFocus } from '../../use-modal-focus';
import { useLayoutEffect, useRef, type DragEventHandler, type ClipboardEventHandler,
  type JSX, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { UploadedAttachmentEntry } from '@renderer/hooks/useImageAttachments';
import type { SessionCommandDescriptor } from '@shared/types';
import { PendingImageAttachments } from '../../PendingImageAttachments';
import { CloseIcon, ImageIcon, SendIcon } from '../../icons';
import { StableButtonContent } from '../../StableButtonContent';
import { commandCompletion, SlashCommandMenu } from './SlashCommandMenu';
import { matchingSessionCommands } from '@shared/session-commands';

interface Props {
  text: string;
  placeholder: string;
  submitLabel: string;
  busy: boolean;
  canSubmit: boolean;
  attachments: UploadedAttachmentEntry[];
  getAttachmentPreviewDataUrl: (id: string) => string | null;
  onRemoveAttachment: (id: string) => void;
  onTextChange: (value: string) => void;
  onSubmit: () => Promise<boolean>;
  commands?: readonly SessionCommandDescriptor[];
  onClose: () => void;
  attachmentPicker?: {
    accept: string;
    title?: string;
    onAdd: (files: FileList | null) => void;
  };
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement>;
  onDrop?: DragEventHandler<HTMLTextAreaElement>;
  onDragOver?: DragEventHandler<HTMLTextAreaElement>;
}

function shouldSubmit(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  return event.key === 'Enter' &&
    !event.shiftKey &&
    !event.nativeEvent.isComposing &&
    event.nativeEvent.keyCode !== 229;
}

export function ExpandedComposerOverlay(props: Props): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstCommand = matchingSessionCommands(props.commands ?? [], props.text, 1)[0];
  useModalFocus({ dialogRef, onClose: props.onClose, blocked: props.busy });
  useLayoutEffect(() => { textareaRef.current?.focus(); }, []);

  const submit = async (): Promise<void> => {
    if (!props.canSubmit) return;
    if (await props.onSubmit()) props.onClose();
  };

  return createPortal(
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="no-drag absolute inset-0 z-50 flex flex-col bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="放大消息输入框"
    >
      <div className="absolute inset-0 flex flex-col bg-[#141418]">
        <header className="flex shrink-0 items-center gap-3 border-b border-deck-border py-2 pl-[78px] pr-4">
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-medium text-deck-text">编辑消息</div>
            <div className="text-[9px] text-deck-muted">
              {props.text.length.toLocaleString()} 字
              {props.attachments.length > 0 ? ` · ${props.attachments.length} 个附件` : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            disabled={props.busy}
            className="rounded bg-white/[0.06] px-2 py-1 text-[11px] text-deck-muted hover:bg-white/[0.12] disabled:opacity-40"
          >
            <CloseIcon className="mr-1 inline h-3 w-3" />关闭
          </button>
        </header>
        <main className="flex min-h-0 flex-1 flex-col px-4 py-3">
          {props.attachments.length > 0 && (
            <section className="mb-3 shrink-0 rounded-lg border border-deck-border bg-white/[0.025] p-2.5">
              <div className="mb-2 text-[10px] font-medium text-deck-muted">
                待发送附件（{props.attachments.length}）
              </div>
              <PendingImageAttachments
                attachments={props.attachments}
                getPreviewDataUrl={props.getAttachmentPreviewDataUrl}
                onRemove={props.onRemoveAttachment}
                variant="detailed"
              />
            </section>
          )}
          <div className="relative min-h-0 flex-1">
            <textarea
              ref={textareaRef}
              value={props.text}
              onChange={(event) => props.onTextChange(event.target.value)}
              onPaste={props.onPaste}
              onDrop={props.onDrop}
              onDragOver={props.onDragOver}
              onKeyDown={(event) => {
                if (event.key === 'Tab' && firstCommand) {
                  event.preventDefault();
                  props.onTextChange(commandCompletion(firstCommand));
                  return;
                }
                if (!shouldSubmit(event)) return;
                event.preventDefault();
                void submit();
              }}
              placeholder={props.placeholder}
              className="h-full w-full resize-none rounded-lg border border-deck-border bg-black/30 p-4 text-[13px] leading-relaxed text-deck-text outline-none placeholder:text-deck-muted/60 focus:border-white/25"
            />
            <SlashCommandMenu
              commands={props.commands ?? []}
              text={props.text}
              onChoose={props.onTextChange}
              placement="inset"
            />
          </div>
        </main>
        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-deck-border px-4 py-2">
          <div className="flex min-w-0 items-center gap-2">
            {props.attachmentPicker && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={props.attachmentPicker.accept}
                  multiple
                  aria-label="添加图片文件"
                  className="hidden"
                  onChange={(event) => {
                    props.attachmentPicker?.onAdd(event.target.files);
                    if (fileInputRef.current) fileInputRef.current.value = '';
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex h-7 shrink-0 items-center justify-center rounded px-2 text-[10px] text-deck-muted hover:bg-white/10 hover:text-deck-text"
                  title={props.attachmentPicker.title ?? '上传图片（也可粘贴或拖放）'}
                  aria-label="上传图片"
                >
                  <ImageIcon className="mr-1 h-4 w-4" />添加图片
                </button>
              </>
            )}
            <span className="truncate text-[9px] text-deck-muted">
              Enter 发送 · Shift+Enter 换行 · Esc 关闭
            </span>
          </div>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!props.canSubmit}
            className="rounded bg-status-working/30 px-4 py-1.5 text-[10px] font-medium text-status-working hover:bg-status-working/40 disabled:opacity-40"
          >
            <StableButtonContent
              activeKey={props.busy ? 'busy' : 'idle'}
              variants={[
                {
                  key: 'idle',
                  content: <><SendIcon className="mr-1 h-3 w-3" />{props.submitLabel}</>,
                },
                { key: 'busy', content: '发送中…' },
              ]}
            />
          </button>
        </footer>
      </div>
    </div>,
    document.getElementById('floating-frame-root') ?? document.body,
  );
}
