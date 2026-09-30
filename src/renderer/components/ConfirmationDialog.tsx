import { useId, useLayoutEffect, useRef, type JSX } from 'react';
import { createPortal } from 'react-dom';
import {
  cancelConfirmations,
  settleConfirmation,
  useConfirmationStore,
  type ConfirmationRequest,
} from '../lib/confirm-dialog';
import { useModalFocus } from './use-modal-focus';

export function ConfirmationDialogHost(): JSX.Element | null {
  const request = useConfirmationStore((state) => state.requests[0]);
  useLayoutEffect(() => () => cancelConfirmations(), []);
  return request ? <ConfirmationDialog key={request.id} request={request} /> : null;
}

function ConfirmationDialog({ request }: { request: ConfirmationRequest }): JSX.Element {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const close = (): void => settleConfirmation(request.id, false);
  useModalFocus({ dialogRef, onClose: close });
  useLayoutEffect(() => { cancelRef.current?.focus(); }, []);

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className="deck-dialog-surface no-drag max-h-[90vh] w-[320px] max-w-full overflow-y-auto px-5 py-[18px] text-deck-text outline-none scrollbar-deck"
      >
        <h2 id={titleId} className="text-[13px] font-medium">{request.title || '确认操作'}</h2>
        <div id={descriptionId} className="mt-2 space-y-2 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-deck-muted">
          {request.message && <p>{request.message}</p>}
          {request.detail && <p>{request.detail}</p>}
        </div>
        <div className="mt-[18px] flex flex-wrap justify-end gap-2 text-[11px]">
          <button
            ref={cancelRef}
            type="button"
            onClick={close}
            className="rounded border border-white/10 px-2.5 py-1.5 text-deck-muted hover:bg-white/5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-white/40"
          >
            {request.cancelLabel || '取消'}
          </button>
          <button
            type="button"
            onClick={() => settleConfirmation(request.id, true)}
            className={`rounded border px-2.5 py-1.5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-white/40 ${
              request.destructive
                ? 'border-status-error/30 bg-status-error/15 text-status-error hover:bg-status-error/25'
                : 'border-status-working/30 bg-status-working/15 text-status-working hover:bg-status-working/25'
            }`}
          >
            {request.okLabel || '确认'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
