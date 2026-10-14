import { useId, useState, type JSX, type ReactNode } from 'react';
import { ChevronDownIcon } from '../../icons';

/** Shared, quiet timeline chrome. Interactive approvals and tool results keep their own surfaces. */
export function StatusRow({ title, icon, ts, tags, metrics, children, tone = 'neutral', label }: {
  title: string;
  icon: ReactNode;
  ts: number;
  tags?: ReactNode;
  metrics?: ReactNode;
  children?: ReactNode;
  tone?: 'neutral' | 'working' | 'error';
  label?: string;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const timestamp = new Date(ts);
  const validTime = Number.isFinite(timestamp.getTime());
  const content = <>
    {icon}
    <span className={`min-w-0 break-words ${tone === 'error' ? 'text-status-error' : 'text-deck-muted'}`}>{title}</span>
    {tags}
    {metrics && <span className="ml-auto flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10px] tabular-nums text-deck-muted/80">{metrics}</span>}
    <time className={`${metrics ? '' : 'ml-auto'} shrink-0 text-[9px] tabular-nums text-deck-muted/55`}
      dateTime={validTime ? timestamp.toISOString() : undefined}>{validTime ? timestamp.toLocaleTimeString('zh-CN', { hour12: false }) : ''}</time>
    {children && <ChevronDownIcon className={`h-3 w-3 shrink-0 text-deck-muted/60 transition-transform ${expanded ? 'rotate-180' : ''}`} />}
  </>;
  const headerClass = 'flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 px-2.5 py-2 text-left text-[11px] leading-relaxed';
  return <li className={`min-w-0 rounded-md border ${tone === 'error'
    ? 'border-status-error/20 bg-status-error/[0.035]' : 'border-deck-border/70 bg-white/[0.015]'}`}>
    {children ? <button type="button" className={`${headerClass} hover:bg-white/[0.025] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-deck-muted/50`}
      aria-label={`${label ?? title}，${expanded ? '收起' : '展开'}详情`} aria-expanded={expanded}
      aria-controls={detailId} onClick={() => setExpanded((value) => !value)}>{content}</button>
      : <div className={headerClass}>{content}</div>}
    {children && <div id={detailId} hidden={!expanded} className="min-w-0 border-t border-deck-border/60 px-3 py-2 text-[11px] leading-relaxed text-deck-muted">
      {children}
    </div>}
  </li>;
}
