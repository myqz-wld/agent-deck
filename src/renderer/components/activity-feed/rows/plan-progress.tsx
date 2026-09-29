import type { JSX } from 'react';
import { CircleCheckIcon, ClockIcon, PlayIcon } from '../../icons';

export function PlanProgress({ entries }: { entries: unknown }): JSX.Element | null {
  if (!Array.isArray(entries)) return null;
  const steps = entries.filter((entry): entry is { content: string; status?: string; priority?: string } =>
    entry && typeof entry === 'object' && typeof entry.content === 'string');
  if (!steps.length) return null;
  return <ul className="m-0 space-y-1.5 pl-0 not-italic">
    {steps.map((entry, index) => {
      const done = entry.status === 'completed';
      const active = entry.status === 'in_progress' || entry.status === 'inProgress';
      const Icon = done ? CircleCheckIcon : active ? PlayIcon : ClockIcon;
      return <li key={index} className="flex items-start gap-2">
        <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${active ? 'text-status-working' : 'text-deck-muted'}`} />
        <span className={done ? 'text-deck-muted' : 'text-deck-text'}>{entry.content}</span>
        <span className="ml-auto shrink-0 text-[9px] text-deck-muted">{done ? '已完成' : active ? '进行中' : '待处理'}
          {entry.priority ? ` · ${entry.priority}` : ''}</span>
      </li>;
    })}
  </ul>;
}
