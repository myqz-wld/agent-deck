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
import {
  RemotePageUnavailable,
  remotePageAvailability,
  unknownSourceAvailability,
  type RemotePageSurface,
} from './remote-host/RemotePageAvailability';
import type { RemoteSessionSourceView } from './remote-host/source-types';
import type { RemoteUsageSourceView } from './remote-host/use-remote-usage-source';
import type { AppSourceAuthority } from './source-authority';

export function AppWorkspace({
  view,
  authority,
  authorityError,
  onAuthorityRetry,
  localDetail,
  remoteSource,
  remoteUsage,
  onLocalClose,
  onLocalHistorySelect,
  onOpenLocalSession,
  onViewChange,
}: {
  view: AppView;
  authority: AppSourceAuthority;
  authorityError: string | null;
  onAuthorityRetry: () => void;
  localDetail: SessionRecord | null;
  remoteSource: RemoteSessionSourceView;
  remoteUsage: RemoteUsageSourceView;
  onLocalClose: () => void;
  onLocalHistorySelect: (id: string) => void;
  onOpenLocalSession: (id: string) => void;
  onViewChange: (view: AppView) => void;
}): JSX.Element {
  if (authority === 'unknown') {
    return (
      <RemotePageUnavailable
        availability={unknownSourceAvailability(authorityError)}
        onRetry={authorityError ? onAuthorityRetry : undefined}
      />
    );
  }
  const remoteMode = authority === 'remote';
  const guardedSurface: RemotePageSurface = view;
  const availability = remoteMode
    ? remotePageAvailability(remoteSource, guardedSurface)
    : null;
  const detailVisible = view === 'live' || view === 'history';
  if (availability && availability.kind !== 'available') {
    return <RemotePageUnavailable availability={availability} />;
  }
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
      此页面目前只支持本机数据，当前远端连接暂不提供。
    </div>
  );
}
