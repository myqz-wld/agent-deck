import { useEffect, useRef, type DragEventHandler, type ClipboardEventHandler,
  type JSX, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon, SendIcon } from '../../icons';

interface Props {
  text: string;
  placeholder: string;
  submitLabel: string;
  busy: boolean;
  canSubmit: boolean;
  attachmentCount: number;
  onTextChange: (value: string) => void;
  onSubmit: () => Promise<boolean>;
  onClose: () => void;
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(props.busy);
  const onCloseRef = useRef(props.onClose);
  busyRef.current = props.busy;
  onCloseRef.current = props.onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const background = dialog?.parentElement
      ? [...dialog.parentElement.children]
        .filter((node): node is HTMLElement => node instanceof HTMLElement && node !== dialog)
        .map((node) => ({
          node,
          ariaHidden: node.getAttribute('aria-hidden'),
          inert: node.inert,
        }))
      : [];
    for (const { node } of background) {
      node.inert = true;
      node.setAttribute('aria-hidden', 'true');
    }
    textareaRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (!busyRef.current) onCloseRef.current();
    };
    const trapFocus = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((node) => !node.hidden && node.getAttribute('aria-hidden') !== 'true');
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    dialog?.addEventListener('keydown', trapFocus);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      dialog?.removeEventListener('keydown', trapFocus);
      for (const { node, ariaHidden, inert } of background) {
        node.inert = inert;
        if (ariaHidden === null) node.removeAttribute('aria-hidden');
        else node.setAttribute('aria-hidden', ariaHidden);
      }
      previousFocus?.focus();
    };
  }, []);

  const submit = async (): Promise<void> => {
    if (!props.canSubmit) return;
    if (await props.onSubmit()) props.onClose();
  };

  return createPortal(
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="absolute inset-0 z-50 flex flex-col bg-black/40 backdrop-blur-sm"
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
              {props.attachmentCount > 0 ? ` · ${props.attachmentCount} 个附件` : ''}
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
          <textarea
            ref={textareaRef}
            value={props.text}
            onChange={(event) => props.onTextChange(event.target.value)}
            onPaste={props.onPaste}
            onDrop={props.onDrop}
            onDragOver={props.onDragOver}
            onKeyDown={(event) => {
              if (!shouldSubmit(event)) return;
              event.preventDefault();
              void submit();
            }}
            placeholder={props.placeholder}
            className="min-h-0 flex-1 resize-none rounded-lg border border-deck-border bg-black/30 p-4 text-[13px] leading-relaxed text-deck-text outline-none placeholder:text-deck-muted/60 focus:border-white/25"
          />
        </main>
        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-deck-border px-4 py-2">
          <span className="text-[9px] text-deck-muted">Enter 发送 · Shift+Enter 换行 · Esc 关闭</span>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!props.canSubmit}
            className="rounded bg-status-working/30 px-4 py-1.5 text-[10px] font-medium text-status-working hover:bg-status-working/40 disabled:opacity-40"
          >
            {!props.busy && <SendIcon className="mr-1 inline h-3 w-3" />}
            {props.busy ? '发送中…' : props.submitLabel}
          </button>
        </footer>
      </div>
    </div>,
    document.getElementById('floating-frame-root') ?? document.body,
  );
}
