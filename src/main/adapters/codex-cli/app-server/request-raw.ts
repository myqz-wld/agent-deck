import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export interface CodexPendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export function requestCodexRaw<T>(input: {
  child: ChildProcessWithoutNullStreams;
  pending: Map<number | string, CodexPendingRequest>;
  id: number;
  method: string;
  params: unknown;
  signal?: AbortSignal;
}): Promise<T> {
  const { child, pending, id, method, params, signal } = input;
  if (signal?.aborted) return Promise.reject(new Error('Codex request cancelled'));
  const message = JSON.stringify({ method, id, params });
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      if (!pending.delete(id)) return;
      try {
        child.stdin.write(`${JSON.stringify({ method: '$/cancel_request', params: { id } })}\n`);
      } catch {
        // ignore
      }
      reject(new Error('Codex request cancelled'));
    };
    const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
    pending.set(id, {
      resolve: (value) => { cleanup(); resolve(value as T); },
      reject: (error) => { cleanup(); reject(error); },
    });
    child.stdin.write(`${message}\n`, (err) => {
      if (!err) return;
      pending.delete(id);
      cleanup();
      reject(err);
    });
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
  });
}
