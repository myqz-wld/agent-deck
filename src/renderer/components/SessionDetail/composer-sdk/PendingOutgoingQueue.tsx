import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { AgentEvent, PendingOutgoingMessage } from '@shared/types';
import { CloseIcon } from '../../icons';
import log from '@renderer/utils/logger';

const logger = log.scope('renderer-pending-outgoing');
const EMPTY_DELETING = new Set<string>();

interface QueueViewState {
  key: string;
  messages: PendingOutgoingMessage[];
  error: string | null;
  deleting: Set<string>;
}

function emptyQueueState(key: string): QueueViewState {
  return { key, messages: [], error: null, deleting: new Set() };
}

function safeErrorKind(reason: unknown): string {
  if (reason instanceof Error) return reason.name || 'Error';
  return typeof reason;
}

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
  const logicalKey = `${agentId}\0${sessionId}`;
  const logicalKeyRef = useRef(logicalKey);
  logicalKeyRef.current = logicalKey;
  const [queue, setQueue] = useState<QueueViewState>(() => emptyQueueState(logicalKey));
  const requestIdRef = useRef(0);
  const messages = queue.key === logicalKey ? queue.messages : [];
  const error = queue.key === logicalKey ? queue.error : null;
  const deleting = queue.key === logicalKey ? queue.deleting : EMPTY_DELETING;

  const refresh = useCallback(async (): Promise<void> => {
    const requestKey = logicalKey;
    const requestId = ++requestIdRef.current;
    try {
      const next = await window.api.listPendingOutgoingMessages(agentId, sessionId);
      if (
        requestId !== requestIdRef.current
        || logicalKeyRef.current !== requestKey
      ) return;
      setQueue((current) => current.key === requestKey
        ? { ...current, messages: next, error: null }
        : current);
    } catch (reason) {
      if (
        requestId !== requestIdRef.current
        || logicalKeyRef.current !== requestKey
      ) return;
      logger.error('pending outgoing action failed', {
        agentId,
        sessionId,
        messageId: null,
        action: 'list',
        error: safeErrorKind(reason),
      });
      setQueue((current) => current.key === requestKey
        ? { ...current, error: '等待队列加载失败' }
        : current);
    }
  }, [agentId, logicalKey, sessionId]);

  useEffect(() => {
    setQueue(emptyQueueState(logicalKey));
    const off = window.api.onAgentEvent((event) => {
      if (event.agentId !== agentId || event.sessionId !== sessionId) return;
      const messageId = consumedMessageId(event, sessionId);
      const payload = event.payload as { error?: unknown } | null;
      if (event.kind === 'message') {
        if (messageId) {
          setQueue((current) => current.key === logicalKey
            ? {
                ...current,
                messages: current.messages.filter((message) => message.id !== messageId),
              }
            : current);
          void refresh();
        } else if (payload?.error === true) {
          void refresh();
        }
        return;
      }
      if (event.kind === 'finished' || event.kind === 'session-end') void refresh();
    });
    return () => {
      requestIdRef.current += 1;
      off();
    };
  }, [agentId, logicalKey, refresh, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshVersion]);

  const remove = async (messageId: string): Promise<void> => {
    const operationKey = logicalKey;
    setQueue((current) => current.key === operationKey
      ? { ...current, deleting: new Set(current.deleting).add(messageId) }
      : current);
    try {
      const removed = await window.api.deletePendingOutgoingMessage(
        agentId,
        sessionId,
        messageId,
      );
      if (logicalKeyRef.current !== operationKey) return;
      if (!removed) {
        setQueue((current) => current.key === operationKey
          ? { ...current, error: '消息已被模型提供方接收，不能再取消。' }
          : current);
      }
      await refresh();
    } catch (reason) {
      if (logicalKeyRef.current !== operationKey) return;
      logger.error('pending outgoing action failed', {
        agentId,
        sessionId,
        messageId,
        action: 'delete',
        error: safeErrorKind(reason),
      });
      setQueue((current) => current.key === operationKey
        ? { ...current, error: '删除等待消息失败' }
        : current);
    } finally {
      if (logicalKeyRef.current === operationKey) {
        setQueue((current) => {
          if (current.key !== operationKey) return current;
          const next = new Set(current.deleting);
          next.delete(messageId);
          return { ...current, deleting: next };
        });
      }
    }
  };

  return <PendingOutgoingQueueView
    messages={messages}
    error={error}
    deleting={deleting}
    onRemove={(messageId) => void remove(messageId)}
  />;
}

export function PendingOutgoingQueueView({
  messages,
  error,
  deleting,
  onRemove,
  removeDisabled = false,
}: {
  messages: readonly PendingOutgoingMessage[];
  error: string | null;
  deleting: ReadonlySet<string>;
  onRemove: (messageId: string) => void;
  removeDisabled?: boolean;
}): JSX.Element | null {
  if (messages.length === 0 && !error) return null;
  return (
    <section className="mb-1.5 rounded border border-status-waiting/25 bg-status-waiting/[0.06] p-1.5">
      <div className="mb-1 flex items-center justify-between gap-2 text-[9px] text-deck-muted">
        <span>等待模型提供方接收 · {messages.length}</span>
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
              {message.attachments.length > 0 ? `  · ${message.attachments.length} 个附件` : ''}
            </span>
            <button
              type="button"
              disabled={removeDisabled || deleting.has(message.id)}
              onClick={() => onRemove(message.id)}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-deck-muted hover:bg-white/10 hover:text-status-error disabled:opacity-40"
              aria-label="删除等待消息"
              title={removeDisabled ? '此 Remote Core 未提供等待队列删除能力' : '从等待队列删除'}
            >
              <CloseIcon className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
