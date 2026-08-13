import { useLayoutEffect, useState } from 'react';

import { useDelayedAsyncFallback } from '@renderer/hooks/useDelayedAsyncFallback';
import type { SessionDetailTabId } from './SessionDetailShell';

interface TabSelectionState {
  identity: string;
  activeTab: SessionDetailTabId;
  pendingTab: SessionDetailTabId | null;
}

interface DelayedTabSelection {
  activeTab: SessionDetailTabId;
  pendingTab: SessionDetailTabId | null;
  selectTab(next: SessionDetailTabId): void;
}

function initialState(identity: string, initialTab: SessionDetailTabId): TabSelectionState {
  return { identity, activeTab: initialTab, pendingTab: null };
}

/** Keep the current panel for the grace window, then atomically commit data or its loading state. */
export function useDelayedTabSelection({
  canDefer,
  deferredTab,
  identity,
  initialTab = 'activity',
  ready,
}: {
  canDefer: boolean;
  deferredTab: SessionDetailTabId;
  identity: string;
  initialTab?: SessionDetailTabId;
  ready: boolean;
}): DelayedTabSelection {
  const [state, setState] = useState<TabSelectionState>(
    () => initialState(identity, initialTab),
  );
  const scoped = state.identity === identity ? state : initialState(identity, initialTab);
  const waiting = scoped.pendingTab === deferredTab && canDefer && !ready;
  const showFallback = useDelayedAsyncFallback(
    waiting,
    `${identity}:${deferredTab}`,
  );

  useLayoutEffect(() => {
    setState((current) => {
      const selected = current.identity === identity
        ? current
        : initialState(identity, initialTab);
      if (selected.pendingTab !== deferredTab) return selected;
      if (!ready && canDefer && !showFallback) return selected;
      return { ...selected, activeTab: deferredTab, pendingTab: null };
    });
  }, [canDefer, deferredTab, identity, initialTab, ready, showFallback]);

  return {
    activeTab: scoped.activeTab,
    pendingTab: scoped.pendingTab,
    selectTab: (next) => {
      setState((current) => {
        const selected = current.identity === identity
          ? current
          : initialState(identity, initialTab);
        if (next === deferredTab && canDefer && !ready) {
          return { ...selected, pendingTab: next };
        }
        return { ...selected, activeTab: next, pendingTab: null };
      });
    },
  };
}
