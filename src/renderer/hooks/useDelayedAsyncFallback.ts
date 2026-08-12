import { useEffect, useState } from 'react';

/** Fast reads finish behind the current view; slower reads earn an explicit loading state. */
export const FAST_ASYNC_FALLBACK_GRACE_MS = 150;

export function useDelayedAsyncFallback(
  pending: boolean,
  identity: string,
  delayMs: number = FAST_ASYNC_FALLBACK_GRACE_MS,
): boolean {
  const [visibleIdentity, setVisibleIdentity] = useState<string | null>(null);

  useEffect(() => {
    if (!pending) {
      setVisibleIdentity(null);
      return;
    }
    setVisibleIdentity(null);
    const timer = window.setTimeout(() => setVisibleIdentity(identity), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, identity, pending]);

  return pending && visibleIdentity === identity;
}
