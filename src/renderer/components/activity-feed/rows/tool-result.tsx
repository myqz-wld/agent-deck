import { useState, type JSX } from 'react';
import type { AgentEvent } from '@shared/types';
import { formatDisplayText } from '../format';
import { presentToolResult, rawToolResult } from '../tool-result-presentation';
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
  const toolName = typeof payload.toolName === 'string' ? payload.toolName : '';
  let presentation = presentToolResult(payload.toolResult ?? payload.toolResponse ?? payload.aggregatedOutput
    ?? (payload.__truncated === true ? payload.__preview : undefined), toolName);
  if (presentation.sections.length === 0 && presentation.raw === undefined) {
    presentation = presentToolResult(fallbackOutput, toolName);
  }
  const output = presentation.sections.map(({ text }) => text).join('\n');
  const [rawOpen, setRawOpen] = useState(false);
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
    {presentation.sections.map((section, index) => <div key={index} className="mb-1 min-w-0 last:mb-0">
      {section.label && <div className="mb-0.5 text-[10px] text-deck-muted">{section.label}</div>}
      <pre className={`max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-black/25 p-2 text-[11px] leading-relaxed scrollbar-deck ${section.isError ? 'text-status-error' : 'text-deck-muted'}`}>{section.text}</pre>
    </div>)}
    {!output && !error && <div className="text-[10px] text-deck-muted">（无文本输出）</div>}
    {presentation.raw !== undefined && <div className="mt-1.5">
      <button type="button" aria-expanded={rawOpen} onClick={() => setRawOpen((open) => !open)}
        className="text-[10px] text-deck-muted hover:text-deck-text">
        {rawOpen ? '收起原始数据' : '查看原始数据'}
      </button>
      {rawOpen && <pre className="mt-1 max-h-64 overflow-auto rounded bg-black/20 p-2 text-[10px] text-deck-muted scrollbar-deck">{rawToolResult(presentation.raw)}</pre>}
    </div>}
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
