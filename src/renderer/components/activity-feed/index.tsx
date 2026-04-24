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
    // aborted flag：切会话快时（< loadEvents/listAdapterPending 返回耗时），
    // 旧会话的 then 回调如果已经被新会话的 useEffect 重跑替换，
    // 仍然会执行 setRecent / setPending，把旧会话事件灌进新会话 recentEventsBySession。
    // setSessions 的 prune 间接缓冲了这种 orphan，但 race 窗口里 UI 仍会闪一次错数据。
    let aborted = false;
    setLoaded(false);
    setLoadError(null);
    // REVIEW_4 H4：与 store 的 RECENT_LIMIT 对齐。旧版硬编码 100 而 RECENT_LIMIT=30 时
    // 一推新事件 70 条历史秒蒸发；现在常量同源避免再走样。
    void window.api
      .listEvents(sessionId, RECENT_LIMIT)
      .then((events) => {
        if (aborted) return;
        setRecent(sessionId, events);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (aborted) return;
        // REVIEW_4 M18：IPC reject 不再让 setLoaded(true) 永不执行（feed 卡死在加载态）。
        // 进可恢复错误态：UI 显示错误（store 仍按上一次值渲染，避免 0 历史白屏）。
        setLoadError(`加载历史事件失败：${(err as Error).message ?? String(err)}`);
        setLoaded(true);
      });
    // 同步该会话当前真实的 pending 请求 —— renderer HMR / 切会话后 store 可能跟主进程脱节，
    // 不拉的话事件流里的 permission-request 会被错渲成「已处理」按钮不显示。
    if (isSdk) {
      void window.api
        .listAdapterPending(agentId, sessionId)
        .then((res) => {
          if (aborted) return;
          setPending(sessionId, res.permissions, res.askQuestions, res.exitPlanModes);
        })
        .catch((err: unknown) => {
          if (aborted) return;
          // permission 拉不到只影响 banner / 按钮可见性，不阻塞 feed 渲染，静默 console。
          console.warn('[activity-feed] listAdapterPending failed:', err);
        });
    }
    return () => {
      aborted = true;
    };
  }, [sessionId, agentId, isSdk, setRecent, setPending]);

  // REVIEW_4 M14：pendingPermIds / cancelled* Set 用 useMemo 锁定，
  // 旧版每次 render 新建 Set 让所有 row 的 props 引用变化，React.memo 失效；
  // 同时把 cancelled scan 也合并 useMemo 依赖到 [recent]，避免每次 parent rerender 都 O(n) 扫。
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

  // 扫一遍历史事件，收集「被 SDK 取消」过的 requestId 三组集合。
  // SDK 取消 ≠ 用户响应：流终止 / interrupt / 超时时主进程会 emit 一条 `*-cancelled` 事件，
  // 同时把对应 pending 从 store 删掉。光看 stillPending=false 没法区分「用户拒绝/允许」与「被取消」，
  // UI 之前用同一句「已响应或已被 SDK 取消」糊在一起，看不出来到底谁动的。
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
    // select-text 覆盖全局 `#root { user-select: none }`（globals.css 那条是为了拖窗时不选中文字）。
    // 活动流不参与拖窗（拖窗只在 header 的 .drag-region），整体放开方便用户复制对话内容、
    // tool 输出、JSON 入参等；button / select 因 chromium user-agent 默认自带 user-select: none，
    // 不会被影响，textarea / input 本身就可选。
    // REVIEW_4 L1：role="log" + aria-live="polite" 让屏阅器跟进新事件。
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
  resolvePermission: (sessionId: string, requestId: string) => void;
  resolveAsk: (sessionId: string, requestId: string) => void;
  resolveExitPlan: (sessionId: string, requestId: string) => void;
}

/**
 * 单条事件 dispatcher。把"可操作"的事件（权限请求、AskUserQuestion、ExitPlanMode）直接内嵌按钮，
 * 把"信息密集"的事件（Edit 类工具调用、tool result）直接展开 diff/结果，
 * 让用户在活动流里就能完成全部交互，不必跳到顶部 banner。
 *
 * REVIEW_4 M14：包 React.memo —— props 引用稳定（pendingPermIds 等用 useMemo + 父级 callback 不变）
 * 时跳过 re-render。如果 event 引用不变但 set 内容变（如某条 permission 从 pending 变 cancelled），
 * Set 引用变化会触发该 row re-render，符合预期。
 */
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
  resolvePermission,
  resolveAsk,
  resolveExitPlan,
}: RowProps): JSX.Element {
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
    return <ToolStartRow event={event} sessionId={sessionId} />;
  }

  if (event.kind === 'tool-use-end') {
    return <ToolEndRow event={event} sessionId={sessionId} />;
  }

  return <SimpleRow event={event} />;
});
