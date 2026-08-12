import { useSyncExternalStore } from 'react';
import { useSessionStore } from '@renderer/stores/session-store';
import type { SessionStoreState } from '@renderer/stores/session-store-state';

const noSubscribe = (): (() => void) => () => undefined;
const noState = (): null => null;

/** Remote mode has neither a Local-store subscription nor a Local snapshot read. */
export function useLocalSessionState(enabled: boolean): SessionStoreState | null {
  return useSyncExternalStore(
    enabled ? useSessionStore.subscribe : noSubscribe,
    enabled ? useSessionStore.getState : noState,
    noState,
  );
}
