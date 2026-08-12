import { useCallback, useEffect, useRef, useState, type JSX } from 'react';

import type { PendingOutgoingMessage } from '@shared/types';
import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import { PendingOutgoingQueueView } from './composer-sdk/PendingOutgoingQueue';

const EMPTY_DELETING = new Set<string>();

export function RemotePendingOutgoingQueue({
  source,
  adapterId,
  sessionId,
}: {
  source: RemoteSessionSourceView;
  adapterId: string;
  sessionId: string;
}): JSX.Element | null {
  const key = `${source.identity}\0${sessionId}`;
  const keyRef = useRef(key);
  keyRef.current = key;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const inFlight = useRef(new Set<string>());
  const dirty = useRef(new Set<string>());
  const [retryVersion, setRetryVersion] = useState(0);
  const [state, setState] = useState<{
    key: string;
    messages: PendingOutgoingMessage[];
    error: string | null;
    deleting: Set<string>;
  }>({ key, messages: [], error: null, deleting: new Set() });
  const current = state.key === key
    ? state
    : { key, messages: [], error: null, deleting: EMPTY_DELETING };
  const canRead = source.usable && source.capabilities.has('sessions.outgoing.read');
  const canRemove = source.usable && source.capabilities.has('sessions.outgoing.write');

  const refresh = useCallback(async (): Promise<void> => {
    if (!canRead || !['claude-code', 'codex-cli', 'grok-build'].includes(adapterId)) return;
    if (inFlight.current.has(key)) {
      dirty.current.add(key);
      return;
    }
    const operationKey = key;
    inFlight.current.add(operationKey);
    try {
      const result = await sourceRef.current.listOutgoing(
        adapterId as 'claude-code' | 'codex-cli' | 'grok-build',
      );
      if (keyRef.current !== operationKey) return;
      setState((previous) => ({
        key: operationKey,
        messages: result.messages,
        error: null,
        deleting: previous.key === operationKey ? previous.deleting : new Set(),
      }));
    } catch {
      if (keyRef.current === operationKey) {
        setState((previous) => ({
          ...(previous.key === operationKey ? previous : {
            key: operationKey, messages: [], deleting: new Set(),
          }),
          error: '等待队列加载失败',
        }));
      }
    } finally {
      inFlight.current.delete(operationKey);
      if (dirty.current.delete(operationKey) && keyRef.current === operationKey) {
        setRetryVersion((value) => value + 1);
      }
    }
  }, [adapterId, canRead, key]);

  useEffect(() => {
    setState({ key, messages: [], error: null, deleting: new Set() });
  }, [key]);
  useEffect(() => { void refresh(); }, [refresh, retryVersion, source.dataRevision]);

  const remove = async (messageId: string): Promise<void> => {
    if (!canRemove) return;
    const operationKey = key;
    setState((previous) => {
      const next = previous.key === operationKey ? new Set(previous.deleting) : new Set<string>();
      next.add(messageId);
      return {
        key: operationKey,
        messages: previous.key === operationKey ? previous.messages : [],
        error: null,
        deleting: next,
      };
    });
    try {
      const removed = await source.removeOutgoing(messageId);
      if (keyRef.current !== operationKey) return;
      if (!removed) {
        setState((previous) => ({
          ...previous,
          error: '消息已被模型提供方接收，不能再取消。',
        }));
      }
      await refresh();
    } catch {
      if (keyRef.current === operationKey) {
        setState((previous) => ({ ...previous, error: '删除等待消息失败' }));
      }
    } finally {
      if (keyRef.current === operationKey) {
        setState((previous) => {
          const deleting = new Set(previous.deleting);
          deleting.delete(messageId);
          return { ...previous, deleting };
        });
      }
    }
  };

  if (!canRead) return null;
  return (
    <PendingOutgoingQueueView
      messages={current.messages}
      error={current.error}
      deleting={current.deleting}
      onRemove={(messageId) => void remove(messageId)}
      removeDisabled={!canRemove}
    />
  );
}
