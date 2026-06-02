import { useEffect } from 'react';
import { useTokenUsageStore } from '../stores/token-usage-store';

/**
 * 周期拉取 token rates + topToday（plan model-token-stats-and-dashboard-20260602 §Phase 3 R2）。
 *
 * **为什么 poll 而非 push**：token/s 是 60s 滑动窗口速率 + 今日累计，属时间衰减量 —— 即使无新
 * token-usage 事件，旧 turn 也会随时间滑出窗口（速率应降），纯事件 push 不会触发这种衰减刷新。
 * 故走轮询，turn 完成 + 时间推进都能反映。daily 视图（不衰减、事件驱动）另走 onTokenUsageChanged
 * push，不在本 hook。
 *
 * **挂载即生效，卸载清 interval**：仅在 header / 数据页挂载时跑（caller 决定挂载点），避免全局常驻
 * （不放进 use-event-bridge 全局桥）。intervalMs 默认 2500ms，与「turn 完成即刷新（非秒级流式）」
 * 口径一致，主进程开销可控（单条 GROUP BY 走 idx_token_usage_bucket_ts）。
 *
 * 多处挂载安全：zustand store 单例，多个组件同时用本 hook 各自起 interval 各自 setRates，
 * 最后写入覆盖（值相同，无害）；正常只 header + 数据页两处，且数据页打开时 header 在 detail 下不显示。
 */
export function useTokenRatesPoll(intervalMs = 2500): void {
  const setRates = useTokenUsageStore((s) => s.setRates);
  const setTopToday = useTokenUsageStore((s) => s.setTopToday);

  useEffect(() => {
    let cancelled = false;
    const pull = (): void => {
      void window.api.tokenUsageRates().then((rows) => {
        if (!cancelled) setRates(rows);
      });
      void window.api.tokenUsageTopToday().then((rows) => {
        if (!cancelled) setTopToday(rows);
      });
    };
    pull(); // 立即拉一次，不等第一个 interval
    const timer = setInterval(pull, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [intervalMs, setRates, setTopToday]);
}
