import type { JSX } from 'react';
import type { AgentEvent } from '@shared/types';
import { describe } from '../describe';
import { formatDisplayText, formatToolResult } from '../format';
import { MarkdownText } from '../../MarkdownText';
import { EventIcon } from '../activity-icon';
import { turnOutcome } from '../turn-outcome';
import { readCompaction } from '@shared/compaction';
import { CompactionRow } from './compaction-row';
import { StatusRow } from './status-row';

/** 兜底：单行带状态点 + 中文摘要 + 时间戳。所有未被特化处理的 event kind 都走这里。 */
export function SimpleRow({ event }: { event: AgentEvent }): JSX.Element {
  if (readCompaction(event)) return <CompactionRow event={event} />;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const summary = event.kind === 'subagent-end' ? formatDisplayText(payload.lastAssistantMessage)
    : '';
  const error = event.kind === 'finished' ? formatDisplayText(payload.errorDetails ?? payload.error) : '';
  const metadata = Object.entries({ subagentId: '子代理', description: '说明', phase: '阶段', backgroundTasks: '后台任务', sessionCrons: '定时任务' })
    .filter(([key]) => payload[key] !== undefined && payload[key] !== null
      && !(typeof payload[key] === 'object' && Object.keys(payload[key] as object).length === 0))
    .map(([key, label]) => ({ label, text: formatToolResult(payload[key]).trim() }))
    .filter(({ text }) => text.length > 0)
    .map(({ label, text }) => `${label}：${text}`).join('\n');
  const failed = event.kind === 'finished' && turnOutcome(payload).icon === 'error';
  return <StatusRow title={describe(event)} ts={event.ts} tone={failed ? 'error' : 'neutral'}
    icon={<EventIcon event={event} className={`h-3.5 w-3.5 shrink-0 ${failed ? 'text-status-error/80' : 'text-deck-muted/70'}`} />}>
    {summary || metadata || error ? <>
      {summary && <div className="max-h-72 overflow-auto"><MarkdownText text={summary} /></div>}
      {error && <pre className="whitespace-pre-wrap break-words">{error}</pre>}
      {metadata && <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[10px]">{metadata}</pre>}
    </> : null}
  </StatusRow>;
}
