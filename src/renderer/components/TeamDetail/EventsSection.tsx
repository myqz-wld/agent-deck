import type { JSX } from 'react';
import type { AgentEvent } from '@shared/types';
import { useSessionStore } from '@renderer/stores/session-store';
import { Section, EmptyState } from './Header';
import { relativeTime, eventKindLabel } from './helpers';
import { describeEventPayload } from './events-payload-describe';
import { EventDetailViewer } from './viewers/EventDetailViewer';

/** Read-only team timeline: compact summaries stay visible while full typed payloads open on demand. */
interface Props {
  events: (AgentEvent & { id: number })[];
}

export function EventsSection({ events }: Props): JSX.Element {
  const sessions = useSessionStore((s) => s.sessions);

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
          const senderLabel = sess?.title ?? '未知会话';
          const desc = describeEventPayload(e);
          const kindLabel = e.kind === 'thinking'
            ? e.agentId === 'codex-cli' ? '推理摘要' : '思考'
            : eventKindLabel(e.kind, e.agentId);
          return (
            <li
              key={e.id}
              className="relative flex min-h-11 items-center gap-1.5 rounded border border-deck-border/30 bg-white/[0.015] py-0.5 pl-2 pr-12 text-[10px]"
            >
              <EventDetailViewer event={e} eventId={e.id} />
              <span className="shrink-0 text-deck-muted/60 tabular-nums">
                {relativeTime(e.ts)}
              </span>
              <span className="shrink-0 truncate text-deck-text/70" title={senderLabel}>
                {senderLabel}
              </span>
              <span className="shrink-0 rounded bg-white/5 px-1 py-0 text-[9px] text-deck-muted">
                {kindLabel}
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
