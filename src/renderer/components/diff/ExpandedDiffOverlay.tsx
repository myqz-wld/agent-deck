import { useModalFocus } from '../use-modal-focus';
import { useRef, type JSX, type ReactNode } from 'react';
import { CloseIcon } from '../icons';

export function ExpandedDiffOverlay({
  filePath,
  onClose,
  fileNav,
  children,
}: {
  filePath: string;
  onClose: () => void;
  fileNav?: JSX.Element;
  children: ReactNode;
}): JSX.Element {
  const dialog = useRef<HTMLDivElement>(null);
  useModalFocus({ dialogRef: dialog, onClose });
  const lastSlash = filePath.lastIndexOf('/');
  const dirPart = lastSlash >= 0 ? filePath.slice(0, lastSlash + 1) : '';
  const filePart = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;

  return (
    <div
      className="absolute inset-0 z-50 flex flex-col bg-black/50 backdrop-blur-sm"
      role="dialog"
      ref={dialog}
      tabIndex={-1}
      aria-modal="true"
      aria-label="放大改动视图"
    >
      <div className="absolute inset-0 flex flex-col bg-[#141418]">
        <div className="flex shrink-0 items-center gap-2 border-b border-deck-border pl-[78px] pr-4 py-2">
          <div className="min-w-0 flex-1">
            {dirPart && (
              <div className="truncate font-mono text-[10px] leading-tight text-deck-muted">
                {dirPart}
              </div>
            )}
            <div className="truncate font-mono text-[12px] font-medium leading-tight text-deck-text">
              {filePart || '改动'}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {fileNav}
            <button
              type="button"
              onClick={onClose}
              className="rounded bg-white/[0.06] px-2 py-1 text-[11px] text-deck-muted hover:bg-white/[0.12]"
            >
              <CloseIcon className="mr-1 inline h-3 w-3" />关闭
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 px-4 py-3">{children}</div>
      </div>
    </div>
  );
}
