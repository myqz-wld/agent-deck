import { useState, type JSX, type MouseEvent } from 'react';

import type { SessionRecord } from '@shared/types';
import { lifecycleLabel } from './session-presentation';
import { PushpinIcon } from './icons';
import { HistorySessionActionsMenu } from './HistorySessionActionsMenu';
import { SessionContextUsageChip } from './SessionContextUsageChip';
import { SessionMetadataChips } from './SessionMetadataChips';
import { SessionCardFrame, SessionCardHeader } from './SessionListPrimitives';
import type { SessionContextMenuPosition } from './SessionActionsContextMenu';

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
  const archived = session.archivedAt !== null;
  const [menuPosition, setMenuPosition] = useState<SessionContextMenuPosition | null>(null);
  const openMenu = (event: MouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    setMenuPosition({ x: event.clientX, y: event.clientY });
  };
  const activityLine = `${new Date(session.lastEventAt).toLocaleString('zh-CN', {
    hour12: false,
  })} · ${archived ? `已归档（${lifecycleLabel(session.lifecycle)}）` : lifecycleLabel(session.lifecycle)}`;
  const summaryLine = session.cwd || '无工作目录';

  return (
    <SessionCardFrame
      element="div"
      sessionId={session.id}
      selected={false}
      onSelect={onSelect}
      onContextMenu={openMenu}
      label={`打开会话 ${session.title}`}
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
      {menuPosition && (
        <HistorySessionActionsMenu
          archived={archived}
          position={menuPosition}
          onClose={() => setMenuPosition(null)}
          onArchive={onArchive}
          onDelete={onDelete}
          onUnarchive={onUnarchive}
        />
      )}
    </SessionCardFrame>
  );
}
