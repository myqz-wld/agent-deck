import { memo, useEffect, useMemo, useState, type JSX } from 'react';
import type {
  AgentEvent,
  AskUserQuestionRequest,
  ExitPlanModeRequest,
  PermissionRequest,
} from '@shared/types';
import {
  EMPTY_ASK_QUESTIONS,
  EMPTY_EXIT_PLAN_MODES,
  EMPTY_REQUESTS,
  RECENT_LIMIT,
  useSessionStore,
} from '@renderer/stores/session-store';
import { AskRow, ExitPlanRow, PermissionRow } from '@renderer/components/pending-rows';
import { EMPTY_EVENTS } from './shared';
import { eventKey } from './format';
import { MessageBubble } from './rows/message-row';
import { ThinkingBubble } from './rows/thinking-row';
import { ToolStartRow, ToolEndRow } from './rows/tool-row';
import { SimpleRow } from './rows/simple-row';

interface Props {
  sessionId: string;
  agentId: string;
  isSdk: boolean;
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
  const resolvePermission = useSessionStore((s) => s.resolvePermission);
  const resolveAsk = useSessionStore((s) => s.resolveAskQuestion);
  const resolveExitPlan = useSessionStore((s) => s.resolveExitPlanMode);
  const setPending = useSessionStore((s) => s.setPendingRequests);
  const [loaded, setLoaded] = useState(false);
  /** REVIEW_4 M18：listEvents IPC 失败时显示可恢复错误态而非死锁在「加载中…」 */
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    setLoaded(false);
    setLoadError(null);
    void window.api
      .listEvents(sessionId, RECENT_LIMIT)
      .then((events) => {
        if (aborted) return;
        setRecent(sessionId, events);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (aborted) return;
        setLoadError(`加载历史事件失败：${(err as Error).message ?? String(err)}`);
        setLoaded(true);
      });
    if (isSdk) {
      void window.api
        .listAdapterPending(agentId, sessionId)
        .then((res) => {
          if (aborted) return;
          setPending(sessionId, res.permissions, res.askQuestions, res.exitPlanModes);
        })
        .catch((err: unknown) => {
          console.warn('[activity-feed] listAdapterPending failed:', err);
        });
    }
    return () => {
      aborted = true;
    };
  }, [sessionId, agentId, isSdk, setRecent, setPending]);

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

  // R3.E7：删 cancelledTeamPermIds（老 inbox 协议下线）
  const { cancelledPermIds, cancelledAskIds, cancelledExitIds } = useMemo(() => {
    const perms = new Set<string>();
    const asks = new Set<string>();
    const exits = new Set<string>();
    for (const e of recent) {
      if (e.kind !== 'waiting-for-user') continue;
      const p = (e.payload ?? {}) as { type?: string; requestId?: string };
      const rid = p.requestId;
      if (!rid) continue;
      if (p.type === 'permission-cancelled') perms.add(rid);
      else if (p.type === 'ask-question-cancelled') asks.add(rid);
      else if (p.type === 'exit-plan-cancelled') exits.add(rid);
    }
    return { cancelledPermIds: perms, cancelledAskIds: asks, cancelledExitIds: exits };
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
      className="flex flex-col gap-1.5 select-text"
      role="log"
      aria-live="polite"
      aria-relevant="additions"
    >
      {recent.map((e) => (
        <ActivityRow
          key={eventKey(e)}
          event={e}
          sessionId={sessionId}
          agentId={agentId}
          isSdk={isSdk}
          pendingPermIds={pendingPermIds}
          pendingAskIds={pendingAskIds}
          pendingExitIds={pendingExitIds}
          cancelledPermIds={cancelledPermIds}
          cancelledAskIds={cancelledAskIds}
          cancelledExitIds={cancelledExitIds}
          toolStartByUseId={toolStartByUseId}
          resolvePermission={resolvePermission}
          resolveAsk={resolveAsk}
          resolveExitPlan={resolveExitPlan}
        />
      ))}
    </ol>
  );
}

interface RowProps {
  event: AgentEvent;
  sessionId: string;
  agentId: string;
  isSdk: boolean;
  pendingPermIds: Set<string>;
  pendingAskIds: Set<string>;
  pendingExitIds: Set<string>;
  cancelledPermIds: Set<string>;
  cancelledAskIds: Set<string>;
  cancelledExitIds: Set<string>;
  toolStartByUseId: Map<string, AgentEvent>;
  resolvePermission: (sessionId: string, requestId: string) => void;
  resolveAsk: (sessionId: string, requestId: string) => void;
  resolveExitPlan: (sessionId: string, requestId: string) => void;
}

const ActivityRow = memo(function ActivityRow({
  event,
  sessionId,
  agentId,
  isSdk,
  pendingPermIds,
  pendingAskIds,
  pendingExitIds,
  cancelledPermIds,
  cancelledAskIds,
  cancelledExitIds,
  toolStartByUseId,
  resolvePermission,
  resolveAsk,
  resolveExitPlan,
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
      const rid = (p.requestId as string) ?? '';
      return (
        <PermissionRow
          event={event}
          payload={p as unknown as PermissionRequest}
          sessionId={sessionId}
          agentId={agentId}
          isSdk={isSdk}
          stillPending={pendingPermIds.has(rid)}
          wasCancelled={cancelledPermIds.has(rid)}
          onResolved={resolvePermission}
        />
      );
    }
    if (type === 'ask-user-question') {
      const rid = (p.requestId as string) ?? '';
      return (
        <AskRow
          event={event}
          payload={p as unknown as AskUserQuestionRequest}
          sessionId={sessionId}
          agentId={agentId}
          isSdk={isSdk}
          stillPending={pendingAskIds.has(rid)}
          wasCancelled={cancelledAskIds.has(rid)}
          onResolved={resolveAsk}
        />
      );
    }
    if (type === 'exit-plan-mode') {
      const rid = (p.requestId as string) ?? '';
      return (
        <ExitPlanRow
          event={event}
          payload={p as unknown as ExitPlanModeRequest}
          sessionId={sessionId}
          agentId={agentId}
          isSdk={isSdk}
          stillPending={pendingExitIds.has(rid)}
          wasCancelled={cancelledExitIds.has(rid)}
          onResolved={resolveExitPlan}
        />
      );
    }
    return <SimpleRow event={event} />;
  }

  if (event.kind === 'tool-use-start') {
    // SDK 通道下 AskUserQuestion / ExitPlanMode 走协议级 deny + message 注入答案/决策，
    // 同一次调用已由 AskRow / ExitPlanRow 完整渲染（提问 + 选项 + 用户状态）。
    // 这里再渲染 ToolStartRow 是冗余，且配合 tool-use-end 会让用户看到「AskUserQuestion 失败」
    // 的红框（实际上是 SDK 把 deny 翻成 is_error → translate 翻成 status='failed'）。
    // hook 通道（外部 CLI）拿不到 canUseTool 通路，没有 AskRow / ExitPlanRow，必须保留 ToolStartRow
    // 来显示 plan / 提问内容，因此只对应用内 SDK 会话隐藏。
    //
    // 注意：用 session-level `isSdk` 而非 event-level `event.source`，原因 ——
    // events 表 schema 没有 source 列（见 event-repo.ts:5-12 / insert 行），listEvents 重新拉
    // 历史事件时 event.source === undefined，REVIEW_26 修法对刷新 / 切会话后的旧事件失效。
    // session.source 持久化在 sessions 表里、`isSdk = session.source === 'sdk'` 在父组件按会话计算。
    // 两者等价：manager.ts:196 已保证 sdkOwned session 不会保留 hook 事件，所以 sdk 会话内
    // 所有事件都源自 SDK 通道，cli 会话内所有事件都源自 hook 通道。
    if (isSdk) {
      const tn = (event.payload as { toolName?: unknown })?.toolName;
      if (tn === 'AskUserQuestion' || tn === 'ExitPlanMode') return null;
    }
    return <ToolStartRow event={event} sessionId={sessionId} />;
  }

  if (event.kind === 'tool-use-end') {
    const useId = (event.payload as { toolUseId?: unknown })?.toolUseId;
    const startEvent =
      typeof useId === 'string' && useId ? toolStartByUseId.get(useId) : undefined;
    if (isSdk) {
      // toolName 优先取 end 事件的；老事件可能没带 → 反查同 useId 的 start 事件兜底
      const endTn = (event.payload as { toolName?: unknown })?.toolName;
      const startTn = (startEvent?.payload as { toolName?: unknown })?.toolName;
      const tn = typeof endTn === 'string' ? endTn : typeof startTn === 'string' ? startTn : undefined;
      if (tn === 'AskUserQuestion' || tn === 'ExitPlanMode') return null;
    }
    return <ToolEndRow event={event} sessionId={sessionId} startEvent={startEvent} />;
  }

  return <SimpleRow event={event} />;
});
