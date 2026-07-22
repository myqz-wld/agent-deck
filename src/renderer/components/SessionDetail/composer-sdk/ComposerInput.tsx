import { useState, type ClipboardEventHandler, type DragEventHandler, type JSX,
  type KeyboardEvent } from 'react';
import type { UploadedAttachmentEntry } from '@renderer/hooks/useImageAttachments';
import { ExpandIcon } from '../../icons';
import { ExpandedComposerOverlay } from './ExpandedComposerOverlay';

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

export function ComposerInput(props: Props): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <div className="relative">
        <textarea
          value={props.text}
          onChange={(event) => props.onTextChange(event.target.value)}
          onPaste={props.onPaste}
          onDrop={props.onDrop}
          onDragOver={props.onDragOver}
          onKeyDown={(event) => {
            if (!shouldSubmit(event)) return;
            event.preventDefault();
            if (props.canSubmit) void props.onSubmit();
          }}
          placeholder={props.placeholder}
          rows={2}
          className="block w-full resize-none rounded border border-deck-border bg-white/[0.04] py-1 pl-2 pr-8 text-[11px] outline-none focus:border-white/20"
        />
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded text-deck-muted hover:bg-white/10 hover:text-deck-text"
          title="放大输入框"
          aria-label="放大输入框"
        >
          <ExpandIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      {expanded && (
        <ExpandedComposerOverlay
          {...props}
          onClose={() => setExpanded(false)}
        />
      )}
    </>
  );
}
