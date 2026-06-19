import { useCallback, useEffect, useMemo, useRef, type JSX } from 'react';
import { useTokenUsageStore } from '../stores/token-usage-store';
import { useTokenRatesPoll } from '../hooks/use-token-rates-poll';
import { PROVIDER_USAGE_RENDERER_STALE_MS } from '../hooks/use-startup-data-preload';
import { buildFreshLiveByBucket, rankLiveAwareBuckets } from '../lib/live-rate';
import { normalizeModel, WINDOW_MS } from '@shared/model-normalize';
import type { ProviderUsageSnapshot, ProviderUsageWindow, TokenDailyRow } from '@shared/types';

/**
 * 数据 tab：每模型每天 token 使用统计（plan model-token-stats-and-dashboard-20260602 §Phase 3 R5）。
 *
 * 需求2 + 追加：
 * - **顶部实时区**：全部 model bucket 的当前 token/s（生成中 fresh live 估算优先，其次 60s 窗口）。
 * - **今日汇总行**：今日各指标合计。
 * - **主体表格**：行 = model bucket（友好名）× 日期，列 = input/output/cacheRead/cacheCreation（无费用）。
 *
 * **刷新**：rates/live 走 useTokenRatesPoll；daily 走 onTokenUsageChanged debounce refetch + mount 拉一次
 * （组件自订阅模式，与 IssuesPanel 同款，use-event-bridge 不动）。
 */

const DAILY_REFETCH_DEBOUNCE_MS = 500;

/** 大数字千分位；0 显示 '·' 弱化（避免满屏 0 干扰）。 */
function fmt(n: number): string {
  return n > 0 ? n.toLocaleString() : '·';
}

export function DataPanel(): JSX.Element {
  const rates = useTokenUsageStore((s) => s.rates);
  const liveBySession = useTokenUsageStore((s) => s.liveBySession);
  const daily = useTokenUsageStore((s) => s.daily);
  const setDaily = useTokenUsageStore((s) => s.setDaily);
  const usageSnapshots = useTokenUsageStore((s) => s.providerUsageSnapshots);
  const usageFetchedAt = useTokenUsageStore((s) => s.providerUsageFetchedAt);
  const usageLoading = useTokenUsageStore((s) => s.providerUsageLoading);
  const usageError = useTokenUsageStore((s) => s.providerUsageError);
  const setProviderUsageLoading = useTokenUsageStore((s) => s.setProviderUsageLoading);
  const setProviderUsageSuccess = useTokenUsageStore((s) => s.setProviderUsageSuccess);
  const setProviderUsageError = useTokenUsageStore((s) => s.setProviderUsageError);
  const mountedRef = useRef(true);
  useTokenRatesPoll();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // daily：mount 拉一次 + 订阅 onTokenUsageChanged debounce refetch
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fetchDaily = (): void => {
      void window.api.tokenUsageDaily().then((rows) => {
        if (!cancelled) setDaily(rows);
      });
    };
    fetchDaily();
    const off = window.api.onTokenUsageChanged(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fetchDaily, DAILY_REFETCH_DEBOUNCE_MS);
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      off();
    };
  }, [setDaily]);

  const fetchUsage = useCallback(
    async (opts: { showLoading: boolean; force?: boolean }): Promise<void> => {
      if (opts.showLoading) setProviderUsageLoading(true);
      try {
        const result = opts.force
          ? await window.api.providerUsageSnapshot({ force: true })
          : await window.api.providerUsageSnapshot();
        if (mountedRef.current) setProviderUsageSuccess(result.snapshots);
      } catch {
        if (mountedRef.current) setProviderUsageError('额度信息读取失败，请稍后重试');
      } finally {
        if (opts.showLoading && mountedRef.current) setProviderUsageLoading(false);
      }
    },
    [setProviderUsageError, setProviderUsageLoading, setProviderUsageSuccess],
  );

  useEffect(() => {
    const cacheFresh =
      usageFetchedAt !== null && Date.now() - usageFetchedAt < PROVIDER_USAGE_RENDERER_STALE_MS;
    if (!cacheFresh) void fetchUsage({ showLoading: usageSnapshots.length === 0 });
  }, [fetchUsage, usageFetchedAt, usageSnapshots.length]);

  // 实时区：全 bucket token/s，生成中 fresh live 估算优先，降序
  const liveRates = useMemo(() => {
    const freshLiveByBucket = buildFreshLiveByBucket(liveBySession, Date.now());
    const rateByBucket = new Map(rates.map((r) => [r.bucketKey, r.outputTokens / (WINDOW_MS / 1000)]));
    return rankLiveAwareBuckets(freshLiveByBucket, rates)
      .map((bucketKey) => {
        const tps = freshLiveByBucket.get(bucketKey) ?? rateByBucket.get(bucketKey) ?? 0;
        return {
          bucketKey,
          name: normalizeModel(bucketKey).displayName,
          tps,
        };
      })
      .filter((r) => r.tps > 0);
  }, [liveBySession, rates]);
  const totalTps = liveRates.reduce((sum, r) => sum + r.tps, 0);

  // 今日汇总（daily 里 day === 本地今天的行）+ 全量汇总
  const todayStr = useMemo(() => {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  }, []);
  const todayTotals = useMemo(() => sumRows(daily.filter((r) => r.day === todayStr)), [daily, todayStr]);

  return (
    <div className="h-full overflow-y-auto scrollbar-deck px-3 py-2 text-[11px]">
      {/* 订阅额度窗口 */}
      <section className="mb-3">
        <div className="mb-1 flex items-center gap-2 text-deck-muted">
          <span className="font-medium text-deck-text">额度窗口</span>
          <span className="text-[10px] text-deck-muted/70">当前窗口 / 周用量 / 重置时间</span>
          {usageFetchedAt !== null && (
            <span className="text-[10px] tabular-nums text-deck-muted/50">
              更新 {formatClock(usageFetchedAt)}
            </span>
          )}
          <div className="ml-auto flex min-w-0 items-center gap-2">
            {usageLoading && (
              <span className="shrink-0 text-[10px] text-deck-muted/60">
                {usageSnapshots.length > 0 ? '刷新中' : '读取中'}
              </span>
            )}
            {usageError && (
              <span className="truncate text-[10px] text-status-error">{usageError}</span>
            )}
            <button
              type="button"
              onClick={() => void fetchUsage({ showLoading: true, force: true })}
              disabled={usageLoading}
              className="shrink-0 rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-deck-muted transition hover:border-white/20 hover:text-deck-text disabled:cursor-not-allowed disabled:opacity-50"
            >
              刷新
            </button>
          </div>
        </div>
        {usageSnapshots.length > 0 ? (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            {usageSnapshots.map((snapshot) => (
              <ProviderUsageCard key={snapshot.provider} snapshot={snapshot} />
            ))}
          </div>
        ) : (
          <div className="text-[10px] text-deck-muted/60">
            {usageLoading ? '正在读取额度信息' : '暂无额度信息'}
          </div>
        )}
      </section>

      {/* 顶部实时 token/s 区（全模型，与 header 同源） */}
      <section className="mb-3">
        <div className="mb-1 flex items-center gap-2 text-deck-muted">
          <span className="font-medium text-deck-text">实时输出速率</span>
          <span className="text-[10px] text-deck-muted/70">
            生成中实时估算 / 最近 {WINDOW_MS / 1000} 秒
          </span>
          {totalTps > 0 && (
            <span className="ml-auto tabular-nums text-status-working">
              合计 {totalTps < 10 ? totalTps.toFixed(1) : Math.round(totalTps)} token/s
            </span>
          )}
        </div>
        {liveRates.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {liveRates.map((r) => (
              <span
                key={r.bucketKey}
                className="flex items-center gap-1 rounded bg-white/[0.06] px-2 py-0.5"
              >
                <span className="text-deck-text/80">{r.name}</span>
                <span className="tabular-nums text-status-working">
                  {r.tps < 10 ? r.tps.toFixed(1) : Math.round(r.tps)}
                </span>
                <span className="text-deck-muted/60">token/s</span>
              </span>
            ))}
          </div>
        ) : (
          <div className="text-[10px] text-deck-muted/60">当前 60 秒内无输出</div>
        )}
      </section>

      {/* 今日汇总行 */}
      <section className="mb-3">
        <div className="mb-1 font-medium text-deck-text">今日汇总（{todayStr}）</div>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 tabular-nums text-deck-muted">
          <span>输入 <span className="text-deck-text">{fmt(todayTotals.input)}</span></span>
          <span>输出 <span className="text-deck-text">{fmt(todayTotals.output)}</span></span>
          <span>缓存读 <span className="text-deck-text">{fmt(todayTotals.cacheRead)}</span></span>
          <span>缓存写 <span className="text-deck-text">{fmt(todayTotals.cacheCreation)}</span></span>
        </div>
      </section>

      {/* 主体表格：模型 × 日期 × 4 指标 */}
      <section>
        <div className="mb-1 font-medium text-deck-text">每模型每天明细</div>
        {daily.length > 0 ? (
          <table className="w-full border-collapse text-[10px]">
            <thead>
              <tr className="border-b border-white/10 text-left text-deck-muted">
                <th className="py-1 pr-2 font-medium">日期</th>
                <th className="py-1 pr-2 font-medium">模型</th>
                <th className="py-1 pr-2 text-right font-medium">输入</th>
                <th className="py-1 pr-2 text-right font-medium">输出</th>
                <th className="py-1 pr-2 text-right font-medium">缓存读</th>
                <th className="py-1 text-right font-medium">缓存写</th>
              </tr>
            </thead>
            <tbody>
              {daily.map((row) => (
                <tr
                  key={`${row.day}::${row.bucketKey}`}
                  className="border-b border-white/[0.04] text-deck-text/90"
                >
                  <td className="py-1 pr-2 tabular-nums text-deck-muted">{row.day}</td>
                  <td className="py-1 pr-2">{normalizeModel(row.bucketKey).displayName}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{fmt(row.inputTokens)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums text-status-working">
                    {fmt(row.outputTokens)}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums">{fmt(row.cacheReadTokens)}</td>
                  <td className="py-1 text-right tabular-nums">{fmt(row.cacheCreationTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-[10px] text-deck-muted/60">暂无使用记录</div>
        )}
      </section>
    </div>
  );
}

function ProviderUsageCard({ snapshot }: { snapshot: ProviderUsageSnapshot }): JSX.Element {
  const badgeClass = usageStatusClass(snapshot.status);
  return (
    <div className="rounded bg-white/[0.04] px-2 py-2">
      <div className="flex items-center gap-2">
        <span className="font-medium text-deck-text">{snapshot.label}</span>
        <span className={`ml-auto rounded px-1.5 py-0.5 text-[10px] ${badgeClass}`}>
          {usageStatusText(snapshot.status)}
        </span>
      </div>
      {snapshot.status === 'ok' ? (
        <div className="mt-2 space-y-1.5">
          {snapshot.windows.map((window) => (
            <ProviderUsageWindowRow key={window.id} window={window} />
          ))}
        </div>
      ) : (
        <div className="mt-2 min-h-10 text-[10px] leading-4 text-deck-muted/70">
          {snapshot.message ?? '暂无可展示的额度信息'}
        </div>
      )}
      <div className="mt-1 text-[10px] tabular-nums text-deck-muted/50">
        更新 {formatClock(snapshot.updatedAt)}
      </div>
    </div>
  );
}

function ProviderUsageWindowRow({ window }: { window: ProviderUsageWindow }): JSX.Element {
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-deck-muted">{window.label}</span>
        <span className="ml-auto tabular-nums text-deck-text">
          {formatPercent(window.usedPercent)}
        </span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded bg-white/[0.08]">
        <div
          className="h-full rounded bg-status-working"
          style={{ width: usageBarWidth(window.usedPercent) }}
        />
      </div>
      <div className="mt-0.5 text-[10px] tabular-nums text-deck-muted/60">
        重置 {formatResetTime(window.resetsAt)}
      </div>
    </div>
  );
}

function sumRows(rows: TokenDailyRow[]): {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
} {
  return rows.reduce(
    (acc, r) => ({
      input: acc.input + r.inputTokens,
      output: acc.output + r.outputTokens,
      cacheRead: acc.cacheRead + r.cacheReadTokens,
      cacheCreation: acc.cacheCreation + r.cacheCreationTokens,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  );
}

function usageStatusText(status: ProviderUsageSnapshot['status']): string {
  switch (status) {
    case 'ok':
      return '可用';
    case 'not_subscribed':
      return '未订阅';
    case 'unsupported':
      return '暂不支持';
    case 'error':
      return '失败';
    case 'unavailable':
    default:
      return '暂不可读';
  }
}

function usageStatusClass(status: ProviderUsageSnapshot['status']): string {
  switch (status) {
    case 'ok':
      return 'bg-status-working/15 text-status-working';
    case 'not_subscribed':
      return 'bg-amber-400/15 text-amber-200';
    case 'unsupported':
      return 'bg-white/[0.06] text-deck-muted';
    case 'error':
      return 'bg-status-error/15 text-status-error';
    case 'unavailable':
    default:
      return 'bg-white/[0.06] text-deck-muted';
  }
}

function formatPercent(value: number | null): string {
  if (value === null) return '未知';
  return `${Math.round(value).toLocaleString()}%`;
}

function usageBarWidth(value: number | null): string {
  if (value === null) return '0%';
  const clamped = Math.max(0, Math.min(100, value));
  return `${clamped}%`;
}

function formatResetTime(value: string | null): string {
  if (!value) return '未知';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '未知';
  return date.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatClock(value: number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '未知';
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}
