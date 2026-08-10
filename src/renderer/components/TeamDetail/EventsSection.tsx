import type { JSX } from 'react';
import type { SessionEventDto, TeamSessionDto } from '@contracts/index';
import { Section, EmptyState } from './Header';
import { relativeTime, eventKindLabel } from './helpers';
import { describeEventPayload } from './events-payload-describe';

/** Read-only team timeline. */
interface Props {
  events: SessionEventDto[];
  sessions?: ReadonlyMap<string, TeamSessionDto>;
}

export function EventsSection({ events, sessions = new Map() }: Props): JSX.Element {

  if (events.length === 0) {
    return (
      <Section title="近期事件" count={0}>
        <EmptyState>团队内暂无事件</EmptyState>
      </Section>
    );
  }

  return (
    <Section title="近期事件" count={events.length}>
      <ol className="flex flex-col gap-0.5">
        {events.map((e) => {
          const sess = sessions.get(e.sessionId);
          const senderLabel = sess?.title ?? e.sessionId.slice(0, 8);
          const desc = describeEventPayload(e);
          return (
            <li
              key={e.id}
              className="flex items-baseline gap-1.5 rounded border border-deck-border/30 bg-white/[0.015] px-2 py-0.5 text-[10px]"
            >
              <span className="shrink-0 text-deck-muted/60 tabular-nums">
                {relativeTime(e.ts)}
              </span>
              <span className="shrink-0 truncate text-deck-text/70" title={senderLabel}>
                {senderLabel}
              </span>
              <span className="shrink-0 rounded bg-white/5 px-1 py-0 text-[9px] text-deck-muted">
                {eventKindLabel(e.kind, e.agentId)}
              </span>
              <span
                className="ml-1 truncate text-deck-text/85"
                title={desc}
              >
                {desc}
              </span>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}
