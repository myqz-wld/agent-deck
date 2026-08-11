import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';

/** Identity-fenced, concurrency-safe state for Remote user mutations. */
export function useRemoteBusinessRunner(
  identityRef: MutableRefObject<string>,
  setRevision: Dispatch<SetStateAction<number>>,
) {
  const tokens = useRef(new Set<symbol>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback((): void => {
    tokens.current.clear();
    setBusy(false);
    setError(null);
  }, []);

  const run = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
    const expectedIdentity = identityRef.current;
    const token = Symbol('remote-business');
    tokens.current.add(token);
    setBusy(true);
    setError(null);
    try {
      const result = await operation();
      if (identityRef.current !== expectedIdentity) throw new Error('数据源已切换，请重试。');
      setRevision((current) => current + 1);
      return result;
    } catch (reason) {
      if (identityRef.current === expectedIdentity) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
      throw reason;
    } finally {
      if (tokens.current.delete(token) && identityRef.current === expectedIdentity) {
        setBusy(tokens.current.size > 0);
      }
    }
  }, [identityRef, setRevision]);

  return { busy, error, reset, run, setError } as const;
}
