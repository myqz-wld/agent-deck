import { createContext, useContext } from 'react';
import { FAST_ASYNC_FALLBACK_GRACE_MS, useDelayedAsyncFallback } from '@renderer/hooks/useDelayedAsyncFallback';

const Context = createContext<number | undefined>(undefined);
export const DiffLoadingDeadlineProvider = Context.Provider;

/** Payload reads and editor initialization share one grace period when the caller supplies it. */
export function useDiffLoadingFallback(pending: boolean, identity: string): boolean {
  const deadline = useContext(Context);
  const delay = deadline === undefined ? FAST_ASYNC_FALLBACK_GRACE_MS : Math.max(0, deadline - Date.now());
  const delayed = useDelayedAsyncFallback(pending, identity, delay);
  return pending && (deadline !== undefined && deadline <= Date.now() || delayed);
}
