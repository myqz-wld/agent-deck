import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';

import {
  browserStateSourceIdentity,
  sanitizedBrowserUrl,
  type BrowserAnnotationCapture,
  type BrowserPresentationLease,
  type BrowserStateSnapshot,
  type BrowserStateSource,
  type BrowserViewBounds,
} from '@shared/browser-view';
import { IabAnnotationCanvas } from './IabAnnotationCanvas';
import { useIabComposerTarget } from './iab-composer-bridge';

interface AnnotationDraft {
  readonly capture: BrowserAnnotationCapture;
  readonly targetKey: string;
}

interface PlacementRequest {
  readonly key: string;
  pending: boolean;
}

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

function sameBounds(left: BrowserViewBounds, right: BrowserViewBounds): boolean {
  return left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height;
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
  const [notice, setNotice] = useState<string | null>(null);
  const [closingTabId, setClosingTabId] = useState<number | null>(null);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [placementReady, setPlacementReady] = useState(false);
  const [annotation, setAnnotation] = useState<AnnotationDraft | null>(null);
  const [placementEpoch, setPlacementEpoch] = useState(0);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const leaseRef = useRef<BrowserPresentationLease | null>(null);
  const captureRequestRef = useRef(0);
  const selectedTabIdRef = useRef(selectedTabId);
  selectedTabIdRef.current = selectedTabId;
  const composerTarget = useIabComposerTarget();
  const composerTargetRef = useRef(composerTarget);
  composerTargetRef.current = composerTarget;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const beginRevisionRef = useRef<number | null>(null);
  const lastPlacementRef = useRef<string | null>(null);
  const placementRequestRef = useRef<PlacementRequest | null>(null);
  const selectedTab = useMemo(
    () => snapshot.tabs.find((tab) => tab.id === selectedTabId) ?? snapshot.tabs[0] ?? null,
    [selectedTabId, snapshot.tabs],
  );

  const restorePresentation = useCallback((message: string | null): void => {
    captureRequestRef.current += 1;
    setCaptureBusy(false);
    setPlacementReady(false);
    setAnnotation(null);
    setNotice(message);
    lastPlacementRef.current = null;
    placementRequestRef.current = null;
    setPlacementEpoch((value) => value + 1);
  }, []);

  useEffect(() => {
    if (activeId != null) setSelectedTabId(activeId);
  }, [activeId]);

  useEffect(() => {
    captureRequestRef.current += 1;
    beginRevisionRef.current = null;
    lastPlacementRef.current = null;
    setLeaseId(null);
    setCaptureBusy(false);
    setPlacementReady(false);
    setAnnotation(null);
    setError(null);
    setNotice(null);
    placementRequestRef.current = null;
  }, [sourceIdentity]);

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
    captureRequestRef.current += 1;
    const lease = leaseRef.current;
    leaseRef.current = null;
    placementRequestRef.current = null;
    if (lease != null) void window.api.parkBrowserPresentation({ leaseId: lease.leaseId });
  }, [sourceIdentity]);

  useEffect(() => {
    if (annotation == null) return;
    const capture = annotation.capture;
    const tab = snapshot.tabs.find((candidate) => candidate.id === capture.tabId);
    let reason: string | null = null;
    if (browserStateSourceIdentity(capture.source) !== sourceIdentity) {
      reason = 'IAB 来源已变化，未完成的标注已取消。';
    } else if (selectedTabId !== capture.tabId) {
      reason = 'IAB 标签已切换，未完成的标注已取消。';
    } else if (composerTarget.key !== annotation.targetKey || composerTarget.status !== 'supported') {
      reason = '当前会话的图片输入能力已变化，未完成的标注已取消。';
    } else if (snapshot.revision >= capture.snapshot.revision) {
      if (tab == null) {
        reason = '原 IAB 标签已关闭，未完成的标注已取消。';
      } else if (
        sanitizedBrowserUrl(tab.url) !== capture.url ||
        tab.viewportRevision !== capture.viewportRevision
      ) {
        reason = '页面内容或视口已变化，未完成的标注已取消。';
      }
    }
    if (reason != null) restorePresentation(reason);
  }, [annotation, composerTarget.key, composerTarget.status, restorePresentation,
    selectedTabId, snapshot.revision, snapshot.tabs, sourceIdentity]);

  useEffect(() => {
    const element = viewportRef.current;
    if (element == null || leaseId == null || selectedTabId == null) return;
    let disposed = false;
    let frame = 0;
    const place = (): void => {
      frame = 0;
      const bounds = integerBounds(element);
      if (bounds == null) {
        setPlacementReady(false);
        return;
      }
      if (annotation != null) {
        if (!sameBounds(bounds, annotation.capture.presentationBounds)) {
          restorePresentation('IAB 面板尺寸已变化，未完成的标注已取消。');
        }
        return;
      }
      const placementKey = JSON.stringify([leaseId, selectedTabId, bounds, placementEpoch]);
      if (placementKey === lastPlacementRef.current) {
        const request = placementRequestRef.current;
        if (request == null || request.key !== placementKey || !request.pending) {
          setPlacementReady(true);
        }
        return;
      }
      lastPlacementRef.current = placementKey;
      const request: PlacementRequest = { key: placementKey, pending: true };
      placementRequestRef.current = request;
      setPlacementReady(false);
      void window.api.updateBrowserPresentation({
        leaseId,
        tabId: selectedTabId,
        bounds,
      }).then(() => {
        request.pending = false;
        if (!disposed && placementRequestRef.current === request) setPlacementReady(true);
      }).catch(() => {
        request.pending = false;
        if (disposed || placementRequestRef.current !== request) return;
        lastPlacementRef.current = null;
        setPlacementReady(false);
        setError('IAB 视图连接已失效，请重新打开此标签。');
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
  }, [annotation, leaseId, placementEpoch, restorePresentation, selectedTabId]);

  const selectTab = (tabId: number): void => {
    if (tabId !== selectedTabId && annotation != null) {
      restorePresentation('IAB 标签已切换，未完成的标注已取消。');
    }
    placementRequestRef.current = null;
    lastPlacementRef.current = null;
    setPlacementReady(false);
    setSelectedTabId(tabId);
    setError(null);
  };

  const beginAnnotation = async (): Promise<void> => {
    const selectedId = selectedTab?.id;
    const currentLease = leaseRef.current;
    if (
      captureBusy || selectedId == null || currentLease == null ||
      !placementReady || composerTarget.status !== 'supported'
    ) return;
    const requestId = captureRequestRef.current + 1;
    captureRequestRef.current = requestId;
    setCaptureBusy(true);
    setError(null);
    setNotice(null);
    try {
      const capture = await window.api.captureBrowserAnnotation({
        leaseId: currentLease.leaseId,
        tabId: selectedId,
      });
      const currentTarget = composerTargetRef.current;
      if (
        captureRequestRef.current !== requestId ||
        leaseRef.current?.leaseId !== currentLease.leaseId ||
        selectedTabIdRef.current !== selectedId ||
        currentTarget.key !== composerTarget.key || currentTarget.status !== 'supported'
      ) {
        lastPlacementRef.current = null;
        placementRequestRef.current = null;
        setPlacementReady(false);
        setPlacementEpoch((value) => value + 1);
        return;
      }
      setPlacementReady(false);
      setAnnotation({ capture, targetKey: currentTarget.key });
    } catch (cause) {
      if (captureRequestRef.current === requestId) {
        setError(cause instanceof Error ? cause.message : '无法创建 IAB 标注截图。');
      }
    } finally {
      if (captureRequestRef.current === requestId) setCaptureBusy(false);
    }
  };

  const completeAnnotation = async (file: File): Promise<boolean> => {
    const draft = annotation;
    const target = composerTargetRef.current;
    if (
      draft == null || target.status !== 'supported' || target.addPng == null ||
      target.key !== draft.targetKey
    ) return false;
    const completionGeneration = captureRequestRef.current;
    const added = await target.addPng(file);
    if (!added) return false;
    if (
      captureRequestRef.current === completionGeneration &&
      composerTargetRef.current.key === draft.targetKey
    ) {
      restorePresentation('标注图片已加入消息附件，请在下方补充文字后手动发送。');
    }
    return true;
  };

  const closeTab = (tabId: number): void => {
    if (leaseId == null || closingTabId != null) return;
    if (annotation != null) restorePresentation('IAB 标签已关闭，未完成的标注已取消。');
    setClosingTabId(tabId);
    void window.api.closeBrowserPresentationTab({ leaseId, tabId }).then((result) => {
      const next = result.snapshot?.tabs.find((tab) => tab.active)?.id ??
        result.snapshot?.tabs[0]?.id ?? null;
      placementRequestRef.current = null;
      lastPlacementRef.current = null;
      setPlacementReady(false);
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
              onClick={() => selectTab(tab.id)}
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
      <div className="flex shrink-0 items-center gap-2 border-b border-deck-border/40 bg-black/10 px-2 py-1 text-[9px] text-deck-muted">
        <span className="min-w-0 flex-1 truncate" title={selectedTab == null ? undefined : sanitizedBrowserUrl(selectedTab.url)}>
          {selectedTab == null ? 'about:blank' : sanitizedBrowserUrl(selectedTab.url)}
        </span>
        {composerTarget.status === 'supported' && (
          <button
            type="button"
            className="shrink-0 rounded border border-deck-border/60 px-1.5 py-0.5 text-[9px] text-deck-text hover:bg-white/10 disabled:opacity-40"
            disabled={leaseId == null || !placementReady || captureBusy || annotation != null}
            onClick={() => void beginAnnotation()}
          >
            {captureBusy ? '截图中…' : '标注'}
          </button>
        )}
      </div>
      {composerTarget.status !== 'supported' && (
        <div role="status" className="shrink-0 border-b border-deck-border/40 bg-white/[0.03] px-2 py-1 text-[9px] text-deck-muted" data-iab-annotation-reason>
          暂不可标注：{composerTarget.reason}
        </div>
      )}
      {error && (
        <div role="status" className="shrink-0 border-b border-amber-400/15 bg-amber-500/10 px-2 py-1 text-[9px] text-amber-100">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="shrink-0 border-b border-emerald-400/15 bg-emerald-500/10 px-2 py-1 text-[9px] text-emerald-100">
          {notice}
        </div>
      )}
      <div ref={viewportRef} className="min-h-0 min-w-0 flex-1 bg-white" data-iab-viewport>
        {annotation != null && (
          <IabAnnotationCanvas
            capture={annotation.capture}
            onCancel={() => restorePresentation('已取消 IAB 标注，未添加任何附件。')}
            onComplete={completeAnnotation}
          />
        )}
      </div>
    </section>
  );
}
