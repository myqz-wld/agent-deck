import { useMemo, useState, type JSX } from 'react';

import { ImageThumb } from '@renderer/components/ImageThumb';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ImageIcon,
} from '@renderer/components/icons';
import type { AgentEvent } from '@shared/types';
import { describeToolInput } from '../describe';
import {
  formatDisplayText,
  formatToolResult,
  parseImageReadResult,
} from '../format';
import {
  formatToolDuration,
  providerTruncationLabel,
  toolStatusView,
} from '../tool-status';
import { toolIcon } from '../tool-icons';

export function ToolEndRow({
  event,
  sessionId,
  startEvent,
  allowLocalAssets = true,
}: {
  event: AgentEvent;
  sessionId: string;
  startEvent?: AgentEvent;
  allowLocalAssets?: boolean;
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
  const imageRead = useMemo(() => parseImageReadResult(result), [result]);
  const hasContent = text.trim().length > 0;
  const inputForDisplay = mergeToolInputs(startPayload.toolInput, payload.toolInput);
  const detail = useMemo(
    () => imageRead ? null : describeToolInput(tool, inputForDisplay),
    [imageRead, inputForDisplay, tool],
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
          {imageRead
            ? <><ImageIcon className="mr-1 inline h-3 w-3" />ImageRead</>
            : `${toolIcon(tool, payload.toolKind ?? startPayload.toolKind)} ${tool}`}{' '}
          {status.isError ? (
            <span className="text-status-error/90">{status.label}</span>
          ) : status.label}
          {imageRead?.provider && (
            <span className="ml-1.5 text-[9px] text-deck-muted/70">
              [{imageRead.provider}{imageRead.model ? ` · ${imageRead.model}` : ''}]
            </span>
          )}
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
      {imageRead && (
        <div className="mt-2 flex gap-2">
          {allowLocalAssets ? (
            <ImageThumb
              sessionId={sessionId}
              source={{ kind: 'path', path: imageRead.file }}
              size="md"
            />
          ) : (
            <div className="rounded border border-deck-border/50 px-2 py-1 text-[9px] text-deck-muted">
              远程图片需通过资产通道读取
            </div>
          )}
          <div className="flex-1 overflow-hidden">
            <div className="text-[9px] uppercase tracking-wider text-deck-muted">描述</div>
            <div className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-deck-text/90 scrollbar-deck">
              {imageRead.description}
            </div>
          </div>
        </div>
      )}
      {open && !imageRead && (
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
