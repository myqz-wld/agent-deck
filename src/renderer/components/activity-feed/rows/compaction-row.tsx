import { useEffect, useState, type JSX } from 'react';
import type { AgentEvent } from '@shared/types';
import { compactionTitle, readCompaction } from '@shared/compaction';
import { eventImages } from '@shared/event-images';
import { AlertTriangleIcon, CollapseIcon, PauseIcon, RefreshIcon } from '../../icons';
import { MarkdownText } from '../../MarkdownText';
import { getAgentShortName } from '../shared';
import { EventImages } from './event-images';
import { StatusRow } from './status-row';
import { formatStatusDuration as formatCompactionDuration, formatStatusTokens as formatCompactionTokens } from '../status-format';

export function CompactionRow({ event }: { event: AgentEvent }): JSX.Element | null {
  const snapshot = readCompaction(event);
  const [now, setNow] = useState(Date.now);
  const running = snapshot?.status === 'running';
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  if (!snapshot) return null;
  const { status, trigger, preTokens, postTokens, durationMs, summary, error, startedAt } = snapshot;
  const provider = getAgentShortName(event.agentId);
  const Icon = running ? RefreshIcon : status === 'failed' ? AlertTriangleIcon
    : status === 'interrupted' ? PauseIcon : CollapseIcon;
  const metrics = preTokens !== undefined || postTokens !== undefined || durationMs !== undefined;
  const payload = event.payload as { images?: unknown; imageWarnings?: unknown } | null;
  const hasImages = eventImages(event.payload).length > 0 || (Array.isArray(payload?.imageWarnings) && payload.imageWarnings.length > 0);
  const details = Boolean(metrics || summary || error || hasImages);
  return <StatusRow title={compactionTitle(status)} ts={snapshot.completedAt ?? event.ts}
    label={`${provider}：${compactionTitle(status)}`} tone={status === 'failed' ? 'error' : running ? 'working' : 'neutral'}
    icon={<Icon className={`h-3.5 w-3.5 shrink-0 ${status === 'failed' ? 'text-status-error/80' : 'text-deck-muted/70'} ${running ? 'motion-safe:animate-spin' : ''}`} />}
    tags={<><span className="rounded border border-deck-border px-1 text-[9px] text-deck-muted/70">{provider}</span>
      {trigger && <span className="text-[9px] text-deck-muted/60">{trigger === 'auto' ? '自动' : trigger === 'manual' ? '手动' : trigger}</span>}</>}
    metrics={<>
      {status === 'failed' && error && <span className="max-w-64 truncate" title={error}>{error}</span>}
      {preTokens !== undefined && postTokens !== undefined
        ? <span title={`${preTokens.toLocaleString('en-US')} → ${postTokens.toLocaleString('en-US')} Token`}>
          {formatCompactionTokens(preTokens)} → {formatCompactionTokens(postTokens)} Token</span>
        : preTokens !== undefined ? <span>压缩前 {formatCompactionTokens(preTokens)} Token</span>
          : postTokens !== undefined ? <span>压缩后 {formatCompactionTokens(postTokens)} Token</span> : null}
      {durationMs !== undefined && <span>{formatCompactionDuration(durationMs)}</span>}
      {running && startedAt !== undefined && <span>已用时 {formatCompactionDuration(Math.max(0, now - startedAt))}</span>}
    </>}>
    {details ? <>
      {metrics && <dl className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] tabular-nums">
        {preTokens !== undefined && <div><dt className="inline text-deck-muted/60">压缩前 </dt><dd className="inline">{preTokens.toLocaleString('en-US')} Token</dd></div>}
        {postTokens !== undefined && <div><dt className="inline text-deck-muted/60">压缩后 </dt><dd className="inline">{postTokens.toLocaleString('en-US')} Token</dd></div>}
        {durationMs !== undefined && <div><dt className="inline text-deck-muted/60">耗时 </dt><dd className="inline">{durationMs / 1000}秒</dd></div>}
      </dl>}
      {error && <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">{error}</pre>}
      {summary && <div className="max-h-72 overflow-auto"><MarkdownText text={summary} /></div>}
      {hasImages && <EventImages payload={event.payload} sessionId={event.sessionId} />}
    </> : null}
  </StatusRow>;
}
