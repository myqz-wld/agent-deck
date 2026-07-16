import type { JSX } from 'react';
import { PLAN_QUOTE_SHORTCUT } from './plan-quote-selection';

export interface PlanQuoteMenuState {
  left: number;
  top: number;
  text: string;
}

interface Props {
  menu: PlanQuoteMenuState;
  onClose: () => void;
  onQuote: () => void;
}

export function PlanQuoteContextMenu({ menu, onClose, onQuote }: Props): JSX.Element {
  return (
    <div className="fixed inset-0 z-[80]">
      <div
        className="absolute inset-0"
        aria-hidden="true"
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div
        role="menu"
        aria-label="计划文本引用"
        className="fixed z-10 min-w-48 overflow-hidden rounded-md border border-white/10 bg-deck-bg-strong p-1 shadow-xl"
        style={{ left: menu.left, top: menu.top }}
      >
        <button
          autoFocus
          type="button"
          role="menuitem"
          onClick={onQuote}
          className="flex w-full items-center justify-between gap-4 rounded px-2.5 py-1.5 text-left text-[11px] text-deck-text hover:bg-white/10 focus:bg-white/10 focus:outline-none"
        >
          <span>引用到提问</span>
          <kbd className="font-sans text-[9px] text-deck-muted/70">{PLAN_QUOTE_SHORTCUT}</kbd>
        </button>
      </div>
    </div>
  );
}
