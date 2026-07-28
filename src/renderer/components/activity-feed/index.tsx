import { memo, useEffect, useMemo, useState, type JSX } from 'react';
import type {
  AgentEvent,
  AskUserQuestionRequest,
  DiffReviewRequest,
  ExitPlanModeRequest,
  PermissionRequest,
} from '@shared/types';
import {
  EMPTY_ASK_QUESTIONS,
  EMPTY_DIFF_REVIEWS,
  EMPTY_EXIT_PLAN_MODES,
  EMPTY_REQUESTS,
  RECENT_LIMIT,
  useSessionStore,
} from '@renderer/stores/session-store';
import { AskRow, DiffReviewRow, ExitPlanRow, PermissionRow } from '@renderer/components/pending-rows';
import log from '@renderer/utils/logger';
import { loadStableSnapshot } from '@renderer/lib/load-stable-snapshot';
import { EMPTY_EVENTS } from './shared';
import { MessageBubble } from './rows/message-row';
import { ThinkingBubble } from './rows/thinking-row';
import { ToolStartRow, ToolEndRow } from './rows/tool-row';
import { SimpleRow } from './rows/simple-row';
import { safeErrorData } from './viewers/safe-error-data';
import { activityEventIdentity } from './viewers/activity-event-identity';

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

  const { cancelledPermIds, cancelledAskIds, cancelledExitIds, cancelledDiffIds } = useMemo(() => {
    const perms = new Set<string>();
    const asks = new Set<string>();
    const exits = new Set<string>();
    const diffs = new Set<string>();
    for (const e of recent) {
      if (e.kind !== 'waiting-for-user') continue;
      const p = (e.payload ?? {}) as { type?: string; requestId?: string };
      const rid = p.requestId;
      if (!rid) continue;
      if (p.type === 'permission-cancelled') perms.add(rid);
      else if (p.type === 'ask-question-cancelled') asks.add(rid);
      else if (p.type === 'exit-plan-cancelled') exits.add(rid);
      else if (p.type === 'diff-review-cancelled') diffs.add(rid);
    }
    return { cancelledPermIds: perms, cancelledAskIds: asks, cancelledExitIds: exits, cancelledDiffIds: diffs };
  }, [recent]);

  const toolStartByUseId = useMemo(() => {
    const m = new Map<string, AgentEvent>();
    for (const e of recent) {
      if (e.kind !== 'tool-use-start') continue;
      const id = (e.payload as { toolUseId?: unknown })?.toolUseId;
      if (typeof id === 'string' && id) m.set(id, e);
    }
    return m;
  }, [recent]);

  if (!loaded && recent.length === 0) {
    return <div className="px-2 py-3 text-[11px] text-deck-muted">加载中…</div>;
  }
  if (loadError && recent.length === 0) {
    return (
      <div className="px-2 py-3 text-[11px] text-status-waiting/90 leading-snug">{loadError}</div>
    );
  }
  if (recent.length === 0) {
    return <div className="px-2 py-3 text-[11px] text-deck-muted">无活动记录</div>;
  }

  return (
    <ol
      className="flex min-w-0 flex-col gap-1.5 select-text"
      role="log"
      aria-live="polite"
      aria-relevant="additions"
    >
      {recent.map((e) => {
        const derived = deriveRowState(e, {
          pendingPermIds,
          pendingAskIds,
          pendingExitIds,
          pendingDiffIds,
          cancelledPermIds,
          cancelledAskIds,
          cancelledExitIds,
          cancelledDiffIds,
          toolStartByUseId,
        });
        return (
          <ActivityRow
            key={activityEventIdentity(e)}
            event={e}
            sessionId={sessionId}
            agentId={agentId}
            isSdk={isSdk}
            stillPending={derived.stillPending}
            wasCancelled={derived.wasCancelled}
            startEvent={derived.startEvent}
            resolvePermission={resolvePermission}
            resolveAsk={resolveAsk}
            resolveExitPlan={resolveExitPlan}
            resolveDiffReview={resolveDiffReview}
          />
        );
      })}
    </ol>
  );
}

interface RowProps {
  event: AgentEvent;
  sessionId: string;
  agentId: string;
  isSdk: boolean;
  stillPending: boolean;
  wasCancelled: boolean;
  startEvent?: AgentEvent;
  resolvePermission: (sessionId: string, requestId: string) => void;
  resolveAsk: (sessionId: string, requestId: string) => void;
  resolveExitPlan: (sessionId: string, requestId: string) => void;
  resolveDiffReview: (sessionId: string, requestId: string) => void;
}

export const ActivityRow = memo(function ActivityRow({
  event,
  sessionId,
  agentId,
  isSdk,
  stillPending,
  wasCancelled,
  startEvent,
  resolvePermission,
  resolveAsk,
  resolveExitPlan,
  resolveDiffReview,
}: RowProps): JSX.Element | null {
  if (event.kind === 'message') {
    return <MessageBubble event={event} agentId={agentId} />;
  }

  if (event.kind === 'thinking') {
    return <ThinkingBubble event={event} agentId={agentId} />;
  }

  if (event.kind === 'waiting-for-user') {
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const type = (p.type as string) ?? '';
    if (type === 'permission-request') {
      return (
        <PermissionRow
          event={event}
          payload={p as unknown as PermissionRequest}
          sessionId={sessionId}
          agentId={agentId}
          isSdk={isSdk}
          stillPending={stillPending}
          wasCancelled={wasCancelled}
          onResolved={resolvePermission}
        />
      );
    }
    if (type === 'ask-user-question') {
      return (
        <AskRow
          event={event}
          payload={p as unknown as AskUserQuestionRequest}
          sessionId={sessionId}
          agentId={agentId}
          isSdk={isSdk}
          stillPending={stillPending}
          wasCancelled={wasCancelled}
          onResolved={resolveAsk}
        />
      );
    }
    if (type === 'exit-plan-mode') {
      return (
        <ExitPlanRow
          event={event}
          payload={p as unknown as ExitPlanModeRequest}
          sessionId={sessionId}
          agentId={agentId}
          isSdk={isSdk}
          stillPending={stillPending}
          wasCancelled={wasCancelled}
          onResolved={resolveExitPlan}
        />
      );
    }
    if (type === 'diff-review') {
      return (
        <DiffReviewRow
          event={event}
          payload={p as unknown as DiffReviewRequest}
          sessionId={sessionId}
          agentId={agentId}
          isSdk={isSdk}
          stillPending={stillPending}
          wasCancelled={wasCancelled}
          onResolved={resolveDiffReview}
        />
      );
    }
    return <SimpleRow event={event} />;
  }

  if (event.kind === 'tool-use-start') {
    // SDK interactive tools already render as pending rows. Hook sessions lack that protocol
    // stream and keep tool rows. Use persisted session source because history omits event.source.
    if (isSdk) {
      const tn = (event.payload as { toolName?: unknown })?.toolName;
      if (tn === 'AskUserQuestion' || tn === 'ExitPlanMode') return null;
    }
    return <ToolStartRow event={event} sessionId={sessionId} />;
  }

  if (event.kind === 'tool-use-end') {
    if (isSdk) {
      // Persisted end events may omit the tool name, so pair them with their stable start event.
      const endTn = (event.payload as { toolName?: unknown })?.toolName;
      const startTn = (startEvent?.payload as { toolName?: unknown })?.toolName;
      const tn = typeof endTn === 'string' ? endTn : typeof startTn === 'string' ? startTn : undefined;
      if (tn === 'AskUserQuestion' || tn === 'ExitPlanMode') return null;
    }
    return <ToolEndRow event={event} sessionId={sessionId} startEvent={startEvent} />;
  }

  return <SimpleRow event={event} />;
});

interface DerivationSources {
  pendingPermIds: Set<string>;
  pendingAskIds: Set<string>;
  pendingExitIds: Set<string>;
  pendingDiffIds: Set<string>;
  cancelledPermIds: Set<string>;
  cancelledAskIds: Set<string>;
  cancelledExitIds: Set<string>;
  cancelledDiffIds: Set<string>;
  toolStartByUseId: Map<string, AgentEvent>;
}

function deriveRowState(
  event: AgentEvent,
  sources: DerivationSources,
): { stillPending: boolean; wasCancelled: boolean; startEvent?: AgentEvent } {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  if (event.kind === 'tool-use-end') {
    const useId = typeof payload.toolUseId === 'string' ? payload.toolUseId : '';
    return {
      stillPending: false,
      wasCancelled: false,
      startEvent: useId ? sources.toolStartByUseId.get(useId) : undefined,
    };
  }
  if (event.kind !== 'waiting-for-user') {
    return { stillPending: false, wasCancelled: false };
  }
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
  switch (payload.type) {
    case 'permission-request':
      return {
        stillPending: sources.pendingPermIds.has(requestId),
        wasCancelled: sources.cancelledPermIds.has(requestId),
      };
    case 'ask-user-question':
      return {
        stillPending: sources.pendingAskIds.has(requestId),
        wasCancelled: sources.cancelledAskIds.has(requestId),
      };
    case 'exit-plan-mode':
      return {
        stillPending: sources.pendingExitIds.has(requestId),
        wasCancelled: sources.cancelledExitIds.has(requestId),
      };
    case 'diff-review':
      return {
        stillPending: sources.pendingDiffIds.has(requestId),
        wasCancelled: sources.cancelledDiffIds.has(requestId),
      };
    default:
      return { stillPending: false, wasCancelled: false };
  }
}
