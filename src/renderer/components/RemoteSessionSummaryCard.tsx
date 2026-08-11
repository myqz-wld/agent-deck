import type { JSX } from 'react';

import type { RemoteHostSessionSummaryDto } from '@shared/remote-host';
import { remoteSessionStatus } from '@renderer/remote-host/session-summary-presentation';
import { lifecycleLabel } from './TeamDetail/helpers';
import { SessionCardFrame, SessionCardHeader } from './SessionListPrimitives';

const ACTIVITY_LABELS = {
  idle: '空闲',
  working: '工作中',
  waiting: '等待输入',
  finished: '本轮完成',
} as const;

export function RemoteSessionSummaryCard({
  session,
  selected = false,
  onSelect,
}: {
  session: RemoteHostSessionSummaryDto;
  selected?: boolean;
  onSelect: () => void;
}): JSX.Element {
  const status = remoteSessionStatus(session.status);
  const title = session.title ?? '未命名会话';
  const detail = `${lifecycleLabel(status.lifecycle)} · ${ACTIVITY_LABELS[status.activity]} · ${
    new Date(session.updatedAt).toLocaleString('zh-CN', { hour12: false })
  }`;
  return (
    <SessionCardFrame
      element="button"
      sessionId={session.id}
      selected={selected}
      onSelect={onSelect}
      label={`打开会话 ${title}`}
    >
      <SessionCardHeader
        activity={status.activity}
        lifecycle={status.lifecycle}
        title={title}
        adapterId={session.adapterId}
      >
        <span
          className="rounded bg-blue-500/15 px-1 py-0.5 text-[8px] font-medium uppercase tracking-wider text-blue-200"
          title="远程 Core 会话"
        >
          远
        </span>
      </SessionCardHeader>
      <div
        data-session-card-summary="true"
        className="mt-0.5 truncate text-[10px] text-deck-muted/70"
        title={detail}
      >
        {detail}
      </div>
    </SessionCardFrame>
  );
}
