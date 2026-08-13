import { useCallback, useEffect, useRef, useState } from 'react';

import type { RemoteHostSessionMessagesDto } from '@shared/remote-host';
import type { SessionDetailTabId } from '@renderer/components/SessionDetail/SessionDetailShell';
import type { RemoteSessionSourceView } from './source-types';
import { useRemoteConnectionScope } from './use-remote-connection-scope';

interface TabValue<T> {
  key: string;
  value: T | null;
  loading: boolean;
  error: string | null;
}

function empty<T>(key: string): TabValue<T> {
  return { key, value: null, loading: false, error: null };
}

export interface RemoteSessionTabData {
  messages: TabValue<RemoteHostSessionMessagesDto>;
  refreshMessages(): void;
}

/** Lazily reads only the active detail tab and coalesces same-identity revision bursts. */
export function useRemoteSessionTabData(
  source: RemoteSessionSourceView,
  activeTab: SessionDetailTabId,
): RemoteSessionTabData {
  const session = source.selectedSession?.id === source.selectedSessionId
    ? source.selectedSession : null;
  const connectionScope = useRemoteConnectionScope(source.identity, source.usable);
  const baseKey = session && source.profile
    ? `${connectionScope}\0${session.id}` : `${connectionScope}\0`;
  const currentBaseRef = useRef(baseKey);
  currentBaseRef.current = baseKey;
  const flights = useRef(new Map<string, Promise<void>>());
  const dirty = useRef(new Set<string>());
  const [retryVersion, setRetryVersion] = useState(0);
  const [messages, setMessages] = useState<TabValue<RemoteHostSessionMessagesDto>>(
    () => empty(baseKey),
  );

  useEffect(() => {
    setMessages(empty(baseKey));
  }, [baseKey]);

  const schedule = useCallback((): void => {
    if (!source.usable || !session || !source.profile) return;
    if (!source.capabilities.has('sessions.messages.read')) return;
    const operationKey = `${baseKey}\0messages`;
    if (flights.current.has(operationKey)) {
      dirty.current.add(operationKey);
      return;
    }
    setMessages((current) => ({
      ...(current.key === baseKey ? current : empty(baseKey)),
      loading: true,
      error: null,
    }));
    const request = window.api.listRemoteHostSessionMessages({
      profileId: source.profile.id,
      sessionId: session.id,
      limit: 100,
    });
    const flight = request.then((value) => {
      if (currentBaseRef.current !== baseKey) return;
      setMessages({
        key: baseKey,
        value,
        loading: false,
        error: null,
      });
    }).catch(() => {
      if (currentBaseRef.current !== baseKey) return;
      setMessages((current) => ({
        ...(current.key === baseKey ? current : empty(baseKey)),
        loading: false,
        error: '读取跨会话消息失败，请稍后重试。',
      }));
    }).finally(() => {
      flights.current.delete(operationKey);
      if (dirty.current.delete(operationKey) && currentBaseRef.current === baseKey) {
        setRetryVersion((value) => value + 1);
      }
    });
    flights.current.set(operationKey, flight);
  }, [baseKey, session, source.capabilities, source.profile, source.usable]);

  useEffect(() => {
    if (activeTab === 'messages') schedule();
  }, [activeTab, retryVersion, schedule, source.dataRevision]);

  return {
    messages: messages.key === baseKey ? messages : empty(baseKey),
    refreshMessages: schedule,
  };
}
