import { useCallback, useEffect, useMemo, useRef, type JSX } from 'react';
import { useTokenUsageStore } from '../stores/token-usage-store';
import { useTokenRatesPoll } from '../hooks/use-token-rates-poll';
import { PROVIDER_USAGE_RENDERER_STALE_MS } from '../hooks/use-startup-data-preload';
import { buildFreshLiveByBucket, rankLiveAwareBuckets } from '../lib/live-rate';
import { normalizeModel, WINDOW_MS } from '@shared/model-normalize';
import type { ProviderUsageSnapshot, ProviderUsageWindow, TokenDailyRow } from '@shared/types';
import { RefreshIcon } from './icons';
import {
  formatTokenCount,
  TokenTotalCard,
} from './data-panel/TokenTotalCard';
import {
  requestTokenDailyRefresh,
  retainStrongTokenDailyRefresh,
} from '../lib/token-daily-refresh';
import type { RemoteUsageSourceView } from '../remote-host/use-remote-usage-source';

/**
 * 数据 tab：每模型每天 token 使用统计。
 *
 * 需求2 + 追加：
 * - **顶部实时区**：全部 model bucket 的当前 token/s（生成中 fresh live 估算优先，其次 60s 窗口）。
 * - **今日账本**：输入/输出总量 + 已包含的缓存/推理分项。
 * - **主体表格**：行 = model bucket（友好名）× 日期，列 = 输入/输出总量及其分项（无费用）。
 *
 * **刷新**：rates/live 走 useTokenRatesPoll；daily 由 App 级协调器订阅事件并串行刷新。
 */

export function DataPanel({
  remoteUsage = null,
}: {
  remoteUsage?: RemoteUsageSourceView | null;
}): JSX.Element {
  const localRates = useTokenUsageStore((s) => s.rates);
  const localLiveBySession = useTokenUsageStore((s) => s.liveBySession);
  const localDaily = useTokenUsageStore((s) => s.daily);
  const localUsageSnapshots = useTokenUsageStore((s) => s.providerUsageSnapshots);
  const localUsageFetchedAt = useTokenUsageStore((s) => s.providerUsageFetchedAt);
  const localUsageLoading = useTokenUsageStore((s) => s.providerUsageLoading);
  const localUsageError = useTokenUsageStore((s) => s.providerUsageError);
  const beginProviderUsageRequest = useTokenUsageStore((s) => s.beginProviderUsageRequest);
  const setProviderUsageSuccess = useTokenUsageStore((s) => s.setProviderUsageSuccess);
  const setProviderUsageError = useTokenUsageStore((s) => s.setProviderUsageError);
  const mountedRef = useRef(true);
  useTokenRatesPoll(true, 2500, remoteUsage === null);
  const rates = remoteUsage?.rates ?? localRates;
  const liveBySession = remoteUsage ? {} : localLiveBySession;
  const daily = remoteUsage?.daily ?? localDaily;
  const usageSnapshots = remoteUsage?.providerSnapshots ?? localUsageSnapshots;
  const usageFetchedAt = remoteUsage?.providerFetchedAt ?? localUsageFetchedAt;
  const usageLoading = remoteUsage?.providerLoading ?? localUsageLoading;
  const usageError = remoteUsage?.providerError ?? localUsageError;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (remoteUsage) return;
    const releaseStrongRefresh = retainStrongTokenDailyRefresh();
    requestTokenDailyRefresh(true);
    return releaseStrongRefresh;
  }, [remoteUsage]);

  useEffect(() => {
    if (!remoteUsage?.enabled) return;
    let cancelled = false;
    // DataPanel is a child of the Remote source hook. Defer the first reads until the current
    // passive-effect batch finishes so a profile-identity reset cannot invalidate them.
    void Promise.resolve().then(() => {
      if (cancelled) return;
      void remoteUsage.loadDaily();
      void remoteUsage.loadProviders(false);
    });
    return () => { cancelled = true; };
  }, [remoteUsage?.enabled, remoteUsage?.identity]);

  const fetchUsage = useCallback(
    async (opts: { showLoading: boolean; force?: boolean }): Promise<void> => {
      if (remoteUsage) {
        await remoteUsage.loadProviders(opts.force === true);
        return;
      }
      const requestId = beginProviderUsageRequest(opts.showLoading);
      try {
        const result = opts.force
          ? await window.api.providerUsageSnapshot({ force: true })
          : await window.api.providerUsageSnapshot();
        if (mountedRef.current) setProviderUsageSuccess(requestId, result.snapshots);
      } catch {
        if (mountedRef.current) {
          setProviderUsageError(requestId, '额度信息读取失败，请稍后重试');
        }
      }
    },
    [beginProviderUsageRequest, remoteUsage, setProviderUsageError, setProviderUsageSuccess],
  );

  useEffect(() => {
    if (remoteUsage) return;
    const cacheFresh =
      usageFetchedAt !== null && Date.now() - usageFetchedAt < PROVIDER_USAGE_RENDERER_STALE_MS;
    if (!cacheFresh) void fetchUsage({ showLoading: usageSnapshots.length === 0 });
  }, [fetchUsage, remoteUsage, usageFetchedAt, usageSnapshots.length]);

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
  const localToday = useMemo(() => {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  }, []);
  const today = remoteUsage ? remoteUsage.today : localToday;
  const todayTotals = useMemo(
    () => sumRows(today === null ? [] : daily.filter((row) => row.day === today)),
    [daily, today],
  );

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
              <RefreshIcon className="mr-1 inline h-3 w-3" />刷新
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

      {/* 今日 token 账本：沿用其他数据区块的开放式标题和轻量内容卡片 */}
      <section className="mb-3">
        <div className="mb-1 flex items-center gap-2 text-deck-muted">
          <span className="font-medium text-deck-text">今日 Token</span>
          <span className="text-[10px] tabular-nums text-deck-muted/70">{today ?? '读取中'}</span>
          <span className="ml-auto text-[10px] text-deck-muted/60">总量 / 分项</span>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <TokenTotalCard
            label="输入总量"
            value={todayTotals.inputTotal}
            details={[
              ['缓存读', todayTotals.cacheRead],
              ['缓存写', todayTotals.cacheCreation],
            ]}
          />
          <TokenTotalCard
            label="输出总量"
            value={todayTotals.output}
            details={[['推理', todayTotals.reasoning]]}
          />
        </div>
        <div className="mt-1.5 text-[10px] leading-4 text-deck-muted/60">
          <span className="text-deck-muted/80">统计规则：</span>
          输入总量已包含缓存读/写，输出总量已包含推理；标记为“其中”的分项不要再次相加。
          provider 没有单独提供的字段显示为“—”，不会按 0 计入。
        </div>
      </section>

      {/* 主体表格：模型 × 日期 × 总量 / 分项 */}
      <section>
        <div className="mb-1 flex items-baseline gap-2">
          <span className="font-medium text-deck-text">每模型每天明细</span>
          <span className="text-[10px] text-deck-muted/60">“其中”已计入左侧总量</span>
        </div>
        {daily.length > 0 ? (
          <div className="overflow-x-auto rounded border border-white/[0.06] scrollbar-deck">
            <table className="min-w-[720px] w-full border-collapse text-[10px]">
              <thead>
                <tr className="border-b border-white/[0.08] text-center text-deck-muted">
                  <th rowSpan={2} className="py-1.5 pl-2 pr-2 text-left font-medium">
                    日期
                  </th>
                  <th rowSpan={2} className="py-1.5 pr-2 text-left font-medium">
                    模型
                  </th>
                  <th colSpan={3} className="border-l border-white/[0.06] py-1.5 font-medium">
                    输入总量
                  </th>
                  <th colSpan={2} className="border-l border-white/[0.06] py-1.5 font-medium">
                    输出总量
                  </th>
                </tr>
                <tr className="border-b border-white/10 text-right text-deck-muted">
                  <th className="border-l border-white/[0.06] px-2 py-1 font-medium">总量</th>
                  <th className="px-2 py-1 font-medium">其中缓存读</th>
                  <th className="px-2 py-1 font-medium">其中缓存写</th>
                  <th className="border-l border-white/[0.06] px-2 py-1 font-medium">总量</th>
                  <th className="py-1 pl-2 pr-2 font-medium">其中推理</th>
                </tr>
              </thead>
              <tbody>
                {daily.map((row) => (
                  <tr
                    key={`${row.day}::${row.bucketKey}`}
                    className="border-b border-white/[0.04] text-deck-text/90 odd:bg-white/[0.012]"
                  >
                    <td className="py-1.5 pl-2 pr-2 tabular-nums text-deck-muted">{row.day}</td>
                    <td className="py-1.5 pr-2">{normalizeModel(row.bucketKey).displayName}</td>
                    <td className="border-l border-white/[0.04] px-2 py-1.5 text-right font-medium tabular-nums">
                      {formatTokenCount(rowInputTotal(row))}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-deck-muted">
                      {formatTokenCount(row.cacheReadTokens)}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-deck-muted">
                      {formatTokenCount(row.cacheCreationTokens)}
                    </td>
                    <td className="border-l border-white/[0.04] px-2 py-1.5 text-right font-medium tabular-nums">
                      {formatTokenCount(row.outputTokens)}
                    </td>
                    <td className="py-1.5 pl-2 pr-2 text-right tabular-nums text-deck-muted">
                      {formatTokenCount(row.reasoningTokens)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-[10px] text-deck-muted/60">
            {remoteUsage?.dailyLoading ? '正在读取使用记录' : '暂无使用记录'}
          </div>
        )}
        {remoteUsage?.dailyError && (
          <div className="mt-1 text-[10px] text-status-error">{remoteUsage.dailyError}</div>
        )}
        {remoteUsage?.dailyTruncated && (
          <div className="mt-1 text-[10px] text-deck-muted/60">
            远程历史记录已达到单次读取上限，仅显示最近的有界结果。
          </div>
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

function rowInputTotal(row: TokenDailyRow): number | null {
  return row.inputTotalTokens;
}

function sumRows(rows: TokenDailyRow[]): {
  inputTotal: number | null;
  output: number | null;
  reasoning: number | null;
  cacheRead: number | null;
  cacheCreation: number | null;
} {
  return {
    inputTotal: sumExact(
      rows,
      rowInputTotal,
      (row) => row.inputTotalApplicable,
    ),
    output: sumExact(
      rows,
      (row) => row.outputTokens,
      (row) => row.outputApplicable,
    ),
    reasoning: sumExact(
      rows,
      (row) => row.reasoningTokens,
      (row) => row.reasoningApplicable,
    ),
    cacheRead: sumExact(
      rows,
      (row) => row.cacheReadTokens,
      (row) => row.cacheReadApplicable,
    ),
    cacheCreation: sumExact(
      rows,
      (row) => row.cacheCreationTokens,
      (row) => row.cacheCreationApplicable,
    ),
  };
}

function sumExact(
  rows: TokenDailyRow[],
  select: (row: TokenDailyRow) => number | null,
  isApplicable: (row: TokenDailyRow) => boolean,
): number | null {
  if (rows.length === 0) return 0;
  let total = 0;
  let sawApplicable = false;
  for (const row of rows) {
    if (!isApplicable(row)) continue;
    sawApplicable = true;
    const value = select(row);
    if (value === null) return null;
    total += value;
  }
  return sawApplicable ? total : null;
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
