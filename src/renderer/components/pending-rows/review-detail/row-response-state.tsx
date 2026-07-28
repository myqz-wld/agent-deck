import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
} from 'react';

export interface RowResponseResult<T> {
  ok: boolean;
  value?: T;
  error?: unknown;
}

interface ResponseState {
  requestKey: string;
  busy: boolean;
  error: string | null;
}

export function useRowResponseState(requestKey: string): {
  busy: boolean;
  error: string | null;
  run: <T>(
    action: () => Promise<T>,
    failureMessage: string,
  ) => Promise<RowResponseResult<T>>;
} {
  const [state, setState] = useState<ResponseState>({
    requestKey,
    busy: false,
    error: null,
  });
  const mountedRef = useRef(true);
  const requestKeyRef = useRef(requestKey);
  const operationRef = useRef(0);
  const busyRef = useRef(false);

  if (requestKeyRef.current !== requestKey) {
    requestKeyRef.current = requestKey;
    operationRef.current += 1;
    busyRef.current = false;
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationRef.current += 1;
    };
  }, []);

  const run = useCallback(async <T,>(
    action: () => Promise<T>,
    failureMessage: string,
  ): Promise<RowResponseResult<T>> => {
    if (busyRef.current) return { ok: false };
    busyRef.current = true;
    const operation = ++operationRef.current;
    setState({ requestKey, busy: true, error: null });
    try {
      const value = await action();
      const current =
        mountedRef.current
        && operationRef.current === operation
        && requestKeyRef.current === requestKey;
      if (current) {
        setState({ requestKey, busy: false, error: null });
      }
      return current ? { ok: true, value } : { ok: false };
    } catch (error) {
      const current =
        mountedRef.current
        && operationRef.current === operation
        && requestKeyRef.current === requestKey;
      if (current) {
        setState({ requestKey, busy: false, error: failureMessage });
      }
      return current ? { ok: false, error } : { ok: false };
    } finally {
      if (
        operationRef.current === operation
        && requestKeyRef.current === requestKey
      ) {
        busyRef.current = false;
      }
    }
  }, [requestKey]);

  return {
    busy: state.requestKey === requestKey ? state.busy : false,
    error: state.requestKey === requestKey ? state.error : null,
    run,
  };
}

export function RowResponseError({
  children,
}: {
  children: string | null | undefined;
}): JSX.Element | null {
  if (!children) return null;
  return (
    <div
      role="alert"
      className="mt-1.5 rounded border border-status-error/30 bg-status-error/10 px-2 py-1 text-[10px] text-status-error"
    >
      {children}
    </div>
  );
}
