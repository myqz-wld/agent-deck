import type { JSX } from 'react';
import type { AgentDeckMessage } from '@shared/types';
import { useSessionStore } from '@renderer/stores/session-store';
import { Section, EmptyState } from './Header';
import { statusBadge, relativeTime } from './helpers';

/**
 * plan team-cohesion-fix-20260513 Phase C：team 内 cross-adapter messages 流 section（最近
 * 100 条）。Phase B7 后 messages.body 列存原始 body（不含 wire prefix `[from X @ Y][msg <id>]`）。
 *
 * 数据来自 IPC `agent-deck-team:get-full` 的 `recentMessages`。展示：
 * - sender → receiver
 * - body（截 240 字符）
 * - status badge + reason
 * - reply chain：reply_to_message_id 非空时显示「↩ 回复 #abc12345...」
 */
interface Props {
  messages: AgentDeckMessage[];
}

export function MessagesSection({ messages }: Props): JSX.Element {
  const sessions = useSessionStore((s) => s.sessions);

  if (messages.length === 0) {
    return (
      <Section title="消息" count={0}>
        <EmptyState>团队内暂无 cross-adapter 消息</EmptyState>
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
                  {fromSess?.title ?? msg.fromSessionId.slice(0, 8)} →{' '}
                  {toSess?.title ?? msg.toSessionId.slice(0, 8)}
                  {msg.replyToMessageId && (
                    <span
                      className="ml-1 text-blue-300/70"
                      title={`回复 message id: ${msg.replyToMessageId}`}
                    >
                      ↩ #{msg.replyToMessageId.slice(0, 8)}
                    </span>
                  )}
                </span>
                <span className="ml-2 shrink-0 flex items-center gap-1.5">
                  <span className="text-deck-muted/60 tabular-nums">
                    {relativeTime(msg.sentAt)}
                  </span>
                  <span>{statusBadge(msg.status)}</span>
                </span>
              </div>
              <div className="mt-1 whitespace-pre-wrap break-words text-deck-text">
                {msg.body.length > 240 ? `${msg.body.slice(0, 240)}…` : msg.body}
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
