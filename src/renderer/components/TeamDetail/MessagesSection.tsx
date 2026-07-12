import type { JSX } from 'react';
import type { AgentDeckMessage } from '@shared/types';
import { useSessionStore } from '@renderer/stores/session-store';
import { Section, EmptyState } from './Header';
import { relativeTime } from './helpers';
import { MarkdownText } from '@renderer/components/MarkdownText';
import { ArrowRightIcon, ReplyIcon } from '../icons';
import { MessageStatusBadge } from '../MessageStatusBadge';

/**
 * plan team-cohesion-fix-20260513 Phase C：team 内 cross-adapter messages 流 section（最近
 * 100 条）。Phase B7 后 messages.body 列存原始 body（不含 wire prefix `[from X @ Y][msg <id>]`）。
 *
 * 数据来自 IPC `agent-deck-team:get-full` 的 `recentMessages`。展示：
 * - sender → receiver
 * - body 走 MarkdownText（含 GFM 表格 / 代码块 syntax highlighting / inline code 底色 /
 *   blockquote / list 等），与 ActivityFeed message-row / ExitPlanRow / tool-row 同款风格
 * - status badge + reason
 * - reply chain：reply_to_message_id 非空时显示「↩ 回复 #abc12345...」
 *
 * 去掉了之前 240 字符截断（reviewer reply 常在 500-2000 字符，截断会破坏 markdown 结构、
 * 用户也看不到完整内容）；message 列表整体在父 div overflow-y-auto 内滚动，长 message 不
 * 会撑破 layout。
 */
interface Props {
  messages: AgentDeckMessage[];
}

export function MessagesSection({ messages }: Props): JSX.Element {
  const sessions = useSessionStore((s) => s.sessions);

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
