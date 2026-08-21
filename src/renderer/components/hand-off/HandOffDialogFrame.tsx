import type { JSX, ReactNode, RefObject } from 'react';
import { CloseIcon, HandOffIcon } from '../icons';
import { StableButtonContent } from '../StableButtonContent';

/** Shared modal frame and action order for Local and Remote handoff controllers. */
export function HandOffDialogFrame({
  dialogRef,
  titleId,
  statusText,
  busy,
  onClose,
  children,
  footerStatus,
  primaryLabel,
  primaryBusyLabel,
  primaryDisabled,
  primaryVisuallyDisabled = primaryDisabled,
  onPrimary,
  ariaBusy = false,
}: {
  dialogRef: RefObject<HTMLDivElement | null>;
  titleId: string;
  statusText?: string;
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
  footerStatus?: ReactNode;
  primaryLabel: string;
  primaryBusyLabel: string;
  primaryDisabled: boolean;
  primaryVisuallyDisabled?: boolean;
  onPrimary: () => void;
  ariaBusy?: boolean;
}): JSX.Element {
  return (
    <div data-session-handoff-frame className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={ariaBusy}
        tabIndex={-1}
        className="no-drag flex max-h-[92%] w-[620px] flex-col overflow-hidden rounded-xl border border-deck-border bg-deck-bg-strong shadow-2xl"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-deck-border px-4 py-3">
          <h2 id={titleId} className="flex items-center gap-1.5 text-[13px] font-medium">
            <HandOffIcon className="h-4 w-4 text-status-working" />
            <span>接力到新会话{statusText ? `（${statusText}）` : ''}</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭接力窗口"
            className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-deck-muted hover:bg-white/10 disabled:opacity-50"
            title="取消"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </header>
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4 scrollbar-deck">
          {children}
        </div>
        <footer className="flex shrink-0 items-center gap-2 border-t border-deck-border px-4 py-3">
          <div className="min-w-0 flex-1">{footerStatus}</div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded px-3 py-1 text-[11px] text-deck-muted hover:bg-white/5 disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onPrimary}
            disabled={primaryDisabled}
            className={`rounded bg-status-working/30 px-3 py-1 text-[11px] text-status-working hover:bg-status-working/40 ${
              primaryVisuallyDisabled ? 'opacity-50' : ''
            }`}
          >
            <StableButtonContent
              activeKey={busy ? 'busy' : 'idle'}
              variants={[
                {
                  key: 'idle',
                  content: <><HandOffIcon className="mr-1 h-3 w-3" />{primaryLabel}</>,
                },
                { key: 'busy', content: primaryBusyLabel },
              ]}
            />
          </button>
        </footer>
      </div>
    </div>
  );
}
