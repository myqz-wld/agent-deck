import type { JSX } from 'react';
import { ActivityIcon } from './activity-feed/activity-icon';
import type { LiveActivitySummary } from './session-live-activity';

/** Live summaries keep a fixed icon column while only the text truncates. */
export function SessionActivityLine({ line, muted = false }: {
  line: LiveActivitySummary; muted?: boolean;
}): JSX.Element {
  const color = line.icon === 'error' ? 'text-status-error'
    : ['waiting', 'permission', 'question', 'plan'].includes(line.icon) ? 'text-status-waiting'
      : 'text-deck-muted';
  return <div className={`flex min-w-0 items-center gap-1.5 text-[10px] ${muted ? 'text-deck-text/60' : 'text-deck-text/85'}`} title={line.text}>
    <ActivityIcon kind={line.icon} tool={line.tool} className={`h-3.5 w-3.5 shrink-0 ${color}`} />
    <span className="min-w-0 truncate">{line.text}</span>
  </div>;
}
