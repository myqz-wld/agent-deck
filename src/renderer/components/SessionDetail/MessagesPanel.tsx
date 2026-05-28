import { useEffect, useState, type JSX } from 'react';
import type { AgentDeckMessage } from '@shared/types';
import { useSessionStore } from '@renderer/stores/session-store';
import { MarkdownText } from '@renderer/components/MarkdownText';
import { statusBadge, relativeTime } from '../TeamDetail/helpers';

/**
 * SessionDetail 「跨会话消息」tab —— DB 视角的 send_message 历史全量视图。
 *
 * CHANGELOG_100 / plan mcp-tool-simplify-20260514：删 reply_message + wait_reply + check_reply
 * 三个 tool + J fix 后，所有 reply 现在通过 send_message + reply_to_message_id 发送，
 * 自动 dispatch 进 receiver SDK conversation flow（活动 tab 能看到）。本 panel 仍提供
 * DB 视角全量历史 + 状态可见性（包括失败 / 重试 / 已投递时序），活动流补不到的角度。
 *
 * 视觉上区分本 session 角色：
 * - 本 session 是 sender（from = sid）：左侧 "→" 标记 + 高亮目标
 * - 本 session 是 receiver（to = sid）：左侧 "↩" 标记 + 高亮 sender
 * - reply chain：reply_to_message_id 非空时显示「↩ #abc12345…」
 *
 * 数据源：listAgentDeckMessagesBySession（IPC 走 from_session_id OR to_session_id 查询）。
 * 监听 onAgentDeckMessageChanged 200ms 节流后重拉（不解析 payload from/to，整体重拉简单可靠）。
 */
interface Props {
  sessionId: string;
}

const EMPTY: AgentDeckMessage[] = [];

export function MessagesPanel({ sessionId }: Props): JSX.Element {
  const sessions = useSessionStore((s) => s.sessions);
  const [messages, setMessages] = useState<AgentDeckMessage[]>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let req = 0;

    const sync = (): void => {
      const cur = ++req;
      void window.api
        .listAgentDeckMessagesBySession({ sessionId, limit: 100 })
        .then((rows) => {
          if (disposed || cur !== req) return;
          setMessages(rows);
          setLoaded(true);
          setError(null);
        })
        .catch((err: unknown) => {
          if (disposed) return;
          setError(`加载消息失败：${(err as Error).message ?? String(err)}`);
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
    <ol className="flex flex-col gap-1.5">
      {messages.map((msg) => {
        const isSender = msg.fromSessionId === sessionId;
        const otherId = isSender ? msg.toSessionId : msg.fromSessionId;
        const otherSess = sessions.get(otherId);
        const otherTitle = otherSess?.title ?? otherId.slice(0, 8);
        const arrow = isSender ? '→' : '↩';
        const arrowColor = isSender ? 'text-cyan-300/80' : 'text-blue-300/80';
        return (
          <li
            key={msg.id}
            className="rounded border border-deck-border/40 bg-white/[0.02] px-2 py-1 text-[11px]"
          >
            <div className="flex items-center justify-between text-[10px] text-deck-muted">
              <span className="truncate">
                <span className={`mr-1 font-mono ${arrowColor}`}>{arrow}</span>
                <span className="text-deck-text/85">{otherTitle}</span>
                {msg.replyToMessageId && (
                  <span
                    className="ml-1 text-blue-300/70"
                    title="回复上一条消息"
                  >
                    ↩ 回复
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
  );
}
