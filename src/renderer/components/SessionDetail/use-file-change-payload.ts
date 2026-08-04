import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FileChangePayload } from '@shared/types';

interface UseFileChangePayloadArgs {
  sessionId: string;
  workspaceKey: string;
  selectedChangeId: number | null;
}

export function useFileChangePayload({
  sessionId,
  workspaceKey,
  selectedChangeId,
}: UseFileChangePayloadArgs) {
  const [selectedPayload, setSelectedPayload] = useState<FileChangePayload | null>(null);
  const [payloadLoading, setPayloadLoading] = useState(false);
  const [payloadError, setPayloadError] = useState<string | null>(null);
  const generation = useRef(0);
  const cache = useRef(new Map<number, FileChangePayload>());

  useLayoutEffect(() => {
    generation.current += 1;
    cache.current.clear();
    setSelectedPayload(null);
    setPayloadLoading(false);
    setPayloadError(null);
  }, [sessionId, workspaceKey]);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    if (selectedChangeId == null) {
      setSelectedPayload(null);
      setPayloadLoading(false);
      setPayloadError(null);
      return;
    }
    const cached = cache.current.get(selectedChangeId);
    if (cached) {
      setSelectedPayload(cached);
      setPayloadLoading(false);
      setPayloadError(null);
      return;
    }
    setSelectedPayload(null);
    setPayloadLoading(true);
    setPayloadError(null);
    void window.api
      .getFileChange(sessionId, selectedChangeId)
      .then((payload) => {
        if (requestGeneration !== generation.current) return;
        if (!payload) {
          setPayloadError('找不到当前会话中的文件改动。');
          return;
        }
        cache.current.set(selectedChangeId, payload);
        setSelectedPayload(payload);
      })
      .catch(() => {
        if (requestGeneration === generation.current) {
          setPayloadError('无法加载所选文件改动。');
        }
      })
      .finally(() => {
        if (requestGeneration === generation.current) setPayloadLoading(false);
      });
  }, [selectedChangeId, sessionId, workspaceKey]);

  return { selectedPayload, payloadLoading, payloadError };
}
