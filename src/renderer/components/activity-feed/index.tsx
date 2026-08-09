import { useEffect, useMemo, useState, type JSX } from 'react';
import {
  EMPTY_ASK_QUESTIONS,
  EMPTY_DIFF_REVIEWS,
  EMPTY_EXIT_PLAN_MODES,
  EMPTY_REQUESTS,
  RECENT_LIMIT,
  useSessionStore,
} from '@renderer/stores/session-store';
import log from '@renderer/utils/logger';
import { loadStableSnapshot } from '@renderer/lib/load-stable-snapshot';
import { EMPTY_EVENTS } from './shared';
import { ActivityRecordsView } from './records-view';
import { safeErrorData } from './viewers/safe-error-data';

export { ActivityRecordsView, ActivityRow } from './records-view';

const logger = log.scope('renderer-activity-feed');

interface Props {
  sessionId: string;
  agentId: string;
  isSdk: boolean;
}

type SetPendingRequests = ReturnType<typeof useSessionStore.getState>['setPendingRequests'];

async function refreshPendingRequests(
  agentId: string,
  sessionId: string,
  setPending: SetPendingRequests,
  isCancelled: () => boolean,
): Promise<void> {
  const result = await loadStableSnapshot({
    readVersion: () =>
      useSessionStore.getState().pendingRevisionsBySession.get(sessionId) ?? 0,
    load: () => window.api.listAdapterPending(agentId, sessionId),
    apply: (snapshot) => {
      setPending(
        sessionId,
        snapshot.permissions,
        snapshot.askQuestions,
        snapshot.exitPlanModes,
        snapshot.diffReviews,
      );
    },
    isCancelled,
  });
  if (result === 'unstable') {
    logger.warn('pending snapshot remained unstable', {
      action: 'refresh-pending',
      agentId,
      sessionId,
      teamId: null,
      source: 'adapter-pending',
      count: null,
    });
  }
}

export function ActivityFeed({ sessionId, agentId, isSdk }: Props): JSX.Element {
  const recent = useSessionStore((s) => s.recentEventsBySession.get(sessionId) ?? EMPTY_EVENTS);
  const setRecent = useSessionStore((s) => s.setRecentEvents);
  const pendingPermissions = useSessionStore(
    (s) => s.pendingPermissionsBySession.get(sessionId) ?? EMPTY_REQUESTS,
  );
  const pendingAskQuestions = useSessionStore(
    (s) => s.pendingAskQuestionsBySession.get(sessionId) ?? EMPTY_ASK_QUESTIONS,
  );
  const pendingExitPlanModes = useSessionStore(
    (s) => s.pendingExitPlanModesBySession.get(sessionId) ?? EMPTY_EXIT_PLAN_MODES,
  );
  const pendingDiffReviews = useSessionStore(
    (s) => s.pendingDiffReviewsBySession.get(sessionId) ?? EMPTY_DIFF_REVIEWS,
  );
  const resolvePermission = useSessionStore((s) => s.resolvePermission);
  const resolveAsk = useSessionStore((s) => s.resolveAskQuestion);
  const resolveExitPlan = useSessionStore((s) => s.resolveExitPlanMode);
  const resolveDiffReview = useSessionStore((s) => s.resolveDiffReview);
  const setPending = useSessionStore((s) => s.setPendingRequests);
  const [loaded, setLoaded] = useState(false);
  /** Keep load failures recoverable instead of leaving the feed in a perpetual loading state. */
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    setLoaded(false);
    setLoadError(null);
    void loadStableSnapshot({
      readVersion: () =>
        useSessionStore.getState().eventRevisionsBySession.get(sessionId) ?? 0,
      load: () => window.api.listEvents(sessionId, RECENT_LIMIT),
      apply: (events) => setRecent(sessionId, events),
      isCancelled: () => aborted,
    })
      .then((result) => {
        if (aborted) return;
        if (
          result === 'unstable' &&
          (useSessionStore.getState().recentEventsBySession.get(sessionId)?.length ?? 0) === 0
        ) {
          setLoadError('活动更新频繁，请稍后重试。');
        }
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (aborted) return;
        logger.warn('event history load failed', {
          action: 'load-event-history',
          agentId,
          sessionId,
          teamId: null,
          source: 'event-history',
          count: null,
          ...safeErrorData(err),
        });
        setLoadError('读取活动记录失败，请稍后重试。');
        setLoaded(true);
      });
    if (isSdk) {
      void refreshPendingRequests(agentId, sessionId, setPending, () => aborted)
        .catch((err: unknown) => {
          logger.warn('pending snapshot refresh failed', {
            action: 'initial-refresh-pending',
            agentId,
            sessionId,
            teamId: null,
            source: 'adapter-pending',
            count: null,
            ...safeErrorData(err),
          });
        });
    }
    return () => {
      aborted = true;
    };
  }, [sessionId, agentId, isSdk, setRecent, setPending]);

  // resume / 重连不会重挂 ActivityFeed，因此同会话 upsert 后主动同步一次主进程 pending。
  // 版本守门会避开同步窗口内的实时增删，重复拉取保持幂等。
  useEffect(() => {
    if (!isSdk) return;
    let cancelled = false;
    const off = window.api.onSessionUpserted((s) => {
      if (s.id !== sessionId) return;
      void refreshPendingRequests(agentId, sessionId, setPending, () => cancelled)
        .catch((err: unknown) => {
          logger.warn('pending snapshot refresh failed', {
            action: 'session-upsert-refresh-pending',
            agentId,
            sessionId,
            teamId: null,
            source: 'adapter-pending',
            count: null,
            ...safeErrorData(err),
          });
        });
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [sessionId, agentId, isSdk, setPending]);

  const pendingPermIds = useMemo(
    () => new Set(pendingPermissions.map((r) => r.requestId)),
    [pendingPermissions],
  );
  const pendingAskIds = useMemo(
    () => new Set(pendingAskQuestions.map((r) => r.requestId)),
    [pendingAskQuestions],
  );
  const pendingExitIds = useMemo(
    () => new Set(pendingExitPlanModes.map((r) => r.requestId)),
    [pendingExitPlanModes],
  );
  const pendingDiffIds = useMemo(
    () => new Set(pendingDiffReviews.map((r) => r.requestId)),
    [pendingDiffReviews],
  );
  return (
    <ActivityRecordsView
      events={recent}
      loaded={loaded}
      loadError={loadError}
      sessionId={sessionId}
      agentId={agentId}
      isSdk={isSdk}
      pendingIds={{
        permission: pendingPermIds,
        ask: pendingAskIds,
        exitPlan: pendingExitIds,
        diffReview: pendingDiffIds,
      }}
      resolvePermission={resolvePermission}
      resolveAsk={resolveAsk}
      resolveExitPlan={resolveExitPlan}
      resolveDiffReview={resolveDiffReview}
    />
  );
}
