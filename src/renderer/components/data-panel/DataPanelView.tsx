import { useMemo, type JSX } from 'react';
import type { ProviderUsageSnapshot, ProviderUsageWindow, TokenDailyRow, TokenRateRow } from '@shared/types';
import { normalizeModel, WINDOW_MS } from '@shared/model-normalize';
import { buildFreshLiveByBucket, rankLiveAwareBuckets, type LiveRateEntry } from '../../lib/live-rate';
import { RefreshIcon } from '../icons';
import { formatTokenCount, TokenTotalCard } from './TokenTotalCard';

interface DataPanelViewProps {
  rates: TokenRateRow[];
  ratesLoading: boolean;
  ratesError: string | null;
  liveBySession: Record<string, LiveRateEntry>;
  rateDescription: string;
  daily: TokenDailyRow[];
  today: string | null;
  dailyLoading: boolean;
  dailyError: string | null;
  dailyTruncated: boolean;
  usageSnapshots: ProviderUsageSnapshot[];
  usageFetchedAt: number | null;
  usageLoading: boolean;
  usageError: string | null;
  onRefreshProviders(force: boolean): Promise<void>;
}

export function DataPanelView(props: DataPanelViewProps): JSX.Element {
  const liveRates = useMemo(() => {
    const freshLive = buildFreshLiveByBucket(props.liveBySession, Date.now());
    const rateByBucket = new Map(
      props.rates.map((row) => [row.bucketKey, row.outputTokens / (WINDOW_MS / 1000)]),
    );
    return rankLiveAwareBuckets(freshLive, props.rates).map((bucketKey) => ({
      bucketKey,
      name: normalizeModel(bucketKey).displayName,
      tps: freshLive.get(bucketKey) ?? rateByBucket.get(bucketKey) ?? 0,
    })).filter((row) => row.tps > 0);
  }, [props.liveBySession, props.rates]);
  const totalTps = liveRates.reduce((sum, row) => sum + row.tps, 0);
  const totalsUnavailable = props.today === null || props.dailyLoading || props.dailyError !== null;
  const todayTotals = useMemo(
    () => totalsUnavailable
      ? emptyTotals()
      : sumRows(props.daily.filter((row) => row.day === props.today)),
    [props.daily, props.today, totalsUnavailable],
  );

  return (
    <div className="h-full overflow-y-auto scrollbar-deck px-3 py-2 text-[11px]">
      <section className="mb-3">
        <div className="mb-1 flex items-center gap-2 text-deck-muted">
          <span className="font-medium text-deck-text">额度窗口</span>
          <span className="text-[10px] text-deck-muted/70">当前窗口 / 周用量 / 重置时间</span>
          {props.usageFetchedAt !== null && (
            <span className="text-[10px] tabular-nums text-deck-muted/50">
              更新 {formatClock(props.usageFetchedAt)}
            </span>
          )}
          <div className="ml-auto flex min-w-0 items-center gap-2">
            {props.usageLoading && (
              <span className="shrink-0 text-[10px] text-deck-muted/60">
                {props.usageSnapshots.length > 0 ? '刷新中' : '读取中'}
              </span>
            )}
            {props.usageError && (
              <span className="truncate text-[10px] text-status-error">{props.usageError}</span>
            )}
            <button
              type="button"
              onClick={() => void props.onRefreshProviders(true)}
              disabled={props.usageLoading}
              className="shrink-0 rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-deck-muted transition hover:border-white/20 hover:text-deck-text disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshIcon className="mr-1 inline h-3 w-3" />刷新
            </button>
          </div>
        </div>
        {props.usageSnapshots.length > 0 ? (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            {props.usageSnapshots.map((snapshot) => (
              <ProviderUsageCard key={snapshot.provider} snapshot={snapshot} />
            ))}
          </div>
        ) : (
          <div className="text-[10px] text-deck-muted/60">
            {props.usageLoading ? '正在读取额度信息' : '暂无额度信息'}
          </div>
        )}
      </section>

      <section className="mb-3">
        <div className="mb-1 flex items-center gap-2 text-deck-muted">
          <span className="font-medium text-deck-text">实时输出速率</span>
          <span className="text-[10px] text-deck-muted/70">{props.rateDescription}</span>
          {totalTps > 0 && (
            <span className="ml-auto tabular-nums text-status-working">
              合计 {totalTps < 10 ? totalTps.toFixed(1) : Math.round(totalTps)} token/s
            </span>
          )}
        </div>
        {props.ratesError ? (
          <div className="text-[10px] text-status-error">{props.ratesError}</div>
        ) : liveRates.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {liveRates.map((row) => (
              <span key={row.bucketKey} className="flex items-center gap-1 rounded bg-white/[0.06] px-2 py-0.5">
                <span className="text-deck-text/80">{row.name}</span>
                <span className="tabular-nums text-status-working">
                  {row.tps < 10 ? row.tps.toFixed(1) : Math.round(row.tps)}
                </span>
                <span className="text-deck-muted/60">token/s</span>
              </span>
            ))}
          </div>
        ) : (
          <div className="text-[10px] text-deck-muted/60">
            {props.ratesLoading ? '正在读取输出速率' : '当前 60 秒内无输出'}
          </div>
        )}
      </section>

      <section className="mb-3">
        <div className="mb-1 flex items-center gap-2 text-deck-muted">
          <span className="font-medium text-deck-text">今日 Token</span>
          <span className="text-[10px] tabular-nums text-deck-muted/70">
            {props.today ?? (props.dailyError ? '读取失败' : '读取中')}
          </span>
          <span className="ml-auto text-[10px] text-deck-muted/60">总量 / 分项</span>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <TokenTotalCard
            label="输入总量"
            value={todayTotals.inputTotal}
            details={[["缓存读", todayTotals.cacheRead], ["缓存写", todayTotals.cacheCreation]]}
          />
          <TokenTotalCard
            label="输出总量"
            value={todayTotals.output}
            details={[["推理", todayTotals.reasoning]]}
          />
        </div>
        <div className="mt-1.5 text-[10px] leading-4 text-deck-muted/60">
          <span className="text-deck-muted/80">统计规则：</span>
          输入总量已包含缓存读/写，输出总量已包含推理；标记为“其中”的分项不要再次相加。
          provider 没有单独提供的字段显示为“—”，不会按 0 计入。
        </div>
      </section>

      <section>
        <div className="mb-1 flex items-baseline gap-2">
          <span className="font-medium text-deck-text">每模型每天明细</span>
          <span className="text-[10px] text-deck-muted/60">“其中”已计入左侧总量</span>
        </div>
        {props.daily.length > 0 ? <DailyTable rows={props.daily} /> : (
          <div className="text-[10px] text-deck-muted/60">
            {props.dailyLoading ? '正在读取使用记录' : props.dailyError ? '使用记录读取失败' : '暂无使用记录'}
          </div>
        )}
        {props.dailyError && (
          <div className="mt-1 text-[10px] text-status-error">{props.dailyError}</div>
        )}
        {props.dailyTruncated && (
          <div className="mt-1 text-[10px] text-deck-muted/60">
            远程历史记录已达到单次读取上限，仅显示最近的有界结果。
          </div>
        )}
      </section>
    </div>
  );
}

function DailyTable({ rows }: { rows: TokenDailyRow[] }): JSX.Element {
  return (
    <div className="overflow-x-auto rounded border border-white/[0.06] scrollbar-deck">
      <table className="min-w-[720px] w-full border-collapse text-[10px]">
        <thead>
          <tr className="border-b border-white/[0.08] text-center text-deck-muted">
            <th rowSpan={2} className="py-1.5 pl-2 pr-2 text-left font-medium">日期</th>
            <th rowSpan={2} className="py-1.5 pr-2 text-left font-medium">模型</th>
            <th colSpan={3} className="border-l border-white/[0.06] py-1.5 font-medium">输入总量</th>
            <th colSpan={2} className="border-l border-white/[0.06] py-1.5 font-medium">输出总量</th>
          </tr>
          <tr className="border-b border-white/10 text-right text-deck-muted">
            <th className="border-l border-white/[0.06] px-2 py-1 font-medium">总量</th>
            <th className="px-2 py-1 font-medium">其中缓存读</th>
            <th className="px-2 py-1 font-medium">其中缓存写</th>
            <th className="border-l border-white/[0.06] px-2 py-1 font-medium">总量</th>
            <th className="py-1 pl-2 pr-2 font-medium">其中推理</th>
          </tr>
        </thead>
        <tbody>{rows.map((row) => <DailyRow key={`${row.day}::${row.bucketKey}`} row={row} />)}</tbody>
      </table>
    </div>
  );
}

function DailyRow({ row }: { row: TokenDailyRow }): JSX.Element {
  return (
    <tr className="border-b border-white/[0.04] text-deck-text/90 odd:bg-white/[0.012]">
      <td className="py-1.5 pl-2 pr-2 tabular-nums text-deck-muted">{row.day}</td>
      <td className="py-1.5 pr-2">{normalizeModel(row.bucketKey).displayName}</td>
      <td className="border-l border-white/[0.04] px-2 py-1.5 text-right font-medium tabular-nums">{formatTokenCount(row.inputTotalTokens)}</td>
      <td className="px-2 py-1.5 text-right tabular-nums text-deck-muted">{formatTokenCount(row.cacheReadTokens)}</td>
      <td className="px-2 py-1.5 text-right tabular-nums text-deck-muted">{formatTokenCount(row.cacheCreationTokens)}</td>
      <td className="border-l border-white/[0.04] px-2 py-1.5 text-right font-medium tabular-nums">{formatTokenCount(row.outputTokens)}</td>
      <td className="py-1.5 pl-2 pr-2 text-right tabular-nums text-deck-muted">{formatTokenCount(row.reasoningTokens)}</td>
    </tr>
  );
}

function ProviderUsageCard({ snapshot }: { snapshot: ProviderUsageSnapshot }): JSX.Element {
  return (
    <div className="rounded bg-white/[0.04] px-2 py-2">
      <div className="flex items-center gap-2">
        <span className="font-medium text-deck-text">{snapshot.label}</span>
        <span className={`ml-auto rounded px-1.5 py-0.5 text-[10px] ${usageStatusClass(snapshot.status)}`}>
          {usageStatusText(snapshot.status)}
        </span>
      </div>
      {snapshot.status === 'ok' ? (
        <div className="mt-2 space-y-1.5">
          {snapshot.windows.map((window) => <ProviderUsageWindowRow key={window.id} window={window} />)}
        </div>
      ) : (
        <div className="mt-2 min-h-10 text-[10px] leading-4 text-deck-muted/70">
          {snapshot.message ?? '暂无可展示的额度信息'}
        </div>
      )}
      <div className="mt-1 text-[10px] tabular-nums text-deck-muted/50">更新 {formatClock(snapshot.updatedAt)}</div>
    </div>
  );
}

function ProviderUsageWindowRow({ window }: { window: ProviderUsageWindow }): JSX.Element {
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-deck-muted">{window.label}</span>
        <span className="ml-auto tabular-nums text-deck-text">{formatPercent(window.usedPercent)}</span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded bg-white/[0.08]">
        <div className="h-full rounded bg-status-working" style={{ width: usageBarWidth(window.usedPercent) }} />
      </div>
      <div className="mt-0.5 text-[10px] tabular-nums text-deck-muted/60">重置 {formatResetTime(window.resetsAt)}</div>
    </div>
  );
}

interface Totals {
  inputTotal: number | null;
  output: number | null;
  reasoning: number | null;
  cacheRead: number | null;
  cacheCreation: number | null;
}

function emptyTotals(): Totals {
  return { inputTotal: null, output: null, reasoning: null, cacheRead: null, cacheCreation: null };
}

function sumRows(rows: TokenDailyRow[]): Totals {
  return {
    inputTotal: sumExact(rows, (row) => row.inputTotalTokens, (row) => row.inputTotalApplicable),
    output: sumExact(rows, (row) => row.outputTokens, (row) => row.outputApplicable),
    reasoning: sumExact(rows, (row) => row.reasoningTokens, (row) => row.reasoningApplicable),
    cacheRead: sumExact(rows, (row) => row.cacheReadTokens, (row) => row.cacheReadApplicable),
    cacheCreation: sumExact(rows, (row) => row.cacheCreationTokens, (row) => row.cacheCreationApplicable),
  };
}

function sumExact(
  rows: TokenDailyRow[],
  select: (row: TokenDailyRow) => number | null,
  applicable: (row: TokenDailyRow) => boolean,
): number | null {
  if (rows.length === 0) return 0;
  let total = 0;
  let sawApplicable = false;
  for (const row of rows) {
    if (!applicable(row)) continue;
    sawApplicable = true;
    const value = select(row);
    if (value === null) return null;
    total += value;
  }
  return sawApplicable ? total : null;
}

function usageStatusText(status: ProviderUsageSnapshot['status']): string {
  if (status === 'ok') return '可用';
  if (status === 'not_subscribed') return '未订阅';
  if (status === 'unsupported') return '暂不支持';
  if (status === 'error') return '失败';
  return '暂不可读';
}

function usageStatusClass(status: ProviderUsageSnapshot['status']): string {
  if (status === 'ok') return 'bg-status-working/15 text-status-working';
  if (status === 'not_subscribed') return 'bg-amber-400/15 text-amber-200';
  if (status === 'error') return 'bg-status-error/15 text-status-error';
  return 'bg-white/[0.06] text-deck-muted';
}

function formatPercent(value: number | null): string {
  return value === null ? '未知' : `${Math.round(value).toLocaleString()}%`;
}

function usageBarWidth(value: number | null): string {
  return value === null ? '0%' : `${Math.max(0, Math.min(100, value))}%`;
}

function formatResetTime(value: string | null): string {
  if (!value) return '未知';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '未知';
  return date.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatClock(value: number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '未知';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
