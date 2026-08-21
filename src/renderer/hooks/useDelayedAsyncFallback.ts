import { useEffect, useLayoutEffect, useState } from 'react';

/** Fast reads finish behind the current view; slower reads earn an explicit loading state. */
export const FAST_ASYNC_FALLBACK_GRACE_MS = 150;

export type InitialAsyncPresentation = 'deferred' | 'fallback' | 'ready';

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

/**
 * Keep the currently presented identity while a replacement is still pending.
 *
 * A fast replacement becomes visible atomically as soon as it settles. A slow replacement is
 * allowed through after the shared grace period so the destination can present its own loading
 * state. Unlike `useInitialAsyncPresentation`, this hook is for an already-mounted surface that
 * has useful content to retain during an identity switch.
 */
export function useDeferredPendingIdentity(
  pending: boolean,
  identity: string,
  delayMs: number = FAST_ASYNC_FALLBACK_GRACE_MS,
): string {
  const [visibleIdentity, setVisibleIdentity] = useState(identity);

  useLayoutEffect(() => {
    if (visibleIdentity === identity) return;
    if (!pending) {
      setVisibleIdentity(identity);
      return;
    }
    const timer = window.setTimeout(() => setVisibleIdentity(identity), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, identity, pending, visibleIdentity]);

  return visibleIdentity;
}

/**
 * Gate only the first unresolved projection for one exact identity.
 *
 * Once that identity settles it remains ready during later revalidation, allowing callers to keep
 * the last complete component mounted. An identity change resets the gate synchronously for the
 * render that observes it, so an old ready state cannot flash during reopen/source switches.
 */
export function useInitialAsyncPresentation(
  pending: boolean,
  identity: string,
  delayMs: number = FAST_ASYNC_FALLBACK_GRACE_MS,
): InitialAsyncPresentation {
  const [settledIdentity, setSettledIdentity] = useState<string | null>(
    pending ? null : identity,
  );
  const ready = !pending || settledIdentity === identity;

  useLayoutEffect(() => {
    if (!pending) {
      setSettledIdentity(identity);
      return;
    }
    setSettledIdentity((current) => (current === identity ? current : null));
  }, [identity, pending]);

  const showFallback = useDelayedAsyncFallback(!ready, identity, delayMs);
  if (ready) return 'ready';
  return showFallback ? 'fallback' : 'deferred';
}
