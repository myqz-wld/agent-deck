import { type JSX } from 'react';
import { useEventDisclosure } from '../../native-work/preferences';
import type { AgentEvent } from '@shared/types';
import { formatDisplayText } from '../format';
import { presentToolResult, rawToolResult } from '../tool-result-presentation';
import { formatToolDuration, providerTruncationLabel, toolStatusView } from '../tool-status';
import { EventImages } from './event-images';
import { commandEvent, useNativeCommand } from '../../native-work/command-context';
import { useNativeWorkRecords } from '../../native-work/useNativeWorkRecords';
import { isTerminalNativeWork, type NativeWorkSnapshot } from '@shared/native-work';
import type { NativeWorkTransport } from '../../native-work/transport';

export function ToolRunStatus({ event, pending = false }: { event?: AgentEvent; pending?: boolean }): JSX.Element | null {
  const native = useNativeCommand(event);
  if (!event) return null;
  event = commandEvent(event, native?.task);
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const status = pending && payload.status === undefined
    ? { label: '已开始', isError: false } : toolStatusView(payload);
  const duration = formatToolDuration(payload.durationMs);
  return <span className={`inline-flex shrink-0 items-center gap-1 text-[10px] ${status.isError ? 'text-status-error' : 'text-deck-muted'}`}>
    {status.label}{duration && <span className="font-mono tabular-nums">· {duration}</span>}
  </span>;
}

export function ToolResultContent({ event, fallbackOutput }: { event: AgentEvent; fallbackOutput?: unknown }): JSX.Element {
  const native = useNativeCommand(event);
  return native && native.task.native.provider !== 'codex-cli'
    ? <NativeCommandResult event={event} fallbackOutput={fallbackOutput} {...native} />
    : <ToolResultBody event={event} fallbackOutput={fallbackOutput} />;
}

function NativeCommandResult({ event, fallbackOutput, task, transport }: {
  event: AgentEvent; fallbackOutput?: unknown; task: NativeWorkSnapshot; transport: NativeWorkTransport;
}): JSX.Element {
  const { grouped, loaded, error, retry, hasMore, loadMore } = useNativeWorkRecords(task, transport);
  const output = grouped.filter(record => record.kind === 'output');
  const text = output.map(record => record.text).join('\n\n');
  const current = commandEvent(event, task);
  return <>
    {!loaded && <p className="mt-1.5 text-[10px] text-deck-muted">正在读取后台输出…</p>}
    {error && <p role="alert" className="mt-1.5 text-[10px] text-status-error">后台输出读取失败。<button onClick={retry}>重试</button></p>}
    <ToolResultBody event={{ ...current, payload: { ...(current.payload as Record<string, unknown>),
      ...(output.length ? { toolResult: text } : task.summary ? { toolResult: task.summary } : {}),
      toolResultTruncated: output.some(record => record.incomplete || record.sourceTruncated),
    } }} fallbackOutput={fallbackOutput} />
    {hasMore && <button className="mt-1.5 text-[10px] text-deck-muted" onClick={loadMore}>加载更多输出</button>}
  </>;
}

function ToolResultBody({ event, fallbackOutput }: { event: AgentEvent; fallbackOutput?: unknown }): JSX.Element {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const status = toolStatusView(payload);
  const toolName = typeof payload.toolName === 'string' ? payload.toolName : '';
  let presentation = presentToolResult(payload.toolResult ?? payload.toolResponse ?? payload.aggregatedOutput
    ?? (payload.__truncated === true ? payload.__preview : undefined), toolName);
  if (presentation.sections.length === 0 && presentation.raw === undefined) {
    presentation = presentToolResult(fallbackOutput, toolName);
  }
  const output = presentation.sections.map(({ text }) => text).join('\n');
  const [rawOpen, setRawOpen] = useEventDisclosure(event, 'tool-raw');
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
  const native = useNativeCommand(event);
  event = commandEvent(event, native?.task);
  if (native && native.task.native.provider !== 'codex-cli') completed = isTerminalNativeWork(native.task.status);
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const output = payload.aggregatedOutput;
  const [open, setOpen] = useEventDisclosure(event, 'tool-execution-output', toolStatusView(payload).isError);
  const progress = !completed && typeof payload.progressMessage === 'string' ? payload.progressMessage : '';
  const hasOutput = native || output !== undefined || completed || progress;
  return <>
    {hasOutput && <details className="mt-1.5 min-w-0" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-[10px] text-deck-muted hover:text-deck-text">
        {completed ? '查看输出' : '执行输出'}{progress ? ` · ${progress}` : ''}
      </summary>
      {(!native || open) && <ToolResultContent event={event} fallbackOutput={fallbackOutput} />}
    </details>}
    <EventImages payload={payload} sessionId={event.sessionId} />
  </>;
}
