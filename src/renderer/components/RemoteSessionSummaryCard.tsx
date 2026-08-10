import type { JSX } from 'react';

import type { RemoteHostSessionSummaryDto } from '@shared/remote-host';
import { remoteSessionStatus } from '@renderer/remote-host/session-summary-presentation';
import { StatusBadge } from './StatusBadge';
import { agentIdLabel, lifecycleLabel } from './TeamDetail/helpers';

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
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-lg border px-3 py-2 text-left transition ${
        selected
          ? 'border-white/30 bg-white/10'
          : 'border-deck-border bg-white/[0.02] hover:bg-white/[0.06]'
      }`}
    >
      <div className="flex items-center gap-2">
        <StatusBadge
          activity={status.activity}
          lifecycle={status.lifecycle}
          archived={false}
        />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
          {session.title ?? '未命名会话'}
        </span>
        <span
          className="rounded bg-blue-500/15 px-1 py-0.5 text-[8px] font-medium uppercase tracking-wider text-blue-200"
          title="远程 Core 会话"
        >
          远
        </span>
        <span className="text-[9px] text-deck-muted/60">
          {agentIdLabel(session.adapterId)}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-deck-muted/70">
        <span>{lifecycleLabel(status.lifecycle)} · {ACTIVITY_LABELS[status.activity]}</span>
        <span>{new Date(session.updatedAt).toLocaleString('zh-CN', { hour12: false })}</span>
      </div>
    </button>
  );
}
