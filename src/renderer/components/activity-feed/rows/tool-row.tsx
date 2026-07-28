import { useCallback, useMemo, useRef, type JSX } from 'react';
import type { AgentEvent } from '@shared/types';
import { ImageThumb } from '@renderer/components/ImageThumb';
import { toolInputToDiff } from '@renderer/components/pending-rows';
import { describeToolInput } from '../describe';
import {
  formatDisplayText,
  formatToolResult,
  parseImageReadResult,
} from '../format';
import { toolIcon } from '../tool-icons';
import {
  formatToolDuration,
  providerTruncationLabel,
  toolStatusView,
} from '../tool-status';
import { ImageIcon } from '../../icons';
import { ToolContentViewer } from '../viewers/ToolContentViewer';
import { AgentToolSummary } from '../viewers/ToolSummary';
import { activityEventIdentity } from '../viewers/activity-event-identity';

export function ToolStartRow({
  event,
  sessionId,
}: {
  event: AgentEvent;
  sessionId: string;
}): JSX.Element {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const tool = formatDisplayText(payload.toolName) || '工具';
  const detail = describeToolInput(tool, payload.toolInput);
  const diff = useMemo(
    () => toolInputToDiff(tool, payload.toolInput),
    [payload.toolInput, tool],
  );
  const timestamp = formatTimestamp(event.ts);
  const isPlan = tool === 'ExitPlanMode';
  const isAgent = tool === 'Task' || tool === 'Agent';
  const plan = isPlan && typeof (payload.toolInput as { plan?: unknown })?.plan === 'string'
    ? (payload.toolInput as { plan: string }).plan
    : '';

  return (
    <li className={`relative min-w-0 rounded-md border p-2 pr-12 text-[11px] ${
      isPlan || isAgent
        ? 'border-status-working/30 bg-status-working/[0.05]'
        : 'border-deck-border/60 bg-white/[0.02]'
    }`}>
      <ToolContentViewer
        sessionId={sessionId}
        eventId={eventId(event)}
        revision={event.ts}
        toolName={tool}
        toolInput={payload.toolInput}
        resultStatus="pending"
        statusLabel="准备执行"
        diff={diff}
      />
      <div className="flex min-h-11 min-w-0 items-center gap-1.5">
        <span>{toolIcon(tool, payload.toolKind)}</span>
        <span className="min-w-0 truncate font-mono">{tool}</span>
        {detail && !isAgent && (
          <span className="truncate text-[10px] text-deck-muted">· {detail}</span>
        )}
        <span className="ml-auto shrink-0 font-mono tabular-nums text-[9px] text-deck-muted/60">
          {timestamp}
        </span>
      </div>
      {isPlan && (
        <>
          <div className="mt-1 max-h-20 overflow-hidden whitespace-pre-wrap rounded border border-deck-border/40 bg-black/20 p-2 text-[10px]">
            {plan || '（计划内容为空）'}
          </div>
          <div className="mt-1.5 text-[10px] text-deck-muted">
            这是终端启动的只读会话，请回到原终端窗口批准
          </div>
        </>
      )}
      {isAgent && <AgentToolSummary input={payload.toolInput} />}
      {diff && (
        <div className="mt-1 text-[10px] text-deck-muted">
          {diff.kind === 'image' ? '图片内容可展开查看' : '改动内容可展开查看'}
        </div>
      )}
    </li>
  );
}

export function ToolEndRow({
  event,
  sessionId,
  startEvent,
}: {
  event: AgentEvent;
  sessionId: string;
  startEvent?: AgentEvent;
}): JSX.Element {
  const imageViewerRootRef = useRef<HTMLDivElement>(null);
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const startPayload = (startEvent?.payload ?? {}) as Record<string, unknown>;
  const tool =
    formatDisplayText(payload.toolName)
    || formatDisplayText(startPayload.toolName)
    || '工具';
  const rawResult = payload.toolResult ?? payload.toolResponse ?? payload.error ?? payload.reason;
  const resultText = useMemo(() => formatToolResult(rawResult), [rawResult]);
  const imageRead = useMemo(() => parseImageReadResult(rawResult), [rawResult]);
  const imageViewerData = useMemo(
    () => imageRead ? {
      source: { kind: 'path' as const, path: imageRead.file },
      alt: 'ImageRead 完整图片',
      description: imageRead.description,
      provider: imageRead.provider,
      model: imageRead.model,
    } : null,
    [imageRead],
  );
  const inputForDisplay = useMemo(
    () => mergeToolInputs(startPayload.toolInput, payload.toolInput),
    [payload.toolInput, startPayload.toolInput],
  );
  const detail = useMemo(
    () => imageRead ? null : describeToolInput(tool, inputForDisplay),
    [imageRead, inputForDisplay, tool],
  );
  const status = toolStatusView(payload);
  const duration = formatToolDuration(payload.durationMs);
  const truncation = providerTruncationLabel(payload);
  const timestamp = formatTimestamp(event.ts);
  const id = eventId(event);
  const openImageViewer = useCallback((): void => {
    imageViewerRootRef.current
      ?.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')
      ?.click();
  }, []);
  const viewer = (
    <ToolContentViewer
      sessionId={sessionId}
      eventId={id}
      revision={event.ts}
      toolName={imageRead ? 'ImageRead' : tool}
      toolInput={inputForDisplay}
      resultValue={rawResult}
      resultText={resultText}
      resultStatus={status.isError ? 'error' : 'success'}
      statusLabel={status.label}
      statusDetail={status.detail}
      duration={duration}
      truncation={truncation}
      image={imageViewerData}
    />
  );

  return (
    <li className={`relative min-w-0 rounded-md border p-2 text-[11px] ${
      status.isError
        ? 'border-status-error/40 bg-status-error/[0.05]'
        : 'border-deck-border/40 bg-white/[0.015]'
    } ${imageRead ? '' : 'pr-12'}`}>
      {!imageRead && viewer}
      <div className="flex min-h-11 min-w-0 items-center gap-1.5">
        <span>
          {imageRead
            ? <ImageIcon className="h-3 w-3" />
            : toolIcon(tool, payload.toolKind ?? startPayload.toolKind)}
        </span>
        <span className="min-w-0 truncate font-mono">
          {imageRead ? 'ImageRead' : tool}
        </span>
        <span className={status.isError ? 'text-status-error/90' : 'text-deck-muted'}>
          {status.label}
        </span>
        {status.detail && (
          <span className="max-w-48 truncate text-[9px] text-deck-muted" title={status.detail}>
            · {status.detail}
          </span>
        )}
        {imageRead?.provider && (
          <span className="text-[9px] text-deck-muted/70">
            [{imageRead.provider}{imageRead.model ? ` · ${imageRead.model}` : ''}]
          </span>
        )}
        {detail && <span className="min-w-0 truncate text-[10px] text-deck-muted">· {detail}</span>}
        {typeof payload.exitCode === 'number' && status.isError && (
          <span className="rounded bg-status-error/20 px-1 py-0.5 font-mono text-[9px] text-status-error/90">
            退出码 {String(payload.exitCode)}
          </span>
        )}
        {duration && <span className="text-[9px] text-deck-muted/70">{duration}</span>}
        {truncation && <span className="text-[9px] text-amber-300/90">{truncation}</span>}
        <span className="ml-auto shrink-0 font-mono tabular-nums text-[9px] text-deck-muted/60">
          {timestamp}
        </span>
      </div>
      {imageRead && (
        <div className="mt-2 flex min-w-0 gap-2">
          <div ref={imageViewerRootRef} className="relative shrink-0">
            <ImageThumb
              sessionId={sessionId}
              source={{ kind: 'path', path: imageRead.file }}
              size="md"
              alt="ImageRead 缩略图"
              onClick={openImageViewer}
            />
            {viewer}
          </div>
          <div className="min-w-0 flex-1 overflow-hidden">
            <div className="text-[9px] text-deck-muted">描述</div>
            <div className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-deck-text/90 scrollbar-deck">
              {imageRead.description}
            </div>
          </div>
        </div>
      )}
      {!imageRead && !resultText.trim() && (
        <div className="mt-1 text-[10px] italic text-deck-muted/70">（无输出）</div>
      )}
    </li>
  );
}

function eventId(event: AgentEvent): string {
  return activityEventIdentity(event);
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false });
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
