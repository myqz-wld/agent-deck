import { useState, type JSX } from 'react';
import type { AgentEvent, TeamPermissionRequest } from '@shared/types';
import { DiffViewer } from '../diff/DiffViewer';
import { toolInputToDiff } from './tool-input-diff';

/**
 * Team Permission 行（CHANGELOG_45：teammate inbox 权限请求）。
 *
 * Inbox watcher 识别出的 teammate permission_request 渲染。与 PermissionRow 形态接近，
 * 但走完全不同的响应通路（写 JSON 文本到 teammate inbox 文件，不走 SDK canUseTool）。
 *
 * 顶部多一条 chip 显示 fromAgentId（哪个 teammate 提的）+ teamName。
 *
 * 不支持「始终允许」（permission_suggestions 由 CLI 内部决定 inbox 协议是否带；
 * 当前应用层不解析 / 不转发，未来如有需要再加）。
 */
export function TeamPermissionRow({
  event,
  payload,
  sessionId,
  stillPending,
  wasCancelled,
  onResolved,
  onJump,
}: {
  event: AgentEvent;
  payload: TeamPermissionRequest;
  sessionId: string;
  stillPending: boolean;
  /** Inbox watcher 检测到 teammate 写 idle_notification 时为 true。activity-feed 端用，
   *  PendingTab 永远传 false（已 cancelled 的 store 早已从 pending 列表移除，根本不会
   *  到这里）。与 PermissionRow / AskRow / ExitPlanRow 同款 prop 模式。 */
  wasCancelled?: boolean;
  onResolved: (sessionId: string, requestId: string) => void;
  /** PendingTab 待处理页面下传入：点击 row 跳转到对应 lead session detail（参考 PendingTab
   *  session header onClick={() => onOpenSession(session.id)} 同款语义）。activity-feed
   *  端不传（自身已在 lead session detail 里）。 */
  onJump?: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const diff = toolInputToDiff(payload.toolName, payload.toolInput);

  const respond = async (decision: 'allow' | 'deny'): Promise<void> => {
    if (!stillPending) return;
    setBusy(true);
    try {
      await window.api.respondTeamPermission(
        payload.teamName,
        payload.fromMemberSlug,
        payload.requestId,
        decision,
        decision === 'allow' ? payload.toolInput : undefined,
      );
      onResolved(sessionId, payload.requestId);
    } finally {
      setBusy(false);
    }
  };

  const cardClass = stillPending
    ? 'border-status-waiting/40 bg-status-waiting/10'
    : wasCancelled
      ? 'border-deck-border/60 bg-white/[0.02] opacity-60'
      : 'border-deck-border/60 bg-white/[0.02] opacity-70';
  const statusText = stillPending
    ? '⚠ Teammate 等待审批'
    : wasCancelled
      ? '⊘ 已被 teammate 取消（idle）'
      : '✅ 已响应';
  const statusColor = stillPending
    ? 'text-status-waiting'
    : wasCancelled
      ? 'text-deck-muted/70'
      : 'text-status-working/80';

  return (
    <li
      className={`rounded-md border p-2 text-[11px] ${cardClass} ${onJump ? 'cursor-pointer hover:bg-white/[0.04]' : ''}`}
      onClick={onJump ? () => onJump() : undefined}
      title={onJump ? '点击打开此会话详情' : undefined}
    >
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[10px]">
        <span className={statusColor}>{statusText}</span>
        <span className="rounded bg-white/10 px-1 font-mono text-deck-text">
          {payload.fromAgentId}
        </span>
        <span className="text-deck-muted/80">@ {payload.teamName}</span>
        <span className="font-mono">{payload.toolName}</span>
        <span className="font-mono tabular-nums text-deck-muted/60">{ts}</span>
        {stillPending && (
          <div className="ml-auto flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              disabled={busy}
              onClick={() => void respond('allow')}
              className="rounded bg-status-working/30 px-2 py-0.5 text-[10px] text-status-working hover:bg-status-working/40 disabled:opacity-50"
            >
              允许
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void respond('deny')}
              className="rounded bg-status-waiting/30 px-2 py-0.5 text-[10px] text-status-waiting hover:bg-status-waiting/40 disabled:opacity-50"
            >
              拒绝
            </button>
          </div>
        )}
      </div>
      {payload.description && (
        <div className="mb-1 text-[10px] text-deck-muted">{payload.description}</div>
      )}
      {diff ? (
        <div className="h-72 overflow-hidden rounded border border-white/5">
          <DiffViewer payload={diff} sessionId={sessionId} />
        </div>
      ) : (
        <pre className="max-h-24 overflow-auto scrollbar-deck rounded bg-black/30 p-1.5 text-[10px] leading-snug text-deck-muted">
          {JSON.stringify(payload.toolInput, null, 2)}
        </pre>
      )}
    </li>
  );
}
