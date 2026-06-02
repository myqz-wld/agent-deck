import { useEffect, useMemo, type JSX } from 'react';
import { useTokenUsageStore } from '../stores/token-usage-store';
import { useTokenRatesPoll } from '../hooks/use-token-rates-poll';
import { normalizeModel, WINDOW_MS } from '@shared/model-normalize';
import type { TokenDailyRow } from '@shared/types';

/**
 * 数据 tab：每模型每天 token 使用统计（plan model-token-stats-and-dashboard-20260602 §Phase 3 R5）。
 *
 * 需求2 + 追加：
 * - **顶部实时区**：全部 model bucket 的当前 token/s（非仅 Top3，与 header 同源 rates poll）。
 * - **今日汇总行**：今日各指标合计。
 * - **主体表格**：行 = model bucket（友好名）× 日期，列 = input/output/cacheRead/cacheCreation（无费用）。
 *
 * **刷新**：rates 走 poll（useTokenRatesPoll）；daily 走 push（onTokenUsageChanged debounce refetch）+
 * mount 拉一次（组件自订阅模式，与 IssuesPanel 同款，use-event-bridge 不动）。
 */

const DAILY_REFETCH_DEBOUNCE_MS = 500;

/** 大数字千分位；0 显示 '·' 弱化（避免满屏 0 干扰）。 */
function fmt(n: number): string {
  return n > 0 ? n.toLocaleString() : '·';
}

export function DataPanel(): JSX.Element {
  const rates = useTokenUsageStore((s) => s.rates);
  const daily = useTokenUsageStore((s) => s.daily);
  const setDaily = useTokenUsageStore((s) => s.setDaily);
  useTokenRatesPoll();

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

  // 实时区：全 bucket token/s（output ÷ 60），降序
  const liveRates = useMemo(
    () =>
      rates
        .map((r) => ({
          bucketKey: r.bucketKey,
          name: normalizeModel(r.bucketKey).displayName,
          tps: r.outputTokens / (WINDOW_MS / 1000),
        }))
        .filter((r) => r.tps > 0)
        .sort((a, b) => b.tps - a.tps),
    [rates],
  );
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
      {/* 顶部实时 token/s 区（全模型，与 header 同源） */}
      <section className="mb-3">
        <div className="mb-1 flex items-center gap-2 text-deck-muted">
          <span className="font-medium text-deck-text">实时输出速率</span>
          <span className="text-[10px] text-deck-muted/70">最近 {WINDOW_MS / 1000}s 滑动窗口</span>
          {totalTps > 0 && (
            <span className="ml-auto tabular-nums text-status-working">
              合计 {totalTps < 10 ? totalTps.toFixed(1) : Math.round(totalTps)} tok/s
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
                <span className="text-deck-muted/60">tok/s</span>
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
          <div className="text-[10px] text-deck-muted/60">暂无 token 使用记录</div>
        )}
      </section>
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
