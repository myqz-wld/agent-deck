import { useLayoutEffect, type JSX } from 'react';

import { useDelayedAsyncFallback } from '@renderer/hooks/useDelayedAsyncFallback';
import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import { RemotePendingBucketSection } from './RemotePendingBucketSection';

export function RemotePendingTab({
  source,
  onOpenSession,
  onPresentationReadyChange,
}: {
  source: RemoteSessionSourceView;
  onOpenSession: (sid: string) => void;
  onPresentationReadyChange?: (ready: boolean) => void;
}): JSX.Element {
  const buckets = source.pendingBuckets;
  const showInitialLoading = useDelayedAsyncFallback(
    !source.pendingInitialized,
    `${source.identity}:pending-initial`,
  );
  const showRefreshProgress = useDelayedAsyncFallback(
    source.pendingInitialized && source.pendingLoading,
    `${source.identity}:pending-refresh`,
  );
  useLayoutEffect(() => {
    onPresentationReadyChange?.(source.pendingInitialized || showInitialLoading);
  }, [onPresentationReadyChange, showInitialLoading, source.pendingInitialized]);

  if (!source.capabilities.has('pending.index.read')) {
    return <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-deck-muted">当前远端版本无法列出全部待处理请求，请更新远端服务。</div>;
  }
  if (!source.pendingInitialized) {
    return showInitialLoading
      ? <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-deck-muted">正在读取远程待处理事项…</div>
      : <div className="h-full" aria-hidden="true" />;
  }
  if (showRefreshProgress && buckets.length === 0) {
    return <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-deck-muted">正在读取远程待处理事项…</div>;
  }
  if (source.pendingLoadError && buckets.length === 0) {
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[11px] text-status-waiting">
        <span>{source.pendingLoadError}</span>
        <button type="button" onClick={source.refresh} className="rounded border border-white/10 px-2 py-1 text-[10px] hover:bg-white/[0.05]">重试</button>
      </div>
    );
  }
  if (source.pendingTotal === null && buckets.length === 0) {
    return (
      <div
        role="status"
        className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[11px] text-deck-muted"
      >
        <span>远程待处理总数尚未确认。</span>
        <button
          type="button"
          onClick={source.refresh}
          className="rounded border border-white/10 px-2 py-1 text-[10px] hover:bg-white/[0.05]"
        >
          重新读取
        </button>
      </div>
    );
  }
  if (buckets.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center text-deck-muted">
        <div className="text-[12px]">没有待处理事项</div>
        <div className="text-[10px] leading-relaxed text-deck-muted/70">
          当前没有需要你授权、回答或确认的内容。
        </div>
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto scrollbar-deck px-3 py-2">
      <div className="mb-2 flex items-center justify-between text-[10px] text-deck-muted/75">
        <span>
          {source.pendingTotal === null
            ? `总数待确认 · 已载入 ${buckets.reduce((sum, bucket) => sum + bucket.pending.requests.length, 0)} 项`
            : `待处理 ${source.pendingTotal} 项`}
        </span>
        <span className={source.pendingScanTruncated
          ? 'text-amber-300/80'
          : showRefreshProgress
            ? 'text-deck-muted/70'
            : 'invisible text-deck-muted/70'}>
          {source.pendingScanTruncated ? '结果已按安全上限截断' : '刷新中…'}
        </span>
      </div>
      <ol className="flex flex-col gap-3">
        {buckets.map((bucket) => (
          <RemotePendingBucketSection
            key={`${source.identity}:${bucket.session.id}`}
            bucket={bucket}
            source={source}
            onOpenSession={onOpenSession}
          />
        ))}
      </ol>
      {source.hasMorePending && (
        <button
          type="button"
          disabled={source.pendingPaginationBusy}
          onClick={() => void source.loadMorePending()}
          className="mt-3 w-full rounded border border-dashed border-white/10 px-3 py-2 text-[10px] text-deck-muted hover:bg-white/[0.04] disabled:opacity-40"
        >
          加载更多待处理会话
        </button>
      )}
      {source.pendingLoadError && (
        <div role="alert" className="mt-2 rounded bg-red-500/10 px-2 py-1 text-[10px] text-red-200">{source.pendingLoadError}</div>
      )}
    </div>
  );
}
