import { useMemo, useState, type JSX } from 'react';

import {
  ChevronDownIcon,
  ChevronRightIcon,
} from '@renderer/components/icons';
import type { AgentEvent } from '@shared/types';
import { describeToolInput } from '../describe';
import {
  formatDisplayText,
  formatToolResult,
} from '../format';
import {
  formatToolDuration,
  providerTruncationLabel,
  toolStatusView,
} from '../tool-status';
import { toolIcon } from '../tool-icons';

export function ToolEndRow({
  event,
  startEvent,
}: {
  event: AgentEvent;
  startEvent?: AgentEvent;
}): JSX.Element {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const startPayload = (startEvent?.payload ?? {}) as Record<string, unknown>;
  const tool =
    formatDisplayText(payload.toolName)
    || formatDisplayText(startPayload.toolName)
    || '工具';
  const result =
    payload.toolResult
    ?? payload.toolResponse
    ?? payload.error
    ?? payload.reason;
  const [open, setOpen] = useState(false);
  const timestamp = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const status = toolStatusView(payload);
  const duration = formatToolDuration(payload.durationMs);
  const truncation = providerTruncationLabel(payload);
  const text = useMemo(() => formatToolResult(result), [result]);
  const hasContent = text.trim().length > 0;
  const inputForDisplay = mergeToolInputs(startPayload.toolInput, payload.toolInput);
  const detail = useMemo(
    () => describeToolInput(tool, inputForDisplay),
    [inputForDisplay, tool],
  );
  const containerClass = status.isError
    ? 'min-w-0 rounded-md border border-status-error/40 bg-status-error/[0.05] p-2 text-[11px]'
    : 'min-w-0 rounded-md border border-deck-border/40 bg-white/[0.015] p-2 text-[11px]';

  return (
    <li className={containerClass}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-1.5 text-left"
      >
        <span>
          {open
            ? <ChevronDownIcon className="h-3 w-3" />
            : <ChevronRightIcon className="h-3 w-3" />}
        </span>
        <span className="min-w-0 truncate">
          {`${toolIcon(tool, payload.toolKind ?? startPayload.toolKind)} ${tool}`}{' '}
          {status.isError ? (
            <span className="text-status-error/90">{status.label}</span>
          ) : status.label}
          {detail && (
            <span className="ml-1.5 truncate text-[10px] text-deck-muted/85">
              · {detail}
            </span>
          )}
          {status.isError && typeof payload.exitCode === 'number' && (
            <span className="ml-1.5 rounded bg-status-error/20 px-1 py-0.5 font-mono text-[9px] text-status-error/90">
              退出码 {String(payload.exitCode)}
            </span>
          )}
          {duration && <span className="ml-1.5 text-[9px] text-deck-muted/70">{duration}</span>}
          {truncation && <span className="ml-1.5 text-[9px] text-amber-300/90">{truncation}</span>}
        </span>
        <span className="ml-auto font-mono text-[9px] tabular-nums text-deck-muted/60">
          {timestamp}
        </span>
      </button>
      {open && (
        hasContent ? (
          <pre className="mt-1 max-h-64 overflow-auto rounded bg-black/30 p-1.5 text-[10px] leading-snug text-deck-muted scrollbar-deck">
            {text}
          </pre>
        ) : (
          <div className="mt-1 px-1.5 py-1 text-[10px] italic text-deck-muted/70">
            （无输出
            {status.detail && ` · 状态：${status.detail}`}
            {typeof payload.exitCode === 'number' && ` · 退出码: ${payload.exitCode}`}
            ）
          </div>
        )
      )}
    </li>
  );
}

function mergeToolInputs(startInput: unknown, endInput: unknown): unknown {
  const start = objectRecord(startInput);
  const end = objectRecord(endInput);
  if (!start || !end) return endInput ?? startInput;
  const merged: Record<string, unknown> = { ...start };
  for (const [key, value] of Object.entries(end)) {
    if (value !== null && value !== undefined) merged[key] = value;
    else if (!(key in merged)) merged[key] = value;
  }
  return merged;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
