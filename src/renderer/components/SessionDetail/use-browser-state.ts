import { useEffect, useMemo, useRef, useState } from 'react';

import {
  browserStateSourceIdentity,
  type BrowserStateSnapshot,
  type BrowserStateSource,
} from '@shared/browser-view';

export interface BrowserStateView {
  readonly snapshot: BrowserStateSnapshot | null;
  readonly loading: boolean;
  readonly error: string | null;
}

const EMPTY: BrowserStateView = Object.freeze({ snapshot: null, loading: false, error: null });

/** Source-qualified Browser metadata bridge; private owner ids never enter renderer state. */
export function useBrowserState(source: BrowserStateSource | null): BrowserStateView {
  const identity = source == null ? null : browserStateSourceIdentity(source);
  const stableSource = useMemo(() => source, [identity]);
  const [state, setState] = useState<BrowserStateView>(EMPTY);
  const latestRevision = useRef(0);

  useEffect(() => {
    if (stableSource == null || identity == null) {
      latestRevision.current = 0;
      setState(EMPTY);
      return;
    }
    const browserApi = window.api as Partial<typeof window.api>;
    if (
      typeof browserApi.onBrowserStateChanged !== 'function' ||
      typeof browserApi.getBrowserState !== 'function'
    ) {
      latestRevision.current = 0;
      setState(EMPTY);
      return;
    }
    let disposed = false;
    latestRevision.current = 0;
    setState({ snapshot: null, loading: true, error: null });
    const unsubscribe = browserApi.onBrowserStateChanged((event) => {
      if (browserStateSourceIdentity(event.source) !== identity) return;
      if (event.revision < latestRevision.current) return;
      latestRevision.current = event.revision;
      setState({ snapshot: event.snapshot, loading: false, error: null });
    });
    void browserApi.getBrowserState(stableSource).then((snapshot) => {
      if (disposed) return;
      if (snapshot != null && snapshot.revision >= latestRevision.current) {
        latestRevision.current = snapshot.revision;
        setState({ snapshot, loading: false, error: null });
        return;
      }
      setState((current) => ({ ...current, loading: false }));
    }).catch(() => {
      if (!disposed) {
        setState((current) => ({
          ...current,
          loading: false,
          error: '暂时无法读取 IAB 状态。',
        }));
      }
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [identity, stableSource]);

  return state;
}
