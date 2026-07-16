import { useState, type JSX, type KeyboardEvent } from 'react';
import type { AgentEvent, ExitPlanModeRequest, ExitPlanModeResponse } from '@shared/types';
import { DeckSelect } from '@renderer/components/DeckSelect';
import log from '@renderer/utils/logger';
import { PlanDeepReviewDialog } from './PlanDeepReviewDialog';
import { PlanMarkdownPanel } from './plan-markdown-panel';

const logger = log.scope('renderer-exit-plan-row');
type TargetMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

const TARGET_MODE_OPTIONS: { value: TargetMode; label: string; title?: string }[] = [
  { value: 'default', label: '每次询问', title: '每次工具调用前都询问' },
  { value: 'acceptEdits', label: '自动接受编辑', title: '自动允许文件编辑；其他工具仍需询问' },
  { value: 'plan', label: '继续计划模式', title: '保持计划模式，不执行任何工具' },
  { value: 'bypassPermissions', label: '⚠️ 不再询问', title: '不再询问任何工具调用；需要重启会话' },
];

/**
 * ExitPlanMode / MCP plan presentation row. Native Claude ExitPlanMode keeps the
 * permission-mode selector; MCP plan presentation is confirmation/feedback only.
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
  const [targetMode, setTargetMode] = useState<TargetMode>('acceptEdits');
  const [deepReviewOpen, setDeepReviewOpen] = useState(false);

  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const plan = payload.plan || '(计划内容为空)';
  const isMcpPlanReview = payload.reviewSource === 'mcp';
  const actorName = isMcpPlanReview ? '模型' : 'Claude';
  const keepPlanningLabel = '继续规划';

  const targetModeLabel: Record<typeof targetMode, string> = {
    default: '每次询问',
    acceptEdits: '自动接受编辑',
    plan: '继续计划模式',
    bypassPermissions: '⚠️ 不再询问',
  };

  const respond = async (response: ExitPlanModeResponse): Promise<boolean> => {
    if (!isSdk || !stillPending || busy) return false;
    setBusy(true);
    try {
      const result = await window.api.respondExitPlanMode(
        agentId,
        sessionId,
        payload.requestId,
        response,
      );
      onResolved(result.resolvedSessionId, payload.requestId);
      return true;
    } catch (err) {
      logger.error('respondExitPlanMode failed', err);
      return false;
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

  const onFeedbackKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
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
              ? '📋 待展示计划'
              : '📋 收到一个执行计划'
            : wasCancelled
              ? '🚫 计划展示已被取消'
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
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
            {!isMcpPlanReview && (
              <DeckSelect
                value={targetMode}
                disabled={busy}
                onChange={setTargetMode}
                title="批准计划后切换到的权限模式(完全免询问需要重启会话)"
                options={TARGET_MODE_OPTIONS}
                className="w-[104px]"
                buttonClassName="w-full rounded border border-deck-border bg-white/[0.06] px-1.5 py-0.5 text-left text-[10px] text-deck-text outline-none focus:border-white/20 disabled:opacity-50"
                menuMinWidth={160}
              />
            )}
            {isMcpPlanReview && (
              <button
                type="button"
                disabled={busy}
                onClick={() => setDeepReviewOpen(true)}
                title="放大计划，选中文字后右键引用，并在隔离的原生 fork 中提问"
                className="rounded border border-status-waiting/50 bg-status-waiting/10 px-2.5 py-0.5 text-[10px] text-status-waiting hover:bg-status-waiting/20 disabled:opacity-50"
              >
                深度审阅
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void onClickApprove()}
              title={
                isMcpPlanReview
                  ? '确认计划并把结果返回给模型'
                  : targetMode === 'bypassPermissions'
                    ? '批准计划并切到完全免询问模式(需重启会话,5-10 秒)'
                    : `批准计划并切到「${targetModeLabel[targetMode]}」`
              }
              className="rounded bg-status-working px-2.5 py-0.5 text-[10px] font-semibold text-black shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isMcpPlanReview ? '确认计划' : `批准并切到 ${targetModeLabel[targetMode]}`}
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
              {keepPlanningLabel}
            </button>
          </div>
        )}
      </div>

      {stillPending && isSdk && showFeedback && (
        <input
          type="text"
          autoFocus
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          onKeyDown={onFeedbackKeyDown}
          placeholder={`反馈可选；按 Enter 或再次点击“${keepPlanningLabel}”继续`}
          disabled={busy}
          className="mb-1.5 h-7 w-full rounded border border-deck-border bg-white/[0.04] px-2 text-[10px] text-deck-text outline-none placeholder:text-deck-muted/70 focus:border-white/20 disabled:opacity-50"
        />
      )}

      <PlanMarkdownPanel plan={plan} />

      {!isSdk && (
        <div className="mt-1.5 text-[10px] text-deck-muted">
          这是终端启动的只读会话，请回到原终端窗口批准
        </div>
      )}
      {!stillPending && isSdk && wasCancelled && (
        <div className="mt-1.5 text-[10px] text-deck-muted/70">
          这次计划展示请求已取消
        </div>
      )}

      {isMcpPlanReview && deepReviewOpen && stillPending && (
        <PlanDeepReviewDialog
          open
          sourceSessionId={sessionId}
          request={payload}
          decisionBusy={busy}
          onClose={() => setDeepReviewOpen(false)}
          onApprove={() => respond({ decision: 'approve', targetMode: 'default' })}
          onRevise={(nextFeedback) =>
            respond({ decision: 'keep-planning', feedback: nextFeedback })}
        />
      )}
    </li>
  );
}
