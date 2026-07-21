import type { JSX, RefObject } from 'react';
import type { AgentEvent } from '@shared/types';
import { MemoizedMarkdownText } from '../MarkdownText';

const INTERNAL_MARKER_PREFIX = '<!-- agent-deck-plan-review-internal:';

interface ConversationMessage {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

interface Props {
  events: AgentEvent[];
  childReady: boolean;
  startError: string | null;
  waitingForReply: boolean;
  conversationRef: RefObject<HTMLDivElement | null>;
}

function conversationFromEvents(events: AgentEvent[]): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  for (const event of [...events].reverse()) {
    if (event.kind !== 'message') continue;
    const payload = event.payload as { role?: unknown; text?: unknown; error?: unknown } | null;
    if (
      (payload?.role !== 'user' && payload?.role !== 'assistant') ||
      typeof payload.text !== 'string' ||
      payload.error === true ||
      payload.text.startsWith(INTERNAL_MARKER_PREFIX)
    ) continue;
    messages.push({ role: payload.role, text: payload.text, ts: event.ts });
  }
  return messages;
}

export function PlanReviewConversation({
  events,
  childReady,
  startError,
  waitingForReply,
  conversationRef,
}: Props): JSX.Element {
  const messages = conversationFromEvents(events);

  return (
    <div ref={conversationRef} className="min-h-0 flex-1 space-y-2 overflow-auto p-3 scrollbar-deck">
      {startError ? (
        <div className="rounded border border-status-error/40 bg-status-error/10 p-2 text-[10px] text-status-error">
          {startError}
        </div>
      ) : !childReady ? (
        <div className="text-[10px] text-deck-muted">
          {waitingForReply
            ? '正在创建隔离的审阅会话…'
            : '发送第一个问题时才会创建隔离的审阅会话。'}
        </div>
      ) : (
        <>
          {messages.length === 0 && !waitingForReply && (
            <div className="text-[10px] text-deck-muted">审阅会话已创建，正在准备回答…</div>
          )}
          {messages.map((message, index) => (
            <div
              key={`${message.ts}-${index}`}
              className={`rounded-lg border p-2 text-[11px] ${
                message.role === 'user'
                  ? 'ml-6 border-status-working/30 bg-status-working/10'
                  : 'mr-6 border-deck-border bg-black/20'
              }`}
            >
              <div className="mb-1 text-[9px] text-deck-muted/70">
                {message.role === 'user' ? '你' : '审阅会话'}
              </div>
              <MemoizedMarkdownText text={message.text} />
            </div>
          ))}
          {waitingForReply && (
            <div
              data-testid="plan-review-reply-loading"
              role="status"
              aria-label="审阅会话正在回复"
              className="mr-6 flex w-fit items-center gap-1 rounded-lg border border-deck-border bg-black/20 px-3 py-2"
            >
              {[0, 150, 300].map((delay) => (
                <span
                  key={delay}
                  aria-hidden="true"
                  className="h-1.5 w-1.5 animate-bounce rounded-full bg-deck-muted"
                  style={{ animationDelay: `${delay}ms` }}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
