import { useEffect, useState, type JSX } from 'react';
import type { SessionMessageDto } from '@contracts/index';
import type { AgentDeckMessage } from '@shared/types';
import { useSessionStore } from '@renderer/stores/session-store';
import { MarkdownText } from '@renderer/components/MarkdownText';
import log from '@renderer/utils/logger';
import { relativeTime } from '../TeamDetail/helpers';
import { ArrowRightIcon, ReplyIcon } from '../icons';
import { MessageStatusBadge } from '../MessageStatusBadge';
import { safeErrorData } from '../activity-feed/viewers/safe-error-data';

/**
 * Session message history preserves delivery state and reply relationships. The panel refreshes
 * from the database on message changes so it also covers failures and retries absent from activity.
 */
interface Props {
  sessionId: string;
}

const EMPTY: AgentDeckMessage[] = [];
const logger = log.scope('renderer-session-messages');

export function MessagesPanel({ sessionId }: Props): JSX.Element {
  const sessions = useSessionStore((s) => s.sessions);
  const [messages, setMessages] = useState<AgentDeckMessage[]>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let req = 0;
    let cachedCount = 0;
    setMessages(EMPTY);
    setLoaded(false);
    setError(null);

    const sync = (): void => {
      const cur = ++req;
      void window.api
        .listAgentDeckMessagesBySession({ sessionId, limit: 100 })
        .then((rows) => {
          if (disposed || cur !== req) return;
          cachedCount = rows.length;
          setMessages(rows);
          setLoaded(true);
          setError(null);
        })
        .catch((err: unknown) => {
          if (disposed || cur !== req) return;
          logger.warn('session messages load failed', {
            action: cachedCount > 0 ? 'refresh-session-messages' : 'list-session-messages',
            agentId: null,
            sessionId,
            teamId: null,
            source: 'session-detail-messages',
            count: cachedCount,
            ...safeErrorData(err),
          });
          setError(
            cachedCount > 0
              ? '刷新失败，当前显示上次结果。'
              : '读取消息失败，请稍后重试。',
          );
          setLoaded(true);
        });
    };

    sync();

    // 监听 message change 事件 → 200ms 节流后重拉。不解析 payload from/to，整体重拉简单可靠
    // （即使是别的 session 的 message change 也重拉一次，开销 ≤ 100 行 SQL，可接受）。
    const off = window.api.onAgentDeckMessageChanged(() => {
      if (timer != null) return;
      timer = setTimeout(() => {
        timer = null;
        sync();
      }, 200);
    });

    return () => {
      disposed = true;
      if (timer != null) clearTimeout(timer);
      off();
    };
  }, [sessionId]);

  const presentation: SessionMessageDto[] = messages.map((message) => ({
    id: message.id,
    teamId: message.teamId,
    fromSessionId: message.fromSessionId,
    fromTitle: sessions.get(message.fromSessionId)?.title ?? '另一会话',
    toSessionId: message.toSessionId,
    toTitle: sessions.get(message.toSessionId)?.title ?? '另一会话',
    body: message.body,
    status: message.status,
    statusReason: message.statusReason,
    sentAt: message.sentAt,
    deliveredAt: message.deliveredAt,
    replyToMessageId: message.replyToMessageId,
  }));
  return <SessionMessagesView
    sessionId={sessionId}
    messages={presentation}
    loaded={loaded}
    error={error}
  />;
}

export function SessionMessagesView({
  sessionId,
  messages,
  loaded,
  error,
  truncated = false,
}: {
  sessionId: string;
  messages: readonly SessionMessageDto[];
  loaded: boolean;
  error: string | null;
  truncated?: boolean;
}): JSX.Element {
  if (!loaded && messages.length === 0) {
    return <div className="px-2 py-3 text-[11px] text-deck-muted">加载中…</div>;
  }
  if (error && messages.length === 0) {
    return (
      <div className="px-2 py-3 text-[11px] text-status-waiting/90 leading-snug">{error}</div>
    );
  }
  if (messages.length === 0) {
    return (
      <div className="px-2 py-3 text-[11px] text-deck-muted">
        本会话暂无跨会话消息
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {error && (
        <div role="status" className="text-[10px] text-status-waiting/80">
          {error}
        </div>
      )}
      <ol className="flex flex-col gap-1.5">
      {messages.map((msg) => {
        const isSender = msg.fromSessionId === sessionId;
        const otherTitle = isSender ? msg.toTitle : msg.fromTitle;
        const arrowColor = isSender ? 'text-cyan-300/80' : 'text-blue-300/80';
        return (
          <li
            key={msg.id}
            className="rounded border border-deck-border/40 bg-white/[0.02] px-2 py-1 text-[11px]"
          >
            <div className="flex items-center justify-between text-[10px] text-deck-muted">
              <span className="truncate">
                <span className={`mr-1 inline-block align-middle ${arrowColor}`}>
                  {isSender ? <ArrowRightIcon className="h-3 w-3" /> : <ReplyIcon className="h-3 w-3" />}
                </span>
                <span className="sr-only">{isSender ? '发送给 ' : '来自 '}</span>
                <span className="text-deck-text/85">{otherTitle}</span>
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
              <div className="mt-1 text-[10px] text-status-waiting/70">{msg.statusReason}</div>
            )}
          </li>
        );
      })}
      </ol>
      {truncated && (
        <div className="text-center text-[10px] text-deck-muted">
          仅显示最近 100 条跨会话消息。
        </div>
      )}
    </div>
  );
}
