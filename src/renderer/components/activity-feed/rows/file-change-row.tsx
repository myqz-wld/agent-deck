import { useContext, useId, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import type { AgentEvent } from '@shared/types';
import { fileChangeEventToDiff, fileChangeToDiff } from '@shared/file-change-diff';
import { DiffViewer } from '../../diff/DiffViewer';
import { ExpandedDiffOverlay } from '../../diff/ExpandedDiffOverlay';
import { useFileChangePayload } from '../../SessionDetail/use-file-change-payload';
import { ChevronDownIcon, ChevronRightIcon, ExpandIcon, PencilIcon } from '../../icons';
import { ActivityFileChangeContext } from '../file-change-context';
import { ActivityImageContext } from '../image-context';

export function FileChangeRow({ event }: { event: AgentEvent }): JSX.Element {
  const reader = useContext(ActivityFileChangeContext);
  const images = useContext(ActivityImageContext);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const fallback = fileChangeEventToDiff(event);
  const rawId = (event.payload as { fileChangeId?: unknown } | null)?.fileChangeId;
  const changeId = typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId > 0 ? rawId : null;
  const { selectedPayload, payloadLoading, payloadError, retryPayload } = useFileChangePayload({
    sessionId: event.sessionId,
    workspaceKey: reader?.identity ?? 'unavailable',
    selectedChangeId: open ? changeId : null,
    reader,
  });
  const payload = selectedPayload ? fileChangeToDiff(selectedPayload) : changeId === null ? fallback : null;
  // Legacy Remote image events may contain worker paths; only projected handles are readable there.
  const canShow = payload && (payload.kind !== 'image' || images !== null);
  const filePath = fallback?.filePath ?? '文件改动';
  const view = (large = false): JSX.Element | null => canShow && payload ? (
    <DiffViewer payload={payload} sessionId={event.sessionId} expanded={large}
      imageBlobLoader={images?.load} imageCacheScope={images?.identity} />
  ) : null;
  return (
    <li className="min-w-0 rounded-md border border-deck-border/60 bg-white/[0.02] text-[11px]">
      <button type="button" aria-expanded={open} aria-controls={contentId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-deck-accent">
        {open ? <ChevronDownIcon className="h-3 w-3 shrink-0 text-deck-muted" />
          : <ChevronRightIcon className="h-3 w-3 shrink-0 text-deck-muted" />}
        <PencilIcon className="h-3.5 w-3.5 shrink-0 text-deck-muted" />
        <span className="min-w-0 flex-1 truncate font-mono" title={filePath}>{filePath}</span>
        <span className="shrink-0 text-[10px] text-deck-muted">{open ? '收起改动' : '查看改动'}</span>
      </button>
      {open && <div id={contentId} className="border-t border-deck-border/40 p-2">
        {payloadLoading ? <div role="status" className="py-3 text-deck-muted">加载所选改动…</div>
          : payloadError ? <div role="alert" className="flex items-center gap-2 py-2 text-deck-muted">
            <span>{payloadError}</span>
            {reader && <button type="button" onClick={retryPayload} className="rounded bg-white/10 px-2 py-1 hover:bg-white/20">重试</button>}
          </div>
            : canShow ? <>
              <div className="mb-1 flex justify-end">
                <button type="button" onClick={() => setExpanded(true)}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] text-deck-muted hover:bg-white/10 focus-visible:ring-1 focus-visible:ring-deck-accent">
                  <ExpandIcon className="h-3 w-3" />放大
                </button>
              </div>
              <div className="h-[360px] max-h-[70vh] min-h-[260px] min-w-0">{view()}</div>
            </> : <div className="py-3 text-deck-muted">这次改动未记录可显示的内容。</div>}
      </div>}
      <div className="px-2 pb-1.5 font-mono text-[9px] tabular-nums text-deck-muted/60">
        {new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false })}
      </div>
      {expanded && canShow && createPortal(
        <ExpandedDiffOverlay filePath={filePath} onClose={() => setExpanded(false)}>{view(true)}</ExpandedDiffOverlay>,
        document.getElementById('floating-frame-root') ?? document.body,
      )}
    </li>
  );
}
