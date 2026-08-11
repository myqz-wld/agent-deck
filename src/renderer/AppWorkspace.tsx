import type { JSX } from 'react';

import type { SessionRecord } from '@shared/types';
import type { AppView } from './components/AppHeader';
import { DataPanel } from './components/DataPanel';
import { HistoryPanel } from './components/HistoryPanel';
import { IssuesPanel } from './components/IssuesPanel';
import { RemoteIssuesPanel } from './components/issues/RemoteIssuesPanel';
import { PendingTab } from './components/PendingTab';
import { SessionDetail } from './components/SessionDetail';
import { SessionList } from './components/SessionList';
import { TeamHub } from './components/TeamHub';
import {
  RemotePageUnavailable,
  remotePageAvailability,
  type RemotePageSurface,
} from './remote-host/RemotePageAvailability';
import type { RemoteSessionSourceView } from './remote-host/source-types';
import type { RemoteUsageSourceView } from './remote-host/use-remote-usage-source';

export function AppWorkspace({
  view,
  remoteMode,
  localDetail,
  remoteSource,
  remoteUsage,
  onLocalClose,
  onLocalHistorySelect,
  onOpenLocalSession,
  onViewChange,
}: {
  view: AppView;
  remoteMode: boolean;
  localDetail: SessionRecord | null;
  remoteSource: RemoteSessionSourceView;
  remoteUsage: RemoteUsageSourceView;
  onLocalClose: () => void;
  onLocalHistorySelect: (id: string) => void;
  onOpenLocalSession: (id: string) => void;
  onViewChange: (view: AppView) => void;
}): JSX.Element {
  const guardedSurface: RemotePageSurface = view;
  const availability = remoteMode
    ? remotePageAvailability(remoteSource, guardedSurface)
    : null;
  if (availability && availability.kind !== 'available') {
    return <RemotePageUnavailable availability={availability} />;
  }
  const detailVisible = view === 'live' || view === 'history';
  if (detailVisible && remoteMode && remoteSource.selectedSessionId) {
    return (
      <SessionDetail
        remoteSource={remoteSource}
        onClose={() => remoteSource.selectSession(null)}
      />
    );
  }
  if (detailVisible && !remoteMode && localDetail) {
    return <SessionDetail session={localDetail} onClose={onLocalClose} />;
  }
  if (view === 'live') {
    return (
      <div className="h-full overflow-y-auto scrollbar-deck px-3 py-2">
        <SessionList {...(remoteMode ? { remoteSource } : {})} />
      </div>
    );
  }
  if (view === 'pending') {
    return (
      <PendingTab
        {...(remoteMode ? { remoteSource } : {})}
        onOpenSession={(sessionId) => {
          onViewChange('live');
          if (remoteMode) remoteSource.selectSession(sessionId);
          else onOpenLocalSession(sessionId);
        }}
      />
    );
  }
  if (view === 'history') {
    return (
      <HistoryPanel
        {...(remoteMode ? { remoteSource } : {})}
        onSelect={(sessionId) => {
          if (remoteMode) remoteSource.selectSession(sessionId);
          else onLocalHistorySelect(sessionId);
        }}
      />
    );
  }
  if (view === 'teams') {
    return (
      <TeamHub
        key={remoteMode ? remoteSource.identity : 'local'}
        remoteSource={remoteMode ? remoteSource : null}
        onOpenSession={(sessionId) => {
          onViewChange('live');
          if (remoteMode) remoteSource.selectSession(sessionId);
          else onOpenLocalSession(sessionId);
        }}
      />
    );
  }
  if (!remoteMode && view === 'issues') {
    return <IssuesPanel onOpenSession={(sessionId) => { onViewChange('live'); onOpenLocalSession(sessionId); }} />;
  }
  if (remoteMode && view === 'issues') {
    return (
      <RemoteIssuesPanel
        source={remoteSource}
        onOpenSession={(sessionId) => {
          onViewChange('live');
          remoteSource.selectSession(sessionId);
        }}
      />
    );
  }
  if (view === 'data') {
    return <DataPanel remoteUsage={remoteMode ? remoteUsage : null} />;
  }
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-deck-muted">
      此页面仅在 Local 数据源可用。远程协议当前未提供对应能力。
    </div>
  );
}
