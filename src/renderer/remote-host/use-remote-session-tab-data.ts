import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  RemoteHostSessionMessagesDto,
  RemoteHostSessionPermissionsDto,
} from '@shared/remote-host';
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
  permissions: TabValue<RemoteHostSessionPermissionsDto>;
  messages: TabValue<RemoteHostSessionMessagesDto>;
  refreshPermissions(): void;
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
  const [permissions, setPermissions] = useState<TabValue<RemoteHostSessionPermissionsDto>>(
    () => empty(baseKey),
  );
  const [messages, setMessages] = useState<TabValue<RemoteHostSessionMessagesDto>>(
    () => empty(baseKey),
  );

  useEffect(() => {
    setPermissions(empty(baseKey));
    setMessages(empty(baseKey));
  }, [baseKey]);

  const schedule = useCallback((kind: 'messages' | 'permissions'): void => {
    if (!source.usable || !session || !source.profile) return;
    const capability = kind === 'permissions'
      ? 'sessions.permissions.read' : 'sessions.messages.read';
    if (!source.capabilities.has(capability)) return;
    const operationKey = `${baseKey}\0${kind}`;
    if (flights.current.has(operationKey)) {
      dirty.current.add(operationKey);
      return;
    }
    const update = kind === 'permissions' ? setPermissions : setMessages;
    update((current) => ({
      ...(current.key === baseKey ? current : empty(baseKey)),
      loading: true,
      error: null,
    }));
    const request = kind === 'permissions'
      ? window.api.getRemoteHostSessionPermissions({
          profileId: source.profile.id,
          sessionId: session.id,
          adapterId: session.adapterId as 'claude-code' | 'codex-cli' | 'grok-build',
        })
      : window.api.listRemoteHostSessionMessages({
          profileId: source.profile.id,
          sessionId: session.id,
          limit: 100,
        });
    const flight = request.then((value) => {
      if (currentBaseRef.current !== baseKey) return;
      if (kind === 'permissions') {
        setPermissions({
          key: baseKey,
          value: value as RemoteHostSessionPermissionsDto,
          loading: false,
          error: null,
        });
      } else {
        setMessages({
          key: baseKey,
          value: value as RemoteHostSessionMessagesDto,
          loading: false,
          error: null,
        });
      }
    }).catch(() => {
      if (currentBaseRef.current !== baseKey) return;
      const message = kind === 'permissions'
        ? '读取当前权限失败，请稍后重试。'
        : '读取跨会话消息失败，请稍后重试。';
      update((current) => ({
        ...(current.key === baseKey ? current : empty(baseKey)),
        loading: false,
        error: message,
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
    if (activeTab === 'permissions') schedule('permissions');
    if (activeTab === 'messages') schedule('messages');
  }, [activeTab, retryVersion, schedule, source.dataRevision]);

  return {
    permissions: permissions.key === baseKey ? permissions : empty(baseKey),
    messages: messages.key === baseKey ? messages : empty(baseKey),
    refreshPermissions: () => schedule('permissions'),
    refreshMessages: () => schedule('messages'),
  };
}
