import { useRef } from 'react';

import type { SessionCreationOptionsState } from './useSessionCreationOptions';
import { useDeferredPendingIdentity } from './useDelayedAsyncFallback';

interface Input<TAdapter> {
  scopeKey: string;
  adapterId: string;
  adapter: TAdapter | undefined;
  options: SessionCreationOptionsState;
}

export interface SessionCreationProjection<TAdapter> {
  adapterId: string;
  adapter: TAdapter | undefined;
  options: SessionCreationOptionsState;
  /** True while the prior adapter projection is intentionally retained. */
  deferred: boolean;
}

/**
 * Preserve the previous adapter projection for the shared fast-read grace.
 *
 * If the target adapter settles inside the grace, callers swap directly to its complete values.
 * If it remains pending, the target fallback/loading projection becomes visible at the boundary.
 */
export function useSessionCreationProjection<TAdapter>({
  scopeKey,
  adapterId,
  adapter,
  options,
}: Input<TAdapter>): SessionCreationProjection<TAdapter> {
  const targetIdentity = `${scopeKey}\u0000${adapterId}`;
  const visibleIdentity = useDeferredPendingIdentity(
    options.configurationLoading,
    targetIdentity,
  );
  const target: SessionCreationProjection<TAdapter> = {
    adapterId,
    adapter,
    options,
    deferred: false,
  };
  const lastVisible = useRef(target);
  const targetVisible = visibleIdentity === targetIdentity;

  if (targetVisible) {
    lastVisible.current = target;
    return target;
  }
  return { ...lastVisible.current, deferred: true };
}
