import { useState, type JSX } from 'react';
import type { AgentEvent, PermissionRequest } from '@shared/types';
import { DiffViewer } from '../diff/DiffViewer';
import { toolInputToDiff } from './tool-input-diff';

/**
 * 权限请求行（内嵌按钮 + diff）。
 *
 * 接口：(event, payload, sessionId, agentId, isSdk, stillPending, wasCancelled, onResolved)
 * - event 仅用于显示时间戳（event.ts）
 * - stillPending=true 时仍可响应；false 时按钮区域降级为「已响应 / 已取消」
 * - wasCancelled=true 区分「SDK 主动取消」与「用户已响应」
 * - onResolved 由调用方提供（store.resolveX(sessionId, requestId) 同款），Row 内部
 *   调 window.api.respondPermission 完成响应后调用
 */
export function PermissionRow({
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
  payload: PermissionRequest;
  sessionId: string;
  agentId: string;
  isSdk: boolean;
  stillPending: boolean;
  wasCancelled: boolean;
  onResolved: (sessionId: string, requestId: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const diff = toolInputToDiff(payload.toolName, payload.toolInput);

  const respond = async (decision: 'allow' | 'deny', alwaysAllow = false): Promise<void> => {
    if (!isSdk || !stillPending) return;
    setBusy(true);
    try {
      await window.api.respondPermission(agentId, sessionId, payload.requestId, {
        decision,
        message: decision === 'deny' ? '用户拒绝' : undefined,
        updatedInput: decision === 'allow' ? payload.toolInput : undefined,
        updatedPermissions: alwaysAllow ? payload.suggestions : undefined,
      });
      onResolved(sessionId, payload.requestId);
    } finally {
      setBusy(false);
    }
  };

  // 三态：等待中 / 已被 SDK 取消 / 已响应（用户主动 allow|deny）
  // 「已取消」整张更暗（opacity-50），左侧细色条提示这条是 SDK 放弃的，不是用户操作；
  // 「已响应」保持原样的 70% 透明 + 中性灰描边（用户已经处理过的痕迹，不强调）
  const settled = !stillPending;
  const cardClass = stillPending
    ? 'border-status-waiting/40 bg-status-waiting/10'
    : wasCancelled
      ? 'border-deck-border/40 bg-white/[0.015] opacity-50'
      : 'border-deck-border/60 bg-white/[0.02] opacity-70';
  const statusText = stillPending
    ? '⚠ 等待授权'
    : wasCancelled
      ? '🚫 已被 SDK 取消'
      : '✅ 已响应';
  const statusColor = stillPending
    ? 'text-status-waiting'
    : wasCancelled
      ? 'text-deck-muted/70'
      : 'text-status-working/80';

  return (
    <li className={`rounded-md border p-2 text-[11px] ${cardClass}`}>
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[10px]">
        <span className={statusColor}>{statusText}</span>
        <span className="font-mono">{payload.toolName}</span>
        <span className="font-mono tabular-nums text-deck-muted/60">{ts}</span>
        {stillPending && isSdk && (
          <div className="ml-auto flex flex-wrap gap-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => void respond('allow')}
              className="rounded bg-status-working/30 px-2 py-0.5 text-[10px] text-status-working hover:bg-status-working/40 disabled:opacity-50"
            >
              允许本次
            </button>
            {payload.suggestions ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void respond('allow', true)}
                className="rounded bg-status-working/15 px-2 py-0.5 text-[10px] text-status-working hover:bg-status-working/25 disabled:opacity-50"
              >
                始终允许
              </button>
            ) : null}
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
      {diff ? (
        <div className="h-72 overflow-hidden rounded border border-white/5">
          <DiffViewer payload={diff} sessionId={sessionId} />
        </div>
      ) : (
        <pre className="max-h-24 overflow-auto scrollbar-deck rounded bg-black/30 p-1.5 text-[10px] leading-snug text-deck-muted">
          {JSON.stringify(payload.toolInput, null, 2)}
        </pre>
      )}
      {!isSdk && (
        <div className="mt-1 text-[10px] text-deck-muted">外部 CLI 会话无法在此回应</div>
      )}
      {settled && isSdk && wasCancelled && (
        <div className="mt-1 text-[10px] text-deck-muted/70">
          Claude 主动放弃了这次请求（流终止 / interrupt / 超时）
        </div>
      )}
    </li>
  );
}
