import { memo, useMemo, type JSX } from 'react';
import { useDelayedAsyncFallback } from '@renderer/hooks/useDelayedAsyncFallback';

import { AskRow, DiffReviewRow, ExitPlanRow, PermissionRow } from '@renderer/components/pending-rows';
import type {
  AgentEvent,
  AskUserQuestionRequest,
  DiffReviewRequest,
  ExitPlanModeRequest,
  PermissionRequest,
} from '@shared/types';
import { activityEventIdentity } from './viewers/activity-event-identity';
import { MessageBubble } from './rows/message-row';
import { SimpleRow } from './rows/simple-row';
import { ThinkingBubble } from './rows/thinking-row';
import { ToolEndRow, ToolStartRow } from './rows/tool-row';

type ResolvePending = (sessionId: string, requestId: string) => void;
const EMPTY_IDS: ReadonlySet<string> = new Set();
const IGNORE_RESOLUTION: ResolvePending = () => undefined;

export interface ActivityRecordsViewProps {
  events: readonly AgentEvent[];
  loaded: boolean;
  loadError: string | null;
  sessionId: string;
  agentId: string;
  isSdk: boolean;
  allowLocalAssets?: boolean;
  interactivePending?: boolean;
  truncated?: boolean;
  pendingIds?: {
    permission: ReadonlySet<string>;
    ask: ReadonlySet<string>;
    exitPlan: ReadonlySet<string>;
    diffReview: ReadonlySet<string>;
  };
  resolvePermission?: ResolvePending;
  resolveAsk?: ResolvePending;
  resolveExitPlan?: ResolvePending;
  resolveDiffReview?: ResolvePending;
  renderPendingEvent?: (event: AgentEvent) => JSX.Element | null | undefined;
}

export function ActivityRecordsView({
  events,
  loaded,
  loadError,
  sessionId,
  agentId,
  isSdk,
  allowLocalAssets = true,
  interactivePending = true,
  truncated = false,
  pendingIds,
  resolvePermission = IGNORE_RESOLUTION,
  resolveAsk = IGNORE_RESOLUTION,
  resolveExitPlan = IGNORE_RESOLUTION,
  resolveDiffReview = IGNORE_RESOLUTION,
  renderPendingEvent,
}: ActivityRecordsViewProps): JSX.Element {
  const derived = useMemo(() => deriveSources(events, pendingIds), [events, pendingIds]);
  const initialPending = !loaded && loadError === null && events.length === 0;
  const showInitialLoading = useDelayedAsyncFallback(
    initialPending,
    `${sessionId}:activity-initial`,
  );
  if (loadError && events.length === 0) {
    return (
      <div className="px-2 py-3 text-[11px] text-status-waiting/90 leading-snug">
        {loadError}
      </div>
    );
  }
  if (initialPending) {
    return showInitialLoading
      ? <div className="px-2 py-3 text-[11px] text-deck-muted">加载中…</div>
      : <div className="h-full" aria-hidden="true" />;
  }
  if (events.length === 0) {
    return <div className="px-2 py-3 text-[11px] text-deck-muted">无活动记录</div>;
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {loadError && (
        <div role="alert" className="rounded border border-amber-400/15 bg-amber-500/5 px-2 py-1 text-[9px] text-amber-100/80">
          刷新活动记录失败（显示的是上次结果）：{loadError}
        </div>
      )}
      {truncated && (
        <div role="status" className="rounded border border-amber-400/15 bg-amber-500/5 px-2 py-1 text-[9px] text-amber-100/80">
          活动记录已达到远程读取上限，仅显示最近一页。
        </div>
      )}
      <ol
        className="flex min-w-0 flex-col gap-1.5 select-text"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
      >
        {events.map((event) => {
          const row = deriveRowState(event, derived);
          return (
            <ActivityRow
              key={activityEventIdentity(event)}
              event={event}
              sessionId={sessionId}
              agentId={agentId}
              isSdk={isSdk}
              allowLocalAssets={allowLocalAssets}
              interactivePending={interactivePending}
              stillPending={row.stillPending}
              wasCancelled={row.wasCancelled}
              startEvent={row.startEvent}
              resolvePermission={resolvePermission}
              resolveAsk={resolveAsk}
              resolveExitPlan={resolveExitPlan}
              resolveDiffReview={resolveDiffReview}
              renderPendingEvent={renderPendingEvent}
            />
          );
        })}
      </ol>
    </div>
  );
}

interface RowProps {
  event: AgentEvent;
  sessionId: string;
  agentId: string;
  isSdk: boolean;
  allowLocalAssets?: boolean;
  interactivePending?: boolean;
  stillPending: boolean;
  wasCancelled: boolean;
  startEvent?: AgentEvent;
  resolvePermission: ResolvePending;
  resolveAsk: ResolvePending;
  resolveExitPlan: ResolvePending;
  resolveDiffReview: ResolvePending;
  renderPendingEvent?: (event: AgentEvent) => JSX.Element | null | undefined;
}

export const ActivityRow = memo(function ActivityRow({
  event,
  sessionId,
  agentId,
  isSdk,
  allowLocalAssets = true,
  interactivePending = true,
  stillPending,
  wasCancelled,
  startEvent,
  resolvePermission,
  resolveAsk,
  resolveExitPlan,
  resolveDiffReview,
  renderPendingEvent,
}: RowProps): JSX.Element | null {
  if (
    event.kind === 'finished' &&
    (event.payload as { suppressTimeline?: unknown } | null)?.suppressTimeline === true
  ) return null;
  if (event.kind === 'message') {
    return <MessageBubble event={event} agentId={agentId} showAttachments={allowLocalAssets} />;
  }
  if (event.kind === 'thinking') return <ThinkingBubble event={event} agentId={agentId} />;
  if (event.kind === 'waiting-for-user') {
    const injected = renderPendingEvent?.(event);
    if (injected !== undefined) return injected;
    if (!interactivePending) return <SimpleRow event={event} />;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const type = (payload.type as string) ?? '';
    if (type === 'permission-request') {
      return <PermissionRow event={event} payload={payload as unknown as PermissionRequest}
        sessionId={sessionId} agentId={agentId} isSdk={isSdk} stillPending={stillPending}
        wasCancelled={wasCancelled} onResolved={resolvePermission} />;
    }
    if (type === 'ask-user-question') {
      return <AskRow event={event} payload={payload as unknown as AskUserQuestionRequest}
        sessionId={sessionId} agentId={agentId} isSdk={isSdk} stillPending={stillPending}
        wasCancelled={wasCancelled} onResolved={resolveAsk} />;
    }
    if (type === 'exit-plan-mode') {
      return <ExitPlanRow event={event} payload={payload as unknown as ExitPlanModeRequest}
        sessionId={sessionId} agentId={agentId} isSdk={isSdk} stillPending={stillPending}
        wasCancelled={wasCancelled} onResolved={resolveExitPlan} />;
    }
    if (type === 'diff-review') {
      return <DiffReviewRow event={event} payload={payload as unknown as DiffReviewRequest}
        sessionId={sessionId} agentId={agentId} isSdk={isSdk} stillPending={stillPending}
        wasCancelled={wasCancelled} onResolved={resolveDiffReview} />;
    }
    return <SimpleRow event={event} />;
  }
  if (event.kind === 'tool-use-start') {
    if (isSdk) {
      const toolName = (event.payload as { toolName?: unknown })?.toolName;
      if (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode') return null;
    }
    return <ToolStartRow event={event} sessionId={sessionId} allowLocalAssets={allowLocalAssets} />;
  }
  if (event.kind === 'tool-use-end') {
    if (isSdk) {
      const endName = (event.payload as { toolName?: unknown })?.toolName;
      const startName = (startEvent?.payload as { toolName?: unknown })?.toolName;
      const toolName = typeof endName === 'string'
        ? endName
        : typeof startName === 'string' ? startName : undefined;
      if (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode') return null;
    }
    return <ToolEndRow event={event} startEvent={startEvent} />;
  }
  return <SimpleRow event={event} />;
});

interface DerivationSources {
  pendingPermIds: ReadonlySet<string>;
  pendingAskIds: ReadonlySet<string>;
  pendingExitIds: ReadonlySet<string>;
  pendingDiffIds: ReadonlySet<string>;
  cancelledPermIds: ReadonlySet<string>;
  cancelledAskIds: ReadonlySet<string>;
  cancelledExitIds: ReadonlySet<string>;
  cancelledDiffIds: ReadonlySet<string>;
  toolStartByUseId: ReadonlyMap<string, AgentEvent>;
}

function deriveSources(
  events: readonly AgentEvent[],
  pendingIds: ActivityRecordsViewProps['pendingIds'],
): DerivationSources {
  const cancelledPermIds = new Set<string>();
  const cancelledAskIds = new Set<string>();
  const cancelledExitIds = new Set<string>();
  const cancelledDiffIds = new Set<string>();
  const toolStartByUseId = new Map<string, AgentEvent>();
  for (const event of events) {
    if (event.kind === 'tool-use-start') {
      const id = (event.payload as { toolUseId?: unknown })?.toolUseId;
      if (typeof id === 'string' && id) toolStartByUseId.set(id, event);
    }
    if (event.kind !== 'waiting-for-user') continue;
    const payload = (event.payload ?? {}) as { type?: string; requestId?: string };
    if (!payload.requestId) continue;
    if (payload.type === 'permission-cancelled') cancelledPermIds.add(payload.requestId);
    else if (payload.type === 'ask-question-cancelled') cancelledAskIds.add(payload.requestId);
    else if (payload.type === 'exit-plan-cancelled') cancelledExitIds.add(payload.requestId);
    else if (payload.type === 'diff-review-cancelled') cancelledDiffIds.add(payload.requestId);
  }
  return {
    pendingPermIds: pendingIds?.permission ?? EMPTY_IDS,
    pendingAskIds: pendingIds?.ask ?? EMPTY_IDS,
    pendingExitIds: pendingIds?.exitPlan ?? EMPTY_IDS,
    pendingDiffIds: pendingIds?.diffReview ?? EMPTY_IDS,
    cancelledPermIds,
    cancelledAskIds,
    cancelledExitIds,
    cancelledDiffIds,
    toolStartByUseId,
  };
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
    case 'permission-request': return {
      stillPending: sources.pendingPermIds.has(requestId),
      wasCancelled: sources.cancelledPermIds.has(requestId),
    };
    case 'ask-user-question': return {
      stillPending: sources.pendingAskIds.has(requestId),
      wasCancelled: sources.cancelledAskIds.has(requestId),
    };
    case 'exit-plan-mode': return {
      stillPending: sources.pendingExitIds.has(requestId),
      wasCancelled: sources.cancelledExitIds.has(requestId),
    };
    case 'diff-review': return {
      stillPending: sources.pendingDiffIds.has(requestId),
      wasCancelled: sources.cancelledDiffIds.has(requestId),
    };
    default: return { stillPending: false, wasCancelled: false };
  }
}
