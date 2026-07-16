import type { JSX } from 'react';
import { MemoizedMarkdownText } from '../MarkdownText';
import { CloseIcon } from '../icons';

interface Props {
  text: string;
  removeLabel: string;
  onRemove: () => void;
}

export function PlanQuotePreview({ text, removeLabel, onRemove }: Props): JSX.Element {
  return (
    <div
      role="listitem"
      data-testid="plan-review-quote"
      className="mb-2 rounded-md border border-status-working/25 bg-status-working/[0.06] p-2"
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[9px] font-medium text-status-working">引用自计划</span>
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          className="flex h-4 w-4 items-center justify-center rounded text-deck-muted hover:bg-white/10 hover:text-deck-text"
        >
          <CloseIcon className="h-3 w-3" />
        </button>
      </div>
      <div className="max-h-24 overflow-auto border-l-2 border-status-working/40 pl-2 text-[10px] text-deck-muted scrollbar-deck">
        <MemoizedMarkdownText text={text} />
      </div>
    </div>
  );
}
