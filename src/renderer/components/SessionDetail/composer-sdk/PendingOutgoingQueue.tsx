import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { AgentEvent, PendingOutgoingMessage } from '@shared/types';
import { CloseIcon } from '../../icons';
import log from '@renderer/utils/logger';

const logger = log.scope('renderer-pending-outgoing');

function consumedMessageId(event: AgentEvent, sessionId: string): string | null {
  if (event.sessionId !== sessionId || event.kind !== 'message') return null;
  const payload = event.payload as { role?: unknown; turnCorrelationId?: unknown } | null;
  return payload?.role === 'user' && typeof payload.turnCorrelationId === 'string'
    ? payload.turnCorrelationId
    : null;
}

export function PendingOutgoingQueue({
  agentId,
  sessionId,
  refreshVersion,
}: {
  agentId: string;
  sessionId: string;
  refreshVersion: number;
}): JSX.Element | null {
  const [messages, setMessages] = useState<PendingOutgoingMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  const requestIdRef = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const requestId = ++requestIdRef.current;
    try {
      const next = await window.api.listPendingOutgoingMessages(agentId, sessionId);
      if (requestId !== requestIdRef.current) return;
      setMessages(next);
      setError(null);
    } catch (reason) {
      if (requestId !== requestIdRef.current) return;
      logger.error('listPendingOutgoingMessages failed', reason);
      setError('等待队列加载失败');
    }
  }, [agentId, sessionId]);

  useEffect(() => {
    setMessages([]);
    setError(null);
    const off = window.api.onAgentEvent((event) => {
      const messageId = consumedMessageId(event, sessionId);
      if (!messageId) return;
      setMessages((current) => current.filter((message) => message.id !== messageId));
      void refresh();
    });
    return () => {
      requestIdRef.current += 1;
      off();
    };
  }, [refresh, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshVersion]);

  const remove = async (messageId: string): Promise<void> => {
    setDeleting((current) => new Set(current).add(messageId));
    try {
      const removed = await window.api.deletePendingOutgoingMessage(
        agentId,
        sessionId,
        messageId,
      );
      if (!removed) setError('消息已被会话消费，不能再从等待队列删除。');
      await refresh();
    } catch (reason) {
      logger.error('deletePendingOutgoingMessage failed', reason);
      setError('删除等待消息失败');
    } finally {
      setDeleting((current) => {
        const next = new Set(current);
        next.delete(messageId);
        return next;
      });
    }
  };

  if (messages.length === 0 && !error) return null;
  return (
    <section className="mb-1.5 rounded border border-status-waiting/25 bg-status-waiting/[0.06] p-1.5">
      <div className="mb-1 flex items-center justify-between gap-2 text-[9px] text-deck-muted">
        <span>等待会话消费 · {messages.length}</span>
        {error && <span role="alert" className="text-status-error">{error}</span>}
      </div>
      <div className="max-h-28 space-y-1 overflow-y-auto scrollbar-deck" role="list">
        {messages.map((message) => (
          <div
            key={message.id}
            role="listitem"
            className="flex items-start gap-1.5 rounded bg-black/20 px-2 py-1 text-[10px]"
          >
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-deck-text/85">
              {message.text || '(仅附件)'}
              {message.attachmentCount > 0 ? `  · ${message.attachmentCount} 个附件` : ''}
            </span>
            <button
              type="button"
              disabled={deleting.has(message.id)}
              onClick={() => void remove(message.id)}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-deck-muted hover:bg-white/10 hover:text-status-error disabled:opacity-40"
              aria-label="删除等待消息"
              title="从等待队列删除"
            >
              <CloseIcon className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
