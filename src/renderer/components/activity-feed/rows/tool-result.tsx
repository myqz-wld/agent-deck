import type { JSX } from 'react';
import type { AgentEvent } from '@shared/types';
import { formatDisplayText, formatToolResult } from '../format';
import { formatToolDuration, providerTruncationLabel, toolStatusView } from '../tool-status';
import { EventImages } from './event-images';

export function ToolRunStatus({ event, pending = false }: { event?: AgentEvent; pending?: boolean }): JSX.Element | null {
  if (!event) return null;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const status = pending && payload.status === undefined
    ? { label: '已开始', isError: false } : toolStatusView(payload);
  const duration = formatToolDuration(payload.durationMs);
  return <span className={`inline-flex shrink-0 items-center gap-1 text-[10px] ${status.isError ? 'text-status-error' : 'text-deck-muted'}`}>
    {status.label}{duration && <span className="font-mono tabular-nums">· {duration}</span>}
  </span>;
}

export function ToolResultContent({ event, fallbackOutput }: { event: AgentEvent; fallbackOutput?: unknown }): JSX.Element {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const status = toolStatusView(payload);
  const output = formatToolResult(payload.toolResult ?? payload.toolResponse ?? payload.aggregatedOutput
    ?? (payload.__truncated === true ? payload.__preview : undefined)).trim()
    || formatToolResult(fallbackOutput).trim();
  const failure = typeof payload.error === 'boolean' || payload.error === ''
    ? payload.reason : payload.error ?? payload.reason;
  const error = formatDisplayText(failure).trim();
  const detail = [status.detail, typeof payload.exitCode === 'number' ? `退出码：${payload.exitCode}` : '', providerTruncationLabel(payload)].filter(Boolean).join(' · ');
  const states = (payload.toolResult as { agents_states?: unknown } | null)?.agents_states;
  const agents = states && typeof states === 'object' && !Array.isArray(states)
    ? Object.entries(states as Record<string, unknown>) : [];
  return <div className="mt-1.5 min-w-0">
    {detail && <div className="mb-1 text-[10px] text-deck-muted">{detail}</div>}
    {error && error !== output && <pre className="mb-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-status-error/10 p-2 text-[10px] text-status-error">{error}</pre>}
    {agents.length > 0 && <ul className="mb-2 space-y-1 text-[10px]">
      {agents.map(([id, state]) => <li key={id} className="rounded border border-deck-border p-1.5">
        <div className="font-mono">{id} · {formatDisplayText((state as { status?: unknown })?.status)}</div>
        {formatDisplayText((state as { message?: unknown })?.message)}
      </li>)}
    </ul>}
    {output || error ? <pre className="max-h-64 overflow-auto rounded bg-black/25 p-2 text-[11px] leading-relaxed text-deck-muted scrollbar-deck">{output || error}</pre>
      : <div className="text-[10px] text-deck-muted">（无输出）</div>}
  </div>;
}

export function ToolExecutionDetails({ event, completed, fallbackOutput }: {
  event: AgentEvent; completed: boolean; fallbackOutput?: unknown;
}): JSX.Element | null {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const output = payload.aggregatedOutput;
  const progress = !completed && typeof payload.progressMessage === 'string' ? payload.progressMessage : '';
  const hasOutput = output !== undefined || completed || progress;
  return <>
    {hasOutput && <details className="mt-1.5 min-w-0" open={toolStatusView(payload).isError || undefined}>
      <summary className="cursor-pointer text-[10px] text-deck-muted hover:text-deck-text">
        {completed ? '查看输出' : '执行输出'}{progress ? ` · ${progress}` : ''}
      </summary>
      <ToolResultContent event={event} fallbackOutput={fallbackOutput} />
    </details>}
    <EventImages payload={payload} sessionId={event.sessionId} />
  </>;
}
