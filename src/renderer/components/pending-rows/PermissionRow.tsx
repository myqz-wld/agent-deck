import { useMemo, type JSX } from 'react';
import type { AgentEvent, PermissionRequest } from '@shared/types';
import type { StructuredContentValue } from '../expandable-content';
import { DiffViewer } from '../diff/DiffViewer';
import log from '@renderer/utils/logger';
import { toolInputToDiff } from './tool-input-diff';
import {
  RowResponseError,
  useRowResponseState,
} from './review-detail/row-response-state';

const logger = log.scope('renderer-permission-row');
const MAX_STRUCTURED_DEPTH = 6;
const MAX_STRUCTURED_ENTRIES = 80;
const MAX_STRUCTURED_NODES = 600;
const MAX_STRUCTURED_STRING = 4_000;

interface NormalizeBudget {
  remainingNodes: number;
  ancestors: WeakSet<object>;
}

function truncateStructuredText(value: string): string {
  if (value.length <= MAX_STRUCTURED_STRING) return value;
  return `${value.slice(0, MAX_STRUCTURED_STRING)}…[已截断 ${value.length - MAX_STRUCTURED_STRING} 字]`;
}

function objectKind(value: object): string {
  try {
    return Object.prototype.toString.call(value).slice(8, -1) || '对象';
  } catch {
    return '对象';
  }
}

function normalizeStructuredValue(
  value: unknown,
  depth: number,
  budget: NormalizeBudget,
): StructuredContentValue {
  if (budget.remainingNodes <= 0) {
    return `[已截断：内容超过 ${MAX_STRUCTURED_NODES} 个节点]`;
  }
  budget.remainingNodes -= 1;
  if (value === null) return null;
  if (typeof value === 'string') return truncateStructuredText(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : `[非 JSON 数值：${String(value)}]`;
  }
  if (typeof value === 'bigint') {
    return `[非 JSON 值：BigInt（${truncateStructuredText(value.toString())}）]`;
  }
  if (value === undefined) return '[非 JSON 值：undefined]';
  if (typeof value === 'symbol') return '[非 JSON 值：Symbol]';
  if (typeof value === 'function') return '[非 JSON 值：function]';
  if (depth >= MAX_STRUCTURED_DEPTH) {
    return `[已截断：嵌套层级超过 ${MAX_STRUCTURED_DEPTH}]`;
  }

  const objectValue = value as object;
  if (budget.ancestors.has(objectValue)) return '[无法展开：循环引用]';
  budget.ancestors.add(objectValue);
  try {
    let isArray = false;
    try {
      isArray = Array.isArray(objectValue);
    } catch {
      return '[无法展开：对象类型读取失败]';
    }
    if (isArray) {
      let length = 0;
      try {
        length = (objectValue as unknown[]).length;
      } catch {
        return '[无法展开：数组长度读取失败]';
      }
      const visibleLength = Math.min(length, MAX_STRUCTURED_ENTRIES);
      const normalized: StructuredContentValue[] = [];
      for (let index = 0; index < visibleLength; index += 1) {
        try {
          normalized.push(normalizeStructuredValue(
            (objectValue as unknown[])[index],
            depth + 1,
            budget,
          ));
        } catch {
          normalized.push('[无法展开：数组项读取失败]');
        }
      }
      if (length > visibleLength) {
        normalized.push(`[已截断：另有 ${length - visibleLength} 项]`);
      }
      return normalized;
    }

    let keys: string[];
    try {
      keys = Object.keys(objectValue);
    } catch {
      return '[无法展开：对象字段读取失败]';
    }
    if (keys.length === 0) {
      try {
        const prototype = Object.getPrototypeOf(objectValue);
        if (prototype !== Object.prototype && prototype !== null) {
          return `[非 JSON 对象：${objectKind(objectValue)}]`;
        }
      } catch {
        return '[无法展开：对象原型读取失败]';
      }
    }
    const normalized = Object.create(null) as Record<string, StructuredContentValue>;
    const visibleKeys = keys.slice(0, MAX_STRUCTURED_ENTRIES);
    visibleKeys.forEach((key, index) => {
      const displayKey = key.length <= 160 ? key : `${key.slice(0, 160)}…#${index + 1}`;
      try {
        normalized[displayKey] = normalizeStructuredValue(
          (objectValue as Record<string, unknown>)[key],
          depth + 1,
          budget,
        );
      } catch {
        normalized[displayKey] = '[无法展开：字段读取失败]';
      }
    });
    if (keys.length > visibleKeys.length) {
      normalized['…'] = `[已截断：另有 ${keys.length - visibleKeys.length} 个字段]`;
    }
    return normalized;
  } finally {
    budget.ancestors.delete(objectValue);
  }
}

function normalizeToolInput(value: unknown): StructuredContentValue {
  try {
    return normalizeStructuredValue(value, 0, {
      remainingNodes: MAX_STRUCTURED_NODES,
      ancestors: new WeakSet(),
    });
  } catch {
    return '[无法显示：工具输入归一化失败]';
  }
}

function formatStructuredInput(value: StructuredContentValue): string {
  try {
    return JSON.stringify(value, null, 2) ?? '"[无法显示：工具输入为空]"';
  } catch {
    return '"[无法显示：结构化工具输入序列化失败]"';
  }
}

export function PermissionRow({
  event,
  payload,
  sessionId,
  agentId,
  isSdk,
  stillPending,
  wasCancelled,
  onResolved,
  externalError,
  respondOverride,
  responseDisabled = false,
  approvalDisabledReason = null,
}: {
  event: AgentEvent;
  payload: PermissionRequest;
  sessionId: string;
  agentId: string;
  isSdk: boolean;
  stillPending: boolean;
  wasCancelled: boolean;
  onResolved: (sessionId: string, requestId: string) => void;
  externalError?: string | null;
  respondOverride?: (decision: 'allow' | 'deny') => Promise<void>;
  responseDisabled?: boolean;
  approvalDisabledReason?: string | null;
}): JSX.Element {
  const { busy: rowBusy, error, run } = useRowResponseState(payload.requestId);
  const busy = rowBusy || responseDisabled;
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const normalizedInput = useMemo(
    () => normalizeToolInput(payload.toolInput),
    [payload.toolInput],
  );
  const diff = useMemo(
    () => toolInputToDiff(payload.toolName, normalizedInput),
    [normalizedInput, payload.toolName],
  );
  const respond = async (decision: 'allow' | 'deny', alwaysAllow = false): Promise<void> => {
    if (
      !isSdk || !stillPending || busy ||
      (decision === 'allow' && approvalDisabledReason !== null)
    ) return;
    const result = await run(
      async () => {
        if (respondOverride) {
          await respondOverride(decision);
          return;
        }
        await window.api.respondPermission(agentId, sessionId, payload.requestId, {
          decision,
          message: decision === 'deny' ? '用户拒绝' : undefined,
          updatedInput: decision === 'allow' ? payload.toolInput : undefined,
          updatedPermissions: alwaysAllow ? payload.suggestions : undefined,
        });
      },
      '授权响应失败，请确认请求仍在等待后重试。',
    );
    if (result.ok) {
      onResolved(sessionId, payload.requestId);
    } else if (result.error) {
      logger.error('permission response failed', {
        action: 'respondPermission',
        agentId,
        sessionId,
        requestId: payload.requestId,
        error: result.error,
      });
    }
  };

  const settled = !stillPending;
  const cardClass = stillPending
    ? 'border-status-waiting/40 bg-status-waiting/10'
    : wasCancelled
      ? 'border-deck-border/40 bg-white/[0.015] opacity-50'
      : 'border-deck-border/60 bg-white/[0.02] opacity-70';
  const statusText = stillPending
    ? '⚠️ 等待授权'
    : wasCancelled
      ? '🚫 已取消'
      : '✅ 已响应';
  const statusColor = stillPending
    ? 'text-status-waiting'
    : wasCancelled
      ? 'text-deck-muted/70'
      : 'text-status-working/80';

  return (
    <li className={`min-w-0 rounded-md border p-2 text-[11px] ${cardClass}`}>
      <div className="mb-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px]">
        <span className={statusColor}>{statusText}</span>
        <span className="min-w-0 truncate font-mono">{payload.toolName}</span>
        <span className="font-mono tabular-nums text-deck-muted/60">{ts}</span>
        {stillPending && isSdk && (
          <div className="ml-auto flex flex-wrap gap-1">
            <button
              type="button"
              disabled={busy || approvalDisabledReason !== null}
              onClick={() => void respond('allow')}
              className="rounded bg-status-working/30 px-2 py-0.5 text-[10px] text-status-working hover:bg-status-working/40 disabled:opacity-50"
            >
              允许本次
            </button>
            {payload.suggestions ? (
              <button
                type="button"
                disabled={busy || approvalDisabledReason !== null}
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
        <pre className="max-h-24 max-w-full overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-1.5 text-[10px] leading-snug text-deck-muted scrollbar-deck">
          {formatStructuredInput(normalizedInput)}
        </pre>
      )}
      {approvalDisabledReason ? (
        <div className="mt-1 rounded border border-status-waiting/30 bg-status-waiting/10 px-1.5 py-1 text-[10px] text-status-waiting">
          {approvalDisabledReason}
        </div>
      ) : null}
      <RowResponseError>{externalError ?? error}</RowResponseError>
      {!isSdk && (
        <div className="mt-1 text-[10px] text-deck-muted">这是终端启动的只读会话，请回到原终端窗口授权</div>
      )}
      {settled && isSdk && wasCancelled && (
        <div className="mt-1 text-[10px] text-deck-muted/70">
          这次请求已取消
        </div>
      )}
    </li>
  );
}
