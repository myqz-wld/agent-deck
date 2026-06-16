import { useMemo, useState, type JSX } from 'react';
import type { AgentEvent, ExitPlanModeRequest, ExitPlanModeResponse } from '@shared/types';
import log from '@renderer/utils/logger';
import { MemoizedMarkdownText } from '../MarkdownText';

const logger = log.scope('renderer-exit-plan-row');
const PLAN_COLLAPSE_THRESHOLD_CHARS = 1_800;
const PLAN_COLLAPSE_THRESHOLD_LINES = 36;

/**
 * ExitPlanMode / MCP plan review row. Native Claude ExitPlanMode keeps the
 * permission-mode selector; MCP plan review is approval/feedback only.
 */
export function ExitPlanRow({
  event,
  payload,
  sessionId,
  agentId,
  isSdk,
  stillPending,
  wasCancelled,
  onResolved,
}: {
  event: AgentEvent;
  payload: ExitPlanModeRequest;
  sessionId: string;
  agentId: string;
  isSdk: boolean;
  stillPending: boolean;
  wasCancelled: boolean;
  onResolved: (sessionId: string, requestId: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [targetMode, setTargetMode] = useState<
    'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
  >('acceptEdits');

  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const plan = payload.plan || '(计划内容为空)';
  const isMcpPlanReview = payload.reviewSource === 'mcp';
  const actorName = isMcpPlanReview ? '模型' : 'Claude';

  const targetModeLabel: Record<typeof targetMode, string> = {
    default: '每次询问',
    acceptEdits: '自动接受编辑',
    plan: '继续计划模式',
    bypassPermissions: '⚠️ 不再询问',
  };

  const respond = async (response: ExitPlanModeResponse): Promise<void> => {
    if (!isSdk || !stillPending || busy) return;
    setBusy(true);
    try {
      await window.api.respondExitPlanMode(agentId, sessionId, payload.requestId, response);
      onResolved(sessionId, payload.requestId);
    } catch (err) {
      logger.error('respondExitPlanMode failed', err);
    } finally {
      setBusy(false);
    }
  };

  const onClickApprove = async (): Promise<void> => {
    if (isMcpPlanReview) {
      void respond({ decision: 'approve', targetMode: 'default' });
      return;
    }
    if (targetMode === 'bypassPermissions') {
      const ok = await window.api.confirmDialog({
        title: '批准并切换到完全免询问',
        message: '需要重启当前会话',
        detail:
          '重启后,Claude 直接按计划执行 —— 全过程不再向你确认任何工具调用。重启约需 5-10 秒。\n\n' +
          '失败时会自动回到计划模式。继续?',
        okLabel: '重启并启用',
        cancelLabel: '取消',
        destructive: true,
      });
      if (!ok) return;
      void respond({ decision: 'approve-bypass' });
      return;
    }
    void respond({ decision: 'approve', targetMode });
  };

  const onClickKeepPlanning = (): void => {
    if (!showFeedback) {
      setShowFeedback(true);
      return;
    }
    void respond({ decision: 'keep-planning', feedback: feedback.trim() || undefined });
  };

  return (
    <li
      className={`min-w-0 rounded-md border p-2 text-[11px] ${
        stillPending
          ? 'border-status-working/40 bg-status-working/10'
          : wasCancelled
            ? 'border-deck-border/40 bg-white/[0.015] opacity-50'
            : 'border-deck-border/60 bg-white/[0.02] opacity-70'
      }`}
    >
      <div className="mb-1.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px]">
        <span
          className={
            stillPending
              ? 'text-status-working'
              : wasCancelled
                ? 'text-deck-muted/70'
                : 'text-status-working/80'
          }
        >
          {stillPending
            ? isMcpPlanReview
              ? '📋 待检阅计划'
              : '📋 收到一个执行计划'
            : wasCancelled
              ? '🚫 计划检阅已被取消'
              : '✅ 已处理'}
        </span>
        {payload.title && (
          <span
            className="max-w-[16rem] truncate rounded bg-white/[0.06] px-1.5 py-0.5 text-deck-muted/90"
            title={payload.title}
          >
            {payload.title}
          </span>
        )}
        <span className="font-mono tabular-nums text-deck-muted/60">{ts}</span>
        {stillPending && isSdk && (
          <div className="ml-auto flex min-w-0 flex-wrap items-center gap-1">
            {!isMcpPlanReview && (
              <select
                value={targetMode}
                disabled={busy}
                onChange={(e) => setTargetMode(e.target.value as typeof targetMode)}
                title="批准计划后切换到的权限模式(完全免询问需要重启会话)"
                className="rounded border border-deck-border bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-deck-text outline-none focus:border-white/20 disabled:opacity-50"
              >
                <option value="default" title="每次工具调用前都询问">每次询问</option>
                <option value="acceptEdits" title="自动允许文件编辑；其他工具仍需询问">自动接受编辑</option>
                <option value="plan" title="保持计划模式，不执行任何工具">继续计划模式</option>
                <option value="bypassPermissions" title="不再询问任何工具调用；需要重启会话">⚠️ 不再询问</option>
              </select>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void onClickApprove()}
              title={
                isMcpPlanReview
                  ? '批准计划并把结果返回给模型'
                  : targetMode === 'bypassPermissions'
                    ? '批准计划并切到完全免询问模式(需重启会话,5-10 秒)'
                    : `批准计划并切到「${targetModeLabel[targetMode]}」`
              }
              className="rounded bg-status-working px-2.5 py-0.5 text-[10px] font-semibold text-black shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isMcpPlanReview ? '批准计划' : `批准并切到 ${targetModeLabel[targetMode]}`}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onClickKeepPlanning}
              title={
                showFeedback
                  ? feedback.trim()
                    ? `把反馈发给${actorName}，让它修改计划`
                    : `不写反馈也可以，${actorName}会主动询问需要补充哪方面`
                  : `让${actorName}继续修改计划（点击后可写反馈）`
              }
              className="rounded border border-deck-border bg-white/[0.06] px-2.5 py-0.5 text-[10px] text-deck-text hover:bg-white/[0.12] disabled:opacity-50"
            >
              继续规划
            </button>
          </div>
        )}
      </div>

      <PlanMarkdownPanel plan={plan} />

      {stillPending && isSdk && showFeedback && (
        <div className="mt-2 flex flex-col gap-1">
          <label className="text-[10px] text-deck-muted">
            可选:告诉{actorName}哪里需要调整(留空也能提交)
          </label>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="比如:步骤 3 不要改 main 进程;先做 UI 验证再写 SDK..."
            rows={2}
            disabled={busy}
            className="w-full resize-none rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[10px] outline-none focus:border-white/20 disabled:opacity-50"
          />
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setShowFeedback(false);
                setFeedback('');
              }}
              className="rounded px-2 py-0.5 text-[10px] text-deck-muted hover:bg-white/5"
            >
              取消
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void respond({
                  decision: 'keep-planning',
                  feedback: feedback.trim() || undefined,
                })
              }
              className="rounded bg-deck-text/80 px-2.5 py-0.5 text-[10px] font-semibold text-deck-bg-strong hover:brightness-110 disabled:opacity-40"
            >
              发送反馈,继续规划
            </button>
          </div>
        </div>
      )}

      {!isSdk && (
        <div className="mt-1.5 text-[10px] text-deck-muted">
          这是终端启动的只读会话，请回到原终端窗口批准
        </div>
      )}
      {!stillPending && isSdk && wasCancelled && (
        <div className="mt-1.5 text-[10px] text-deck-muted/70">
          这次计划检阅请求已取消
        </div>
      )}
    </li>
  );
}

function PlanMarkdownPanel({ plan }: { plan: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const lineCount = plan.split('\n').length;
  const isLong =
    plan.length > PLAN_COLLAPSE_THRESHOLD_CHARS ||
    lineCount > PLAN_COLLAPSE_THRESHOLD_LINES;
  const renderedPlan = useMemo(
    () => (isLong && !expanded ? buildCollapsedPlanPreview(plan) : plan),
    [expanded, isLong, plan],
  );

  return (
    <div className="min-w-0 rounded border border-deck-border/40 bg-black/20 p-2">
      <div
        className={`min-h-0 ${
          isLong && !expanded ? 'max-h-[42vh] overflow-auto scrollbar-deck pr-1' : ''
        }`}
      >
        <MemoizedMarkdownText text={renderedPlan} />
      </div>
      {isLong && (
        <div className="mt-1.5 flex justify-end">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="rounded border border-deck-border bg-white/[0.04] px-2 py-0.5 text-[10px] text-deck-muted hover:bg-white/[0.08] hover:text-deck-text"
          >
            {expanded ? '收起' : `展开全部（${plan.length} 字）`}
          </button>
        </div>
      )}
    </div>
  );
}

function buildCollapsedPlanPreview(plan: string): string {
  const byLine = plan.split('\n').slice(0, PLAN_COLLAPSE_THRESHOLD_LINES).join('\n');
  const clipped =
    byLine.length > PLAN_COLLAPSE_THRESHOLD_CHARS
      ? byLine.slice(0, PLAN_COLLAPSE_THRESHOLD_CHARS).replace(/\s+\S*$/, '').trimEnd()
      : byLine;
  return clipped.length < plan.length ? `${clipped}\n\n...` : clipped;
}
