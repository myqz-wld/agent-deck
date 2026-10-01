import { useEffect, useRef, useState } from 'react';
import type { FileChangePayload } from '@shared/types';
import { LOCAL_FILE_CHANGES, type FileChangeReader } from '../diff/file-change-reader';
import { RemoteReadCache } from '@shared/remote-read-cache';

interface UseFileChangePayloadArgs {
  sessionId: string;
  workspaceKey: string;
  selectedChangeId: number | null;
  reader?: FileChangeReader | null;
}

interface PayloadState {
  key: string;
  selectedPayload: FileChangePayload | null;
  payloadLoading: boolean;
  payloadError: string | null;
}

const MAX_CACHE_CHARS = 4 * 1024 * 1024;
type PayloadEntries = Map<number, { payload: FileChangePayload; size: number }>;
const retainedPayloads = new RemoteReadCache<PayloadEntries>(8);

/** Shared Local/Remote lazy read, bounded cache, and stale source/session protection. */
export function useFileChangePayload({
  sessionId, workspaceKey, selectedChangeId, reader = LOCAL_FILE_CHANGES,
}: UseFileChangePayloadArgs) {
  const identity = JSON.stringify([reader?.identity, sessionId, workspaceKey]);
  const key = JSON.stringify([identity, selectedChangeId]);
  const readerRef = useRef(reader);
  readerRef.current = reader;
  const cache = useRef({ identity, entries: retainedPayloads.get(identity) ?? new Map<number, { payload: FileChangePayload; size: number }>() });
  if (cache.current.identity !== identity) cache.current = { identity, entries: retainedPayloads.get(identity) ?? new Map() };
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PayloadState>({
    key: '', selectedPayload: null, payloadLoading: false, payloadError: null,
  });

  useEffect(() => {
    let disposed = false;
    const read = readerRef.current;
    const empty = { key, selectedPayload: null, payloadLoading: false, payloadError: null };
    if (selectedChangeId === null) { setState(empty); return; }
    if (!read) { setState({ ...empty, payloadError: '此来源暂不支持读取文件改动。' }); return; }
    const entries = cache.current.entries;
    const cached = entries.get(selectedChangeId);
    if (cached) {
      entries.delete(selectedChangeId);
      entries.set(selectedChangeId, cached);
      setState({ ...empty, selectedPayload: cached.payload });
      return;
    }
    setState({ ...empty, payloadLoading: true });
    void Promise.resolve().then(() => read.read(sessionId, selectedChangeId)).then((payload) => {
      if (disposed) return;
      if (!payload || payload.sessionId !== sessionId || payload.id !== selectedChangeId) {
        setState({ ...empty, payloadError: '找不到当前会话中的文件改动。' });
        return;
      }
      const size = [payload.beforeBlob, payload.afterBlob, payload.beforeSnapshot, payload.afterSnapshot,
        JSON.stringify(payload.metadata)].reduce<number>((total, text) => total + (text?.length ?? 0), 0);
      if (size <= MAX_CACHE_CHARS) {
        entries.set(selectedChangeId, { payload, size });
        let total = [...entries.values()].reduce((sum, item) => sum + item.size, 0);
        while (entries.size > 8 || total > MAX_CACHE_CHARS) {
          const oldest = entries.keys().next().value!;
          total -= entries.get(oldest)!.size;
          entries.delete(oldest);
        }
        retainedPayloads.set(identity, entries);
      }
      setState({ ...empty, selectedPayload: payload });
    }).catch((error: unknown) => {
      if (!disposed) setState({ ...empty,
        payloadError: read.identity !== 'local' && error instanceof Error ? error.message : '无法加载所选文件改动。' });
    });
    return () => { disposed = true; };
  }, [identity, key, sessionId, selectedChangeId, attempt]);

  const visible = state.key === key ? state : {
    selectedPayload: null, payloadLoading: selectedChangeId !== null, payloadError: null,
  };
  return { ...visible, retryPayload: () => setAttempt((value) => value + 1) };
}
