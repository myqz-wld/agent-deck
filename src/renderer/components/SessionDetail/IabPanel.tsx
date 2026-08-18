import { useEffect, useMemo, useRef, useState, type JSX } from 'react';

import {
  browserStateSourceIdentity,
  type BrowserPresentationLease,
  type BrowserStateSnapshot,
  type BrowserStateSource,
  type BrowserViewBounds,
} from '@shared/browser-view';

function tabTitle(value: string): string {
  const title = value.trim() || '新标签页';
  return title.length > 80 ? `${title.slice(0, 79)}…` : title;
}

function integerBounds(element: HTMLElement): BrowserViewBounds | null {
  const rect = element.getBoundingClientRect();
  const bounds = {
    x: Math.max(0, Math.round(rect.x)),
    y: Math.max(0, Math.round(rect.y)),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
  };
  return bounds.width < 1 || bounds.height < 1 ? null : bounds;
}

export function IabPanel({
  source,
  snapshot,
}: {
  source: BrowserStateSource;
  snapshot: BrowserStateSnapshot;
}): JSX.Element {
  const sourceIdentity = browserStateSourceIdentity(source);
  const activeId = snapshot.tabs.find((tab) => tab.active)?.id ?? snapshot.tabs[0]?.id ?? null;
  const [selectedTabId, setSelectedTabId] = useState<number | null>(activeId);
  const [leaseId, setLeaseId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closingTabId, setClosingTabId] = useState<number | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const leaseRef = useRef<BrowserPresentationLease | null>(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const beginRevisionRef = useRef<number | null>(null);
  const lastPlacementRef = useRef<string | null>(null);

  useEffect(() => {
    if (activeId != null) setSelectedTabId(activeId);
  }, [activeId]);

  useEffect(() => {
    if (leaseRef.current != null || beginRevisionRef.current === snapshot.revision) return;
    let cancelled = false;
    beginRevisionRef.current = snapshot.revision;
    void window.api.beginBrowserPresentation({
      source: sourceRef.current,
      expectedRevision: snapshot.revision,
    }).then((lease) => {
      if (cancelled) {
        void window.api.parkBrowserPresentation({ leaseId: lease.leaseId });
        return;
      }
      leaseRef.current = lease;
      setLeaseId(lease.leaseId);
      setError(null);
    }).catch(() => {
      if (!cancelled) setError('IAB 状态刚刚发生变化，正在等待下一次刷新。');
    });
    return () => { cancelled = true; };
  }, [snapshot.revision, sourceIdentity]);

  useEffect(() => () => {
    const lease = leaseRef.current;
    leaseRef.current = null;
    if (lease != null) void window.api.parkBrowserPresentation({ leaseId: lease.leaseId });
  }, [sourceIdentity]);

  useEffect(() => {
    const element = viewportRef.current;
    if (element == null || leaseId == null || selectedTabId == null) return;
    let disposed = false;
    let frame = 0;
    const place = (): void => {
      frame = 0;
      const bounds = integerBounds(element);
      if (bounds == null) return;
      const placementKey = JSON.stringify([leaseId, selectedTabId, bounds]);
      if (placementKey === lastPlacementRef.current) return;
      lastPlacementRef.current = placementKey;
      void window.api.updateBrowserPresentation({
        leaseId,
        tabId: selectedTabId,
        bounds,
      }).catch(() => {
        if (!disposed) setError('IAB 视图连接已失效，请重新打开此标签。');
      });
    };
    const schedule = (): void => {
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [leaseId, selectedTabId]);

  const selectedTab = useMemo(
    () => snapshot.tabs.find((tab) => tab.id === selectedTabId) ?? snapshot.tabs[0] ?? null,
    [selectedTabId, snapshot.tabs],
  );

  const closeTab = (tabId: number): void => {
    if (leaseId == null || closingTabId != null) return;
    setClosingTabId(tabId);
    void window.api.closeBrowserPresentationTab({ leaseId, tabId }).then((result) => {
      const next = result.snapshot?.tabs.find((tab) => tab.active)?.id ??
        result.snapshot?.tabs[0]?.id ?? null;
      setSelectedTabId(next);
      setError(null);
    }).catch(() => setError('关闭 IAB 标签失败，请稍后重试。'))
      .finally(() => setClosingTabId(null));
  };

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col bg-deck-bg/70" data-iab-panel>
      <div className="flex shrink-0 items-stretch overflow-x-auto border-b border-deck-border/60 scrollbar-deck">
        {snapshot.tabs.map((tab) => (
          <div
            key={tab.id}
            className={`group flex min-w-[112px] max-w-[220px] items-center border-r border-deck-border/50 ${
              selectedTab?.id === tab.id ? 'bg-white/10' : 'bg-black/10 hover:bg-white/5'
            }`}
          >
            <button
              type="button"
              className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-[10px] text-deck-text"
              title={tab.title || tab.url}
              onClick={() => { setSelectedTabId(tab.id); setError(null); }}
            >
              {tabTitle(tab.title)}
            </button>
            <button
              type="button"
              className="mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded text-[12px] text-deck-muted opacity-70 hover:bg-white/10 hover:text-deck-text group-hover:opacity-100"
              aria-label={`关闭 ${tabTitle(tab.title)}`}
              disabled={closingTabId != null}
              onClick={() => closeTab(tab.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="shrink-0 truncate border-b border-deck-border/40 bg-black/10 px-2 py-1 text-[9px] text-deck-muted" title={selectedTab?.url}>
        {selectedTab?.url ?? 'about:blank'}
      </div>
      {error && (
        <div role="status" className="shrink-0 border-b border-amber-400/15 bg-amber-500/10 px-2 py-1 text-[9px] text-amber-100">
          {error}
        </div>
      )}
      <div ref={viewportRef} className="min-h-0 min-w-0 flex-1 bg-white" data-iab-viewport />
    </section>
  );
}
