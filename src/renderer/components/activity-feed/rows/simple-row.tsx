import type { JSX } from 'react';
import type { AgentEvent } from '@shared/types';
import { describe } from '../describe';
import { formatDisplayText, formatToolResult } from '../format';
import { MarkdownText } from '../../MarkdownText';

/** 兜底：单行带状态点 + 中文摘要 + 时间戳。所有未被特化处理的 event kind 都走这里。 */
export function SimpleRow({ event }: { event: AgentEvent }): JSX.Element {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const summary = event.kind === 'subagent-end' ? formatDisplayText(payload.lastAssistantMessage)
    : event.kind === 'context-compaction-end' ? formatDisplayText(payload.summary) : '';
  const error = event.kind === 'finished' ? formatDisplayText(payload.errorDetails ?? payload.error) : '';
  const metadata = Object.entries({ subagentId: '子代理', description: '说明', phase: '阶段', backgroundTasks: '后台任务', sessionCrons: '定时任务' })
    .filter(([key]) => payload[key] !== undefined && payload[key] !== null)
    .map(([key, label]) => `${label}：${formatToolResult(payload[key])}`).join('\n');
  return (
    <li className="flex min-w-0 items-start gap-2 text-[11px]">
      <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-deck-muted/60" />
      <div className="min-w-0 flex-1 leading-relaxed">
        <div className={`break-words ${event.kind === 'finished' && payload.ok === false ? 'text-status-error' : 'text-deck-text'}`}>{describe(event)}</div>
        {(summary || metadata || error) && <details className="mt-1 min-w-0">
          <summary className="cursor-pointer text-[10px] text-deck-muted">查看详情</summary>
          {summary && <div className="mt-1 max-h-72 overflow-auto rounded bg-black/15 p-2"><MarkdownText text={summary} /></div>}
          {error && <pre className="mt-1 whitespace-pre-wrap text-status-error">{error}</pre>}
          {metadata && <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-[10px] text-deck-muted">{metadata}</pre>}
        </details>}
        <div className="mt-0.5 text-[9px] text-deck-muted/60">
          {new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false })}
        </div>
      </div>
    </li>
  );
}
