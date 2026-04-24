import { useMemo, useState, type JSX, type MouseEvent } from 'react';
import type { AgentEvent } from '@shared/types';
import { useSessionStore } from '@renderer/stores/session-store';
import { selectPendingBuckets, type PendingBucket } from '@renderer/lib/session-selectors';
import { StatusBadge } from './StatusBadge';
import { AskRow, ExitPlanRow, PermissionRow } from './pending-rows';

/**
 * 集中「待处理」面板。把所有有未响应请求的会话按 section 平铺，用户在此一屏完成
 * 跨会话的权限 / 提问 / 计划批准操作，不必逐个进 SessionDetail。
 *
 * 数据：纯派生于 store 的 sessions / 三张 pending Map（selectPendingBuckets），
 * 不引入任何 main 端调用。响应仍走三个 Row 内置的 window.api.respondX → 主进程的
 * sdk-bridge.respondPermission/AskUserQuestion/ExitPlanMode → SDK canUseTool
 * resolver。
 *
 * 与 ActivityFeed 的关系：完整复用同一套 PermissionRow / AskRow / ExitPlanRow
 * 组件（diff / 选项 / markdown 都保留）。stillPending 永远 true（来源就是当前
 * pending Map），wasCancelled 永远 false（取消事件已让 store 删 Map 项）。
 *
 * 视觉：每会话一个 section，header 整行可点击跳到 SessionDetail；right side 提供
 * 「全部允许」「全部拒绝」批量按钮（仅作用于 PermissionRequest + ExitPlanModeRequest，
 * AskUserQuestion 必须人审具体选项不参与批量）。
 */

interface Props {
  onOpenSession: (sid: string) => void;
}

export function PendingTab({ onOpenSession }: Props): JSX.Element {
  const sessions = useSessionStore((s) => s.sessions);
  const pendingPerms = useSessionStore((s) => s.pendingPermissionsBySession);
  const pendingAsks = useSessionStore((s) => s.pendingAskQuestionsBySession);
  const pendingExits = useSessionStore((s) => s.pendingExitPlanModesBySession);
  const resolvePermission = useSessionStore((s) => s.resolvePermission);
  const resolveAsk = useSessionStore((s) => s.resolveAskQuestion);
  const resolveExitPlan = useSessionStore((s) => s.resolveExitPlanMode);

  const buckets = useMemo(
    () => selectPendingBuckets(sessions, pendingPerms, pendingAsks, pendingExits),
    [sessions, pendingPerms, pendingAsks, pendingExits],
  );

  if (buckets.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center text-deck-muted">
        <div className="text-[12px]">暂无待处理</div>
        <div className="text-[10px] leading-relaxed text-deck-muted/70">
          所有会话当前都没有等待你响应的权限请求 / 提问 / 计划批准。
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto scrollbar-deck px-3 py-2">
      <ol className="flex flex-col gap-3">
        {buckets.map((b) => (
          <PendingSection
            key={b.session.id}
            bucket={b}
            onOpenSession={onOpenSession}
            resolvePermission={resolvePermission}
            resolveAsk={resolveAsk}
            resolveExitPlan={resolveExitPlan}
          />
        ))}
      </ol>
    </div>
  );
}

function PendingSection({
  bucket,
  onOpenSession,
  resolvePermission,
  resolveAsk,
  resolveExitPlan,
}: {
  bucket: PendingBucket;
  onOpenSession: (sid: string) => void;
  resolvePermission: (sid: string, rid: string) => void;
  resolveAsk: (sid: string, rid: string) => void;
  resolveExitPlan: (sid: string, rid: string) => void;
}): JSX.Element {
  const { session, permissions, askQuestions, exitPlanModes, total } = bucket;
  const isSdk = session.source === 'sdk';
  const ts = session.lastEventAt;

  const batchableCount = permissions.length + exitPlanModes.length;
  const askCount = askQuestions.length;
  const [batchBusy, setBatchBusy] = useState(false);
  const batchDisabled = batchableCount === 0 || !isSdk || batchBusy;

  const batchTooltip = !isSdk
    ? '外部 CLI 会话无法在此响应'
    : batchableCount === 0
      ? '仅剩 AskUserQuestion，请逐条作答'
      : `批量响应 ${permissions.length} 项权限请求 + ${exitPlanModes.length} 项计划批准${
          askCount > 0
            ? `；${askCount} 项 AskUserQuestion 不会被批量，请逐条选择`
            : ''
        }`;

  const onBatchAllow = async (e: MouseEvent): Promise<void> => {
    e.stopPropagation();
    if (batchDisabled) return;
    setBatchBusy(true);
    try {
      // 串行响应避免主进程并发 race；resolveX 同步删 store 的 pending 列表，
      // 下一帧 useMemo 重算让 row 逐条消失（动画感）。
      for (const req of permissions) {
        await window.api.respondPermission(session.agentId, session.id, req.requestId, {
          decision: 'allow',
          updatedInput: req.toolInput,
        });
        resolvePermission(session.id, req.requestId);
      }
      for (const req of exitPlanModes) {
        await window.api.respondExitPlanMode(session.agentId, session.id, req.requestId, {
          decision: 'approve',
        });
        resolveExitPlan(session.id, req.requestId);
      }
    } finally {
      setBatchBusy(false);
    }
  };

  const onBatchDeny = async (e: MouseEvent): Promise<void> => {
    e.stopPropagation();
    if (batchDisabled) return;
    setBatchBusy(true);
    try {
      for (const req of permissions) {
        await window.api.respondPermission(session.agentId, session.id, req.requestId, {
          decision: 'deny',
          message: '用户批量拒绝',
        });
        resolvePermission(session.id, req.requestId);
      }
      for (const req of exitPlanModes) {
        await window.api.respondExitPlanMode(session.agentId, session.id, req.requestId, {
          decision: 'keep-planning',
        });
        resolveExitPlan(session.id, req.requestId);
      }
    } finally {
      setBatchBusy(false);
    }
  };

  return (
    <li className="rounded-md border border-deck-border bg-white/[0.02]">
      <header
        className="flex cursor-pointer items-start gap-2 border-b border-deck-border/50 px-3 py-2 transition hover:bg-white/[0.04]"
        onClick={() => onOpenSession(session.id)}
        title="点击打开此会话详情"
      >
        <div className="mt-0.5 shrink-0">
          <StatusBadge
            activity={session.activity}
            lifecycle={session.lifecycle}
            archived={session.archivedAt !== null}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12px] font-medium text-deck-text">{session.title}</span>
            <span
              className={`shrink-0 rounded px-1 py-0.5 text-[8px] font-medium uppercase tracking-wider ${
                isSdk
                  ? 'bg-status-working/20 text-status-working'
                  : 'bg-white/8 text-deck-muted'
              }`}
              title={isSdk ? '应用内创建（SDK 通道，可在此回应）' : '外部终端 CLI 会话（只读）'}
            >
              {isSdk ? '内' : '外'}
            </span>
            <span className="shrink-0 rounded bg-status-waiting/25 px-1.5 py-0.5 text-[10px] font-medium text-status-waiting">
              {total}
            </span>
            <div
              className="ml-auto flex shrink-0 items-center gap-1"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                disabled={batchDisabled}
                onClick={(e) => void onBatchAllow(e)}
                title={batchTooltip}
                className="rounded bg-status-working/30 px-2 py-0.5 text-[10px] text-status-working transition hover:bg-status-working/40 disabled:cursor-not-allowed disabled:opacity-40"
              >
                全部允许
              </button>
              <button
                type="button"
                disabled={batchDisabled}
                onClick={(e) => void onBatchDeny(e)}
                title={batchTooltip}
                className="rounded bg-status-waiting/30 px-2 py-0.5 text-[10px] text-status-waiting transition hover:bg-status-waiting/40 disabled:cursor-not-allowed disabled:opacity-40"
              >
                全部拒绝
              </button>
              <span
                className="ml-0.5 select-none text-[12px] leading-none text-deck-muted/60"
                aria-hidden
              >
                ›
              </span>
            </div>
          </div>
          <div className="mt-0.5 truncate text-[10px] text-deck-muted/80" title={session.cwd}>
            {shortenPath(session.cwd)}
          </div>
        </div>
      </header>
      <ol
        className={`flex flex-col gap-1.5 select-text px-2 py-2 ${
          batchBusy ? 'pointer-events-none opacity-50' : ''
        }`}
        aria-disabled={batchBusy}
        title={batchBusy ? '批量响应进行中…' : undefined}
      >
        {permissions.map((req) => (
          <PermissionRow
            key={`p-${req.requestId}`}
            event={makeFakeEvent(session.id, session.agentId, ts, req)}
            payload={req}
            sessionId={session.id}
            agentId={session.agentId}
            isSdk={isSdk}
            stillPending={true}
            wasCancelled={false}
            onResolved={resolvePermission}
          />
        ))}
        {askQuestions.map((req) => (
          <AskRow
            key={`a-${req.requestId}`}
            event={makeFakeEvent(session.id, session.agentId, ts, req)}
            payload={req}
            sessionId={session.id}
            agentId={session.agentId}
            isSdk={isSdk}
            stillPending={true}
            wasCancelled={false}
            onResolved={resolveAsk}
          />
        ))}
        {exitPlanModes.map((req) => (
          <ExitPlanRow
            key={`e-${req.requestId}`}
            event={makeFakeEvent(session.id, session.agentId, ts, req)}
            payload={req}
            sessionId={session.id}
            agentId={session.agentId}
            isSdk={isSdk}
            stillPending={true}
            wasCancelled={false}
            onResolved={resolveExitPlan}
          />
        ))}
      </ol>
    </li>
  );
}

/**
 * 三个 Row 当前接口要求传 event: AgentEvent，仅用 event.ts 显示时间；
 * 不读 event.kind / event.payload（payload 已单独作为 prop 传入）。
 * PendingRequest 自身没有 ts 字段（见 shared/types.ts），用 session.lastEventAt 兜底。
 * 如未来要精确显示「pending 入库时间」，需在 store pushEvent 时给 pending 加 addedAt。
 */
function makeFakeEvent(
  sessionId: string,
  agentId: string,
  ts: number,
  payload: unknown,
): AgentEvent {
  return {
    sessionId,
    agentId,
    kind: 'waiting-for-user',
    payload,
    ts,
  };
}

/** 折叠过长 cwd：>4 段时只保留最后 3 段，前面用 …/ 缩写。 */
function shortenPath(p: string): string {
  if (!p) return '';
  const parts = p.split('/');
  if (parts.length <= 4) return p;
  return '…/' + parts.slice(-3).join('/');
}
