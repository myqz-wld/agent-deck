import { create } from 'zustand';

export interface ConfirmDialogOptions {
  title?: string;
  message?: string;
  detail?: string;
  okLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  signal?: AbortSignal;
}

export interface ConfirmationRequest extends Omit<ConfirmDialogOptions, 'signal'> {
  id: number;
}

export const useConfirmationStore = create<{ requests: ConfirmationRequest[] }>(() => ({
  requests: [],
}));

let nextId = 0;
const completions = new Map<number, (confirmed: boolean) => void>();

/** Resolve one explicit decision. Concurrent callers are presented in arrival order. */
export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  const { signal, ...content } = options;
  if (signal?.aborted) return Promise.resolve(false);
  const id = ++nextId;
  return new Promise((resolve) => {
    const abort = (): void => settleConfirmation(id, false);
    completions.set(id, (confirmed) => {
      signal?.removeEventListener('abort', abort);
      resolve(confirmed);
    });
    signal?.addEventListener('abort', abort, { once: true });
    useConfirmationStore.setState((state) => ({
      requests: [...state.requests, { ...content, id }],
    }));
  });
}

export function settleConfirmation(id: number, confirmed: boolean): void {
  const complete = completions.get(id);
  if (!complete) return;
  completions.delete(id);
  useConfirmationStore.setState((state) => ({
    requests: state.requests.filter((request) => request.id !== id),
  }));
  complete(confirmed);
}

export function cancelConfirmations(): void {
  for (const id of [...completions.keys()]) settleConfirmation(id, false);
}
