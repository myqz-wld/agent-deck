import { useState, type JSX, type MouseEvent } from 'react';

import type { SessionRecord } from '@shared/types';
import { lifecycleLabel } from './TeamDetail/helpers';
import { ArchiveIcon, PushpinIcon, RefreshIcon, TrashIcon } from './icons';
import { SessionContextUsageChip } from './SessionContextUsageChip';
import { SessionMetadataChips } from './SessionMetadataChips';
import { SessionCardFrame, SessionCardHeader } from './SessionListPrimitives';

export function LocalHistorySummaryCard({
  session,
  onArchive,
  onDelete,
  onSelect,
  onUnarchive,
}: {
  session: SessionRecord;
  onArchive(): Promise<void>;
  onDelete(): Promise<void>;
  onSelect(): void;
  onUnarchive(): Promise<void>;
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const archived = session.archivedAt !== null;
  const activityLine = `${new Date(session.lastEventAt).toLocaleString('zh-CN', {
    hour12: false,
  })} · ${archived ? `已归档（${lifecycleLabel(session.lifecycle)}）` : lifecycleLabel(session.lifecycle)}`;
  const summaryLine = session.cwd || '无工作目录';

  const toggleMenu = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    setMenuOpen((open) => !open);
  };
  const run = (event: MouseEvent<HTMLButtonElement>, action: () => Promise<void>): void => {
    event.stopPropagation();
    setMenuOpen(false);
    void action();
  };

  return (
    <SessionCardFrame
      element="div"
      sessionId={session.id}
      selected={false}
      onSelect={onSelect}
    >
      <SessionCardHeader
        activity={session.activity}
        lifecycle={session.lifecycle}
        archived={archived}
        title={session.title}
        adapterId={session.agentId}
      >
        <span
          className={`rounded px-1 py-0.5 text-[8px] font-medium uppercase tracking-wider ${
            session.source === 'sdk'
              ? 'bg-status-working/20 text-status-working'
              : 'bg-white/8 text-deck-muted'
          }`}
          title={session.source === 'sdk' ? '应用内创建的会话' : '终端启动的会话'}
        >
          {session.source === 'sdk' ? '内' : '外'}
        </span>
        {session.pinnedAt != null && (
          <span
            role="img"
            aria-label="已置顶会话"
            title="已置顶"
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-amber-400/15 text-amber-300"
          >
            <PushpinIcon filled className="h-3 w-3" />
          </span>
        )}
        <button
          type="button"
          aria-label="历史会话操作"
          aria-expanded={menuOpen}
          onClick={toggleMenu}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[13px] text-deck-muted/70 hover:bg-white/10 hover:text-deck-text"
        >
          ⋯
        </button>
      </SessionCardHeader>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
        <SessionMetadataChips session={session} compact />
        <SessionContextUsageChip session={session} />
      </div>
      <div className="mt-1 truncate text-[10px] text-deck-text/85" title={activityLine}>
        {activityLine}
      </div>
      <div className="mt-0.5 truncate text-[10px] text-deck-muted/70" title={summaryLine}>
        {summaryLine}
      </div>
      {menuOpen && (
        <>
          <div
            className="fixed inset-0 z-20"
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen(false);
            }}
          />
          <div className="absolute right-2 top-8 z-30 w-32 overflow-hidden rounded-md border border-white/10 bg-deck-bg-strong shadow-lg">
            <button
              type="button"
              className="block w-full px-3 py-1.5 text-left text-[11px] hover:bg-white/10"
              onClick={(event) => run(event, archived ? onUnarchive : onArchive)}
            >
              {archived ? (
                <><RefreshIcon className="mr-1 inline h-3 w-3" />取消归档</>
              ) : (
                <><ArchiveIcon className="mr-1 inline h-3 w-3" />归档</>
              )}
            </button>
            <button
              type="button"
              className="block w-full px-3 py-1.5 text-left text-[11px] text-status-waiting hover:bg-white/10"
              onClick={(event) => run(event, onDelete)}
            >
              <TrashIcon className="mr-1 inline h-3 w-3" />删除
            </button>
          </div>
        </>
      )}
    </SessionCardFrame>
  );
}
