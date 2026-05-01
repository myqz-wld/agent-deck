import { type JSX } from 'react';
import type { AgentEvent } from '@shared/types';

/** team-* event 时间线一行渲染（图标 + 描述 + 时间）。 */
export function TeamEventRow({ event }: { event: AgentEvent }): JSX.Element {
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const teammate = typeof p.teammateName === 'string' ? p.teammateName : '';
  const desc = typeof p.description === 'string' ? p.description : '';
  const reason = typeof p.reason === 'string' ? p.reason : '';
  const lastTask = typeof p.lastTask === 'string' ? p.lastTask : '';

  let icon = '·';
  let kindLabel = '';
  let body = '';
  switch (event.kind) {
    case 'team-task-created':
      icon = '➕';
      kindLabel = 'TaskCreated';
      body = teammate ? `${teammate} → ${desc || '(no desc)'}` : desc || '(no desc)';
      break;
    case 'team-task-completed':
      icon = '✅';
      kindLabel = 'TaskCompleted';
      body = teammate ? `${teammate} done: ${desc || '(no desc)'}` : `done: ${desc || '(no desc)'}`;
      break;
    case 'team-teammate-idle':
      icon = '💤';
      kindLabel = 'TeammateIdle';
      body =
        (teammate || 'teammate') +
        ' idle' +
        (lastTask ? `  (last: ${lastTask})` : '') +
        (reason ? `  [${reason}]` : '');
      break;
    default:
      kindLabel = event.kind;
      body = JSON.stringify(p).slice(0, 80);
  }

  return (
    <li className="flex items-start gap-1.5 rounded border border-deck-border/40 bg-white/[0.02] px-2 py-1 text-[10px]">
      <span className="shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[9px] text-deck-muted/70">{kindLabel}</span>
          <span className="ml-auto font-mono tabular-nums text-[9px] text-deck-muted/60">{ts}</span>
        </div>
        <div className="mt-0.5 truncate" title={body}>
          {body}
        </div>
      </div>
    </li>
  );
}
