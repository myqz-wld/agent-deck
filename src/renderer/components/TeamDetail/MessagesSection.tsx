import type { JSX } from 'react';
import type { TeamMessageDto, TeamSessionDto } from '@contracts/index';
import { Section, EmptyState } from './Header';
import { relativeTime } from './helpers';
import { MarkdownText } from '@renderer/components/MarkdownText';
import { ArrowRightIcon, ReplyIcon } from '../icons';
import { MessageStatusBadge } from '../MessageStatusBadge';

/** Team messages keep their original inline Markdown presentation. */
interface Props {
  messages: TeamMessageDto[];
  sessions?: ReadonlyMap<string, TeamSessionDto>;
}

export function MessagesSection({ messages, sessions = new Map() }: Props): JSX.Element {

  if (messages.length === 0) {
    return (
      <Section title="消息" count={0}>
        <EmptyState>团队内暂无消息</EmptyState>
      </Section>
    );
  }

  return (
    <Section title="消息" count={messages.length}>
      <ol className="flex flex-col gap-1">
        {messages.slice(0, 30).map((msg) => {
          const fromSess = sessions.get(msg.fromSessionId);
          const toSess = sessions.get(msg.toSessionId);
          return (
            <li
              key={msg.id}
              className="rounded border border-deck-border/40 bg-white/[0.02] px-2 py-1 text-[11px]"
            >
              <div className="flex items-center justify-between text-[10px] text-deck-muted">
                <span className="truncate">
                  <span className="sr-only">从 </span>
                  {fromSess?.title ?? msg.fromSessionId.slice(0, 8)} <ArrowRightIcon className="mx-0.5 inline h-3 w-3" />{' '}
                  <span className="sr-only">发送给 </span>
                  {toSess?.title ?? msg.toSessionId.slice(0, 8)}
                  {msg.replyToMessageId && (
                    <span
                      className="ml-1 text-blue-300/70"
                      title="回复上一条消息"
                    >
                      <ReplyIcon className="mr-0.5 inline h-3 w-3" />回复
                    </span>
                  )}
                </span>
                <span className="ml-2 shrink-0 flex items-center gap-1.5">
                  <span className="text-deck-muted/60 tabular-nums">
                    {relativeTime(msg.sentAt)}
                  </span>
                  <MessageStatusBadge status={msg.status} />
                </span>
              </div>
              <div className="mt-1 break-words text-deck-text">
                <MarkdownText text={msg.body} />
              </div>
              {msg.statusReason && (
                <div className="mt-1 text-[10px] text-status-waiting/70">
                  {msg.statusReason}
                </div>
              )}
            </li>
          );
        })}
        {messages.length > 30 && (
          <li className="text-[10px] text-deck-muted/60 text-center py-1">
            …还有 {messages.length - 30} 条更早消息（仅显示最近 30 条）
          </li>
        )}
      </ol>
    </Section>
  );
}
