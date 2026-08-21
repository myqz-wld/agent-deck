import { useCallback, useLayoutEffect, useRef, useState, type JSX } from 'react';

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
import { useDelayedAsyncFallback } from './hooks/useDelayedAsyncFallback';

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
  const sourcePresentationIdentity = authority === 'remote'
    ? `remote:${remoteSource.identity}`
    : authority;
  const historyIdentity = `${sourcePresentationIdentity}:history`;
  const issuesIdentity = `${sourcePresentationIdentity}:issues`;
  const pendingIdentity = `${sourcePresentationIdentity}:pending`;
  const [historyReadyIdentity, setHistoryReadyIdentity] = useState<string | null>(null);
  const [issuesReadyIdentity, setIssuesReadyIdentity] = useState<string | null>(null);
  const [pendingReadyIdentity, setPendingReadyIdentity] = useState<string | null>(null);
  const historyReady = historyReadyIdentity === historyIdentity;
  const issuesReady = issuesReadyIdentity === issuesIdentity;
  const pendingReady = pendingReadyIdentity === pendingIdentity;
  const onHistoryReady = useCallback((ready: boolean): void => {
    setHistoryReadyIdentity(ready ? historyIdentity : null);
  }, [historyIdentity]);
  const onIssuesReady = useCallback((ready: boolean): void => {
    setIssuesReadyIdentity(ready ? issuesIdentity : null);
  }, [issuesIdentity]);
  const onPendingReady = useCallback((ready: boolean): void => {
    setPendingReadyIdentity(ready ? pendingIdentity : null);
  }, [pendingIdentity]);
  const targetReady = view === 'history'
    ? historyReady
    : view === 'issues'
      ? issuesReady
      : view === 'pending'
        ? pendingReady
        : true;
  const [presentedView, setPresentedView] = useState(view);
  useLayoutEffect(() => {
    if (presentedView !== view && targetReady) setPresentedView(view);
  }, [presentedView, targetReady, view]);
  const remoteDetailPending = authority === 'remote' &&
    (view === 'live' || view === 'history') &&
    remoteSource.selectedSessionId !== null &&
    remoteSource.selectedSession === null;
  const showRemoteDetailFallback = useDelayedAsyncFallback(
    remoteDetailPending,
    `${remoteSource.identity}:${view}:${remoteSource.selectedSessionId ?? 'none'}:detail`,
  );
  const remoteDetailDeferred = remoteDetailPending && !showRemoteDetailFallback;

  const liveLocalDetail = useRef<SessionRecord | null>(view === 'live' ? localDetail : null);
  const historyLocalDetail = useRef<SessionRecord | null>(view === 'history' ? localDetail : null);
  const liveRemoteSource = useRef(remoteSource);
  const historyRemoteSource = useRef(remoteSource);
  if (view === 'live') {
    liveLocalDetail.current = localDetail;
    liveRemoteSource.current = remoteSource;
  } else if (view === 'history') {
    historyLocalDetail.current = localDetail;
    historyRemoteSource.current = remoteSource;
  }

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
  if (availability && availability.kind !== 'available') {
    return <RemotePageUnavailable availability={availability} />;
  }
  const transitioning = presentedView !== view;
  const presentedLocalDetail = transitioning && presentedView === 'live'
    ? liveLocalDetail.current
    : transitioning && presentedView === 'history'
      ? historyLocalDetail.current
      : localDetail;
  const presentedRemoteSource = transitioning && presentedView === 'live'
    ? liveRemoteSource.current
    : transitioning && presentedView === 'history'
      ? historyRemoteSource.current
      : remoteSource;
  const detailVisible = presentedView === 'live' || presentedView === 'history';
  const remoteDetailVisible = detailVisible && remoteMode && presentedRemoteSource.selectedSessionId;
  const remoteDetailReady = !remoteDetailPending || showRemoteDetailFallback;
  const localDetailVisible = detailVisible && !remoteMode && presentedLocalDetail;
  const historyListVisible = presentedView === 'history' &&
    (!remoteDetailVisible || !remoteDetailReady) && !localDetailVisible;
  const issuesVisible = presentedView === 'issues';
  const pendingVisible = presentedView === 'pending';
  let surface: JSX.Element | null = null;
  if (
    detailVisible && remoteMode && presentedRemoteSource.selectedSessionId && remoteDetailReady
  ) {
    surface = (
      <SessionDetail
        remoteSource={presentedRemoteSource}
        onClose={() => presentedRemoteSource.selectSession(null)}
      />
    );
  } else if (detailVisible && !remoteMode && presentedLocalDetail) {
    surface = <SessionDetail session={presentedLocalDetail} onClose={onLocalClose} />;
  } else if (presentedView === 'live') {
    surface = (
      <div className="h-full overflow-y-auto scrollbar-deck px-3 py-2">
        <SessionList {...(remoteMode ? { remoteSource: presentedRemoteSource } : {})} />
      </div>
    );
  } else if (presentedView === 'data') {
    surface = <DataPanel remoteUsage={remoteMode ? remoteUsage : null} />;
  } else if (
    presentedView !== 'history' &&
    presentedView !== 'issues' &&
    presentedView !== 'pending'
  ) {
    surface = (
      <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-deck-muted">
        此页面目前只支持本机数据，当前远端连接暂不提供。
      </div>
    );
  }
  return (
    <div className="h-full">
      <div
        hidden={!historyListVisible}
        inert={(historyListVisible && (transitioning || remoteDetailDeferred)) || undefined}
        aria-disabled={(historyListVisible && (transitioning || remoteDetailDeferred)) || undefined}
        className="h-full"
      >
        <HistoryPanel
          {...(remoteMode ? { remoteSource } : {})}
          onPresentationReadyChange={onHistoryReady}
          onSelect={(sessionId) => {
            if (remoteMode) remoteSource.selectSession(sessionId);
            else onLocalHistorySelect(sessionId);
          }}
        />
      </div>
      <div
        hidden={!issuesVisible}
        inert={issuesVisible && transitioning || undefined}
        aria-disabled={issuesVisible && transitioning || undefined}
        className="h-full"
      >
        {remoteMode ? (
          <RemoteIssuesPanel
            active={issuesVisible}
            source={remoteSource}
            onPresentationReadyChange={onIssuesReady}
            onOpenSession={(sessionId) => {
              onViewChange('live');
              remoteSource.selectSession(sessionId);
            }}
          />
        ) : (
          <IssuesPanel
            active={issuesVisible}
            onPresentationReadyChange={onIssuesReady}
            onOpenSession={(sessionId) => {
              onViewChange('live');
              onOpenLocalSession(sessionId);
            }}
          />
        )}
      </div>
      <div
        hidden={!pendingVisible}
        inert={pendingVisible && transitioning || undefined}
        aria-disabled={pendingVisible && transitioning || undefined}
        className="h-full"
      >
        {(pendingVisible || !pendingReady) && (
          <PendingTab
            {...(remoteMode ? { remoteSource } : {})}
            onPresentationReadyChange={onPendingReady}
            onOpenSession={(sessionId) => {
              onViewChange('live');
              if (remoteMode) remoteSource.selectSession(sessionId);
              else onOpenLocalSession(sessionId);
            }}
          />
        )}
      </div>
      {!historyListVisible && !issuesVisible && !pendingVisible && (
        <div
          inert={transitioning || remoteDetailDeferred || undefined}
          aria-disabled={transitioning || remoteDetailDeferred || undefined}
          className="h-full"
        >
          {surface}
        </div>
      )}
    </div>
  );
}
