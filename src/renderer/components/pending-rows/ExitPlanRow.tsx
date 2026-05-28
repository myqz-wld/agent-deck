import { useState, type JSX } from 'react';
import type { AgentEvent, ExitPlanModeRequest, ExitPlanModeResponse } from '@shared/types';
import { MarkdownText } from '../MarkdownText';

/**
 * ExitPlanMode 行（markdown plan + 二选一按钮）。接口同 PermissionRow 模式。
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
  // 「继续规划」时可选反馈输入框，默认折叠；点了「继续规划」按钮且 feedback 为空时，
  // 展开输入框让用户可以补充意见再确认；如果用户已写过反馈直接发送，跳过 confirm 步骤。
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState('');
  // 批准时切到的目标权限模式（plan 通过 ▾ 下拉选）。
  // - 热档（default/acceptEdits/plan）：respondExitPlanMode 内部走 query.setPermissionMode 热切
  // - bypass：必须冷切（重启 SDK 子进程），点击前弹 confirmDialog 二次确认。
  // 默认 acceptEdits：plan 批准后接着自动接受编辑是高频用例。
  const [targetMode, setTargetMode] = useState<
    'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
  >('acceptEdits');
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const plan = payload.plan ?? '';

  const respond = async (response: ExitPlanModeResponse): Promise<void> => {
    if (!isSdk || !stillPending || busy) return;
    setBusy(true);
    try {
      await window.api.respondExitPlanMode(agentId, sessionId, payload.requestId, response);
      onResolved(sessionId, payload.requestId);
    } catch (err) {
      // 冷切失败时 sdk-bridge 内部已 emit error message + 回滚 DB；这里 row 保持 pending 让用户看到失败
      console.error('respondExitPlanMode failed', err);
    } finally {
      setBusy(false);
    }
  };

  const onClickApprove = async (): Promise<void> => {
    if (targetMode === 'bypassPermissions') {
      // bypass 冷切：会重启 SDK 子进程（5-10s busy）+ 后续完全免询问，强制弹 confirm
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

  // 「继续规划」按钮：第一次点击展开反馈框（如果还没展开），第二次/已有反馈直接提交。
  // 实战体验：避免每次都强制弹输入框（用户大概率没意见也想直接驳回），
  // 但提供一个「写明白哪儿不满意」的入口，比一句空 deny 让 Claude 瞎猜要好。
  const onClickKeepPlanning = (): void => {
    if (!showFeedback) {
      setShowFeedback(true);
      return;
    }
    void respond({ decision: 'keep-planning', feedback: feedback.trim() || undefined });
  };

  // 按钮文案：根据 targetMode 显示「批准并切到 X」，bypass 加 ⚠️ 标识
  const targetModeLabel: Record<typeof targetMode, string> = {
    default: '每次询问',
    acceptEdits: '自动接受编辑',
    plan: '继续计划模式',
    bypassPermissions: '⚠️ 不再询问',
  };

  return (
    <li
      className={`rounded-md border p-2 text-[11px] ${
        stillPending
          ? 'border-status-working/40 bg-status-working/10'
          : wasCancelled
            ? 'border-deck-border/40 bg-white/[0.015] opacity-50'
            : 'border-deck-border/60 bg-white/[0.02] opacity-70'
      }`}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
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
            ? '📋 收到一个执行计划'
            : wasCancelled
              ? '🚫 计划批准已被取消'
              : '✅ 已处理'}
        </span>
        <span className="font-mono tabular-nums text-deck-muted/60">{ts}</span>
        {stillPending && isSdk && (
          <div className="ml-auto flex flex-wrap items-center gap-1">
            {/* targetMode 选档：approve 时切到此档；bypass 走冷切（重启 SDK 子进程） */}
            <select
              value={targetMode}
              disabled={busy}
              onChange={(e) =>
                setTargetMode(e.target.value as typeof targetMode)
              }
              title="批准计划后切换到的权限模式(完全免询问需要重启会话)"
              className="rounded border border-deck-border bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-deck-text outline-none focus:border-white/20 disabled:opacity-50"
            >
              <option value="default" title="每次工具调用前都询问">每次询问</option>
              <option value="acceptEdits" title="自动允许文件编辑；其他工具仍需询问">自动接受编辑</option>
              <option value="plan" title="保持计划模式，不执行任何工具">继续计划模式</option>
              <option value="bypassPermissions" title="不再询问任何工具调用；需要重启会话">⚠️ 不再询问</option>
            </select>
            <button
              type="button"
              disabled={busy}
              onClick={() => void onClickApprove()}
              title={
                targetMode === 'bypassPermissions'
                  ? '批准计划并切到完全免询问模式(需重启会话,5-10 秒)'
                  : `批准计划并切到「${targetModeLabel[targetMode]}」`
              }
              className="rounded bg-status-working px-2.5 py-0.5 text-[10px] font-semibold text-black shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              批准并切到 {targetModeLabel[targetMode]}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onClickKeepPlanning}
              title={
                showFeedback
                  ? feedback.trim()
                    ? '把反馈发给 Claude，让它修改计划'
                    : '不写反馈也可以，Claude 会主动询问需要补充哪方面'
                  : '让 Claude 留在 plan mode 继续修改计划（点击后可写反馈）'
              }
              className="rounded border border-deck-border bg-white/[0.06] px-2.5 py-0.5 text-[10px] text-deck-text hover:bg-white/[0.12] disabled:opacity-50"
            >
              继续规划
            </button>
          </div>
        )}
      </div>
      <div className="rounded border border-deck-border/40 bg-black/20 p-2">
        <MarkdownText text={plan || '(计划内容为空)'} />
      </div>
      {stillPending && isSdk && showFeedback && (
        <div className="mt-2 flex flex-col gap-1">
          <label className="text-[10px] text-deck-muted">
            可选:告诉 Claude 哪里需要调整(留空也能提交)
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
              onClick={() => void respond({ decision: 'keep-planning', feedback: feedback.trim() || undefined })}
              className="rounded bg-deck-text/80 px-2.5 py-0.5 text-[10px] font-semibold text-deck-bg-strong hover:brightness-110 disabled:opacity-40"
            >
              发送反馈,继续规划
            </button>
          </div>
        </div>
      )}
      {!isSdk && (
        <div className="mt-1.5 text-[10px] text-deck-muted">这是终端启动的只读会话，请回到原终端窗口批准</div>
      )}
      {!stillPending && isSdk && wasCancelled && (
        <div className="mt-1.5 text-[10px] text-deck-muted/70">
          这次计划批准请求已取消
        </div>
      )}
    </li>
  );
}
