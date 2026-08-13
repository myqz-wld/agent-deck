import type { JSX, MouseEventHandler, ReactNode } from 'react';

import type { ActivityState, LifecycleState } from '@shared/types';
import { agentIdLabel } from './TeamDetail/helpers';
import { StatusBadge } from './StatusBadge';

interface SessionCardFrameProps {
  children: ReactNode;
  element?: 'button' | 'div';
  emphasis?: 'default' | 'lead';
  label?: string;
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  onSelect(): void;
  selected: boolean;
  sessionId: string;
}

export function SessionCardFrame({
  children,
  element = 'div',
  emphasis = 'default',
  label,
  onContextMenu,
  onSelect,
  selected,
  sessionId,
}: SessionCardFrameProps): JSX.Element {
  const className = `group relative w-full cursor-pointer rounded-lg border px-3 py-2 text-left transition ${
    selected
      ? 'border-white/30 bg-white/10'
      : emphasis === 'lead'
        ? 'border-blue-400/40 bg-white/[0.02] hover:bg-white/[0.06]'
        : 'border-deck-border bg-white/[0.02] hover:bg-white/[0.06]'
  }`;
  if (element === 'button') {
    return (
      <button
        type="button"
        data-session-card-frame="true"
        data-session-id={sessionId}
        aria-label={label}
        aria-pressed={selected}
        onClick={onSelect}
        className={className}
      >
        {children}
      </button>
    );
  }
  return (
    <div
      data-session-card-frame="true"
      data-session-id={sessionId}
      {...(onContextMenu ? {
        role: 'button',
        tabIndex: 0,
        'aria-label': label,
        'aria-pressed': selected,
      } : {})}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onKeyDown={onContextMenu ? (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
          return;
        }
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
        event.preventDefault();
        const bounds = event.currentTarget.getBoundingClientRect();
        event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: bounds.left + Math.min(24, bounds.width / 2),
          clientY: bounds.top + Math.min(24, bounds.height / 2),
        }));
      } : undefined}
      className={className}
    >
      {children}
    </div>
  );
}

export function SessionCardHeader({
  activity,
  adapterId,
  archived = false,
  children,
  lifecycle,
  title,
}: {
  activity: ActivityState;
  adapterId: string;
  archived?: boolean;
  children?: ReactNode;
  lifecycle: LifecycleState;
  title: string;
}): JSX.Element {
  return (
    <div data-session-card-header="true" className="flex items-center gap-2">
      <StatusBadge activity={activity} lifecycle={lifecycle} archived={archived} />
      <div className="min-w-0 flex-1 truncate text-[12px] font-medium">{title}</div>
      {children}
      <span className="shrink-0 text-[9px] text-deck-muted/60">
        {agentIdLabel(adapterId)}
      </span>
    </div>
  );
}

export function SessionListSection({
  children,
  count,
  kind,
  label,
}: {
  children: ReactNode;
  count: number;
  kind: 'active' | 'dormant';
  label: string;
}): JSX.Element {
  return (
    <section data-session-section={kind}>
      <div className="mb-1.5 px-1 text-[10px] uppercase tracking-wider text-deck-muted/70">
        {label} · {count}
      </div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </section>
  );
}

export function SessionListState({
  detail,
  kind,
  title,
}: {
  detail?: ReactNode;
  kind: 'empty' | 'error' | 'loading' | 'offline';
  title: ReactNode;
}): JSX.Element {
  const error = kind === 'error';
  return (
    <div
      data-session-list-state={kind}
      {...(error ? { role: 'alert' } : {})}
      className={`flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center ${
        error ? 'text-status-waiting' : 'text-deck-muted'
      }`}
    >
      <div className="text-[12px]">{title}</div>
      {detail && <div className="text-[10px] leading-relaxed">{detail}</div>}
    </div>
  );
}
