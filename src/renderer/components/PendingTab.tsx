import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
} from 'react';
import type { AgentEvent } from '@shared/types';
import { useSessionStore } from '@renderer/stores/session-store';
import { selectPendingBuckets, type PendingBucket } from '@renderer/lib/session-selectors';
import { deriveTeamRole } from '@renderer/lib/derive-team-role';
import { StatusBadge } from './StatusBadge';
import { AskRow, DiffReviewRow, ExitPlanRow, PermissionRow } from './pending-rows';
import { CheckIcon, ChevronRightIcon, CloseIcon, CrownIcon, ShieldIcon, UsersIcon } from './icons';
import log from '@renderer/utils/logger';
import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import { RemotePendingBucketSection } from './RemotePendingBucketSection';

/**
 * Central pending surface. It reuses the same request rows as the activity
 * feed; only permission requests participate in the serial batch actions.
 */
const logger = log.scope('renderer-pending-tab');

interface Props {
  onOpenSession: (sid: string) => void;
  remoteSource?: RemoteSessionSourceView;
}

export function PendingTab({ onOpenSession, remoteSource }: Props): JSX.Element {
  return remoteSource
    ? <RemotePendingTab source={remoteSource} onOpenSession={onOpenSession} />
    : <LocalPendingTab onOpenSession={onOpenSession} />;
}

function LocalPendingTab({ onOpenSession }: Pick<Props, 'onOpenSession'>): JSX.Element {
  const sessions = useSessionStore((s) => s.sessions);
  const pendingPerms = useSessionStore((s) => s.pendingPermissionsBySession);
  const pendingAsks = useSessionStore((s) => s.pendingAskQuestionsBySession);
  const pendingExits = useSessionStore((s) => s.pendingExitPlanModesBySession);
  const pendingDiffs = useSessionStore((s) => s.pendingDiffReviewsBySession);
  const resolvePermission = useSessionStore((s) => s.resolvePermission);
  const resolveAsk = useSessionStore((s) => s.resolveAskQuestion);
  const resolveExitPlan = useSessionStore((s) => s.resolveExitPlanMode);
  const resolveDiffReview = useSessionStore((s) => s.resolveDiffReview);

  const buckets = useMemo(
    () => selectPendingBuckets(sessions, pendingPerms, pendingAsks, pendingExits, pendingDiffs),
    [sessions, pendingPerms, pendingAsks, pendingExits, pendingDiffs],
  );

  if (buckets.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center text-deck-muted">
        <div className="text-[12px]">没有待处理事项</div>
        <div className="text-[10px] leading-relaxed text-deck-muted/70">
          当前没有需要你授权、回答或确认的内容。
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
            resolveDiffReview={resolveDiffReview}
          />
        ))}
      </ol>
    </div>
  );
}

function RemotePendingTab({
  source,
  onOpenSession,
}: {
  source: RemoteSessionSourceView;
  onOpenSession: (sid: string) => void;
}): JSX.Element {
  const buckets = source.pendingBuckets;
  if (!source.capabilities.has('pending.index.read')) {
    return <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-deck-muted">此 Remote Core 版本不支持完整待处理索引，请升级远端部署。</div>;
  }
  if (source.pendingLoading && buckets.length === 0) {
    return <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-deck-muted">正在读取远程待处理事项…</div>;
  }
  if (source.pendingLoadError && buckets.length === 0) {
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[11px] text-status-waiting">
        <span>{source.pendingLoadError}</span>
        <button type="button" onClick={source.refresh} className="rounded border border-white/10 px-2 py-1 text-[10px] hover:bg-white/[0.05]">重试</button>
      </div>
    );
  }
  if (source.pendingTotal === null && buckets.length === 0) {
    return (
      <div
        role="status"
        className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[11px] text-deck-muted"
      >
        <span>远程待处理总数尚未确认。</span>
        <button
          type="button"
          onClick={source.refresh}
          className="rounded border border-white/10 px-2 py-1 text-[10px] hover:bg-white/[0.05]"
        >
          重新读取
        </button>
      </div>
    );
  }
  if (buckets.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center text-deck-muted">
        <div className="text-[12px]">没有待处理事项</div>
        <div className="text-[10px] leading-relaxed text-deck-muted/70">
          当前没有需要你授权、回答或确认的内容。
        </div>
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto scrollbar-deck px-3 py-2">
      <div className="mb-2 flex items-center justify-between text-[10px] text-deck-muted/75">
        <span>
          {source.pendingTotal === null
            ? `总数待确认 · 已载入 ${buckets.reduce((sum, bucket) => sum + bucket.pending.requests.length, 0)} 项`
            : `待处理 ${source.pendingTotal} 项`}
        </span>
        {source.pendingScanTruncated && <span className="text-amber-300/80">结果已按安全上限截断</span>}
      </div>
      <ol className="flex flex-col gap-3">
        {buckets.map((bucket) => (
          <RemotePendingBucketSection
            key={`${source.identity}:${bucket.session.id}`}
            bucket={bucket}
            source={source}
            onOpenSession={onOpenSession}
          />
        ))}
      </ol>
      {source.hasMorePending && (
        <button
          type="button"
          disabled={source.pendingPaginationBusy ?? source.busy}
          onClick={() => void source.loadMorePending()}
          className="mt-3 w-full rounded border border-dashed border-white/10 px-3 py-2 text-[10px] text-deck-muted hover:bg-white/[0.04] disabled:opacity-40"
        >
          加载更多待处理会话
        </button>
      )}
      {source.pendingLoadError && (
        <div role="alert" className="mt-2 rounded bg-red-500/10 px-2 py-1 text-[10px] text-red-200">{source.pendingLoadError}</div>
      )}
    </div>
  );
}

function PendingSection({
  bucket,
  onOpenSession,
  resolvePermission,
  resolveAsk,
  resolveExitPlan,
  resolveDiffReview,
}: {
  bucket: PendingBucket;
  onOpenSession: (sid: string) => void;
  resolvePermission: (sid: string, rid: string) => void;
  resolveAsk: (sid: string, rid: string) => void;
  resolveExitPlan: (sid: string, rid: string) => void;
  resolveDiffReview: (sid: string, rid: string) => void;
}): JSX.Element {
  const { session, permissions, askQuestions, exitPlanModes, diffReviews, total } = bucket;
  const isSdk = session.source === 'sdk';
  const ts = session.lastEventAt;

  const batchableCount = permissions.length;
  const askCount = askQuestions.length;
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchFailure, setBatchFailure] = useState<{
    requestId: string;
    message: string;
  } | null>(null);
  const batchOperationRef = useRef(0);
  const mountedRef = useRef(true);
  const batchDisabled = batchableCount === 0 || !isSdk || batchBusy;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      batchOperationRef.current += 1;
    };
  }, []);

  // Team role uses the shared any-lead-wins derivation used by the session list.
  const primaryTeam = session.teams?.[0];
  const displayTeamName = primaryTeam?.teamName ?? null;
  const teamCount = session.teams?.length ?? 0;
  const teamRole = deriveTeamRole(session, false, 0, true);
  const teamHoverTitle =
    teamCount > 1
      ? `所在团队（${teamCount}）：\n${session.teams!.map((t) => `· ${t.teamName}［${t.role === 'lead' ? '负责人' : '协作者'}］`).join('\n')}`
      : displayTeamName
        ? `团队：${displayTeamName}［${teamRole === 'lead' ? '负责人' : teamRole === 'teammate' ? '协作者' : '未知'}］`
        : '';

  const batchTooltip = !isSdk
    ? '这是终端启动的只读会话，请回到原终端窗口操作'
    : batchableCount === 0
      ? diffReviews.length > 0
        ? '仅剩需要你逐条处理的差异展示'
        : '仅剩需要逐项处理的计划或问题'
      : `批量响应 ${permissions.length} 项权限请求${
          exitPlanModes.length + askCount + diffReviews.length > 0
            ? `；${exitPlanModes.length} 项计划确认、${askCount} 个问题、${diffReviews.length} 项差异展示需要逐条处理`
            : ''
        }`;

  const respondBatch = async (
    event: MouseEvent,
    decision: 'allow' | 'deny',
  ): Promise<void> => {
    event.stopPropagation();
    if (batchDisabled) return;
    const operation = ++batchOperationRef.current;
    setBatchBusy(true);
    setBatchFailure(null);
    try {
      for (const req of permissions) {
        try {
          await window.api.respondPermission(session.agentId, session.id, req.requestId, {
            decision,
            message: decision === 'deny' ? '用户批量拒绝' : undefined,
            updatedInput: decision === 'allow' ? req.toolInput : undefined,
          });
        } catch (error) {
          logger.error('permission batch response failed', {
            action: decision === 'allow'
              ? 'batchAllowPermissions'
              : 'batchDenyPermissions',
            agentId: session.agentId,
            requestId: req.requestId,
            sessionId: session.id,
            error,
          });
          if (
            mountedRef.current
            && batchOperationRef.current === operation
          ) {
            setBatchFailure({
              requestId: req.requestId,
              message: '批量响应在此项失败。请单独重试，或重新执行批量操作。',
            });
          }
          return;
        }
        if (
          mountedRef.current
          && batchOperationRef.current === operation
        ) {
          resolvePermission(session.id, req.requestId);
        }
      }
    } finally {
      if (
        mountedRef.current
        && batchOperationRef.current === operation
      ) {
        setBatchBusy(false);
      }
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
              title={isSdk ? '应用内创建的会话，可在这里回应' : '终端启动 · 只读'}
            >
              {isSdk ? '内' : '外'}
            </span>
            {displayTeamName && (
              <span
                className="max-w-[6rem] shrink-0 truncate rounded bg-purple-500/20 px-1 py-0.5 text-[9px] font-medium text-purple-300"
                title={teamHoverTitle}
              >
                <ShieldIcon className="mr-0.5 inline h-3 w-3" />{displayTeamName}
                {teamCount > 1 && <span className="ml-0.5 text-purple-300/70">+{teamCount - 1}</span>}
              </span>
            )}
            {teamRole === 'lead' && (
              <span
                className="shrink-0 rounded bg-blue-400/15 px-1 py-0.5 text-[9px] font-medium text-blue-200"
                title={`本会话在团队「${displayTeamName}」中是负责人`}
              >
                <CrownIcon className="mr-0.5 inline h-3 w-3" />负责人
              </span>
            )}
            {teamRole === 'teammate' && (
              <span
                className="shrink-0 rounded bg-blue-400/10 px-1 py-0.5 text-[9px] font-medium text-blue-200/85"
                title={`本会话在团队「${displayTeamName}」中是协作者`}
              >
                <UsersIcon className="mr-0.5 inline h-3 w-3" />协作者
              </span>
            )}
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
                onClick={(e) => void respondBatch(e, 'allow')}
                title={batchTooltip}
                className="rounded bg-status-working/30 px-2 py-0.5 text-[10px] text-status-working transition hover:bg-status-working/40 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <CheckIcon className="mr-1 inline h-3 w-3" />全部允许
              </button>
              <button
                type="button"
                disabled={batchDisabled}
                onClick={(e) => void respondBatch(e, 'deny')}
                title={batchTooltip}
                className="rounded bg-status-waiting/30 px-2 py-0.5 text-[10px] text-status-waiting transition hover:bg-status-waiting/40 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <CloseIcon className="mr-1 inline h-3 w-3" />全部拒绝
              </button>
              <span
                className="ml-0.5 select-none text-[12px] leading-none text-deck-muted/60"
                aria-hidden
              >
                <ChevronRightIcon className="h-3.5 w-3.5" />
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
            externalError={
              batchFailure?.requestId === req.requestId
                ? batchFailure.message
                : null
            }
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
        {diffReviews.map((req) => (
          <DiffReviewRow
            key={`d-${req.requestId}`}
            event={makeFakeEvent(session.id, session.agentId, ts, req)}
            payload={req}
            sessionId={session.id}
            agentId={session.agentId}
            isSdk={isSdk}
            stillPending={true}
            wasCancelled={false}
            onResolved={resolveDiffReview}
          />
        ))}
      </ol>
    </li>
  );
}

/** Pending request payloads have no timestamp, so rows use the session activity time. */
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

function shortenPath(p: string): string {
  if (!p) return '';
  const parts = p.split('/');
  if (parts.length <= 4) return p;
  return '…/' + parts.slice(-3).join('/');
}
