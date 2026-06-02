import { create } from 'zustand';
import type { TokenRateRow, TokenDailyRow } from '@shared/types';

/**
 * Token 使用统计 renderer store（plan model-token-stats-and-dashboard-20260602 §Phase 3 R1）。
 *
 * 持有三类只读视图数据，供 header（Top3 token/s）+ 数据 tab（实时区 + 表格）共享：
 * - **rates**：最近 60s 窗口各 bucket output 总量（token/s = out ÷ 60，渲染时算）
 * - **topToday**：今日各 bucket output 总量降序（header Top3 取前 3 + 数据页今日汇总）
 * - **daily**：bucket × 本地日期 4 指标（数据 tab 表格）
 *
 * **刷新机制混合**（plan §Phase 3 R2）：
 * - rates / topToday 走 **poll**（token/s 是时间衰减量，无新事件旧 turn 也会滑出窗口，纯 push
 *   不触发衰减刷新）— useTokenRatesPoll hook 周期拉。
 * - daily 走 **push**（事件驱动不衰减）— 组件订阅 onTokenUsageChanged debounce refetch。
 *
 * 与 issues-store 同款 zustand 单 store + reducer setter pattern。
 */
interface TokenUsageState {
  rates: TokenRateRow[];
  topToday: TokenRateRow[];
  daily: TokenDailyRow[];
  setRates: (rows: TokenRateRow[]) => void;
  setTopToday: (rows: TokenRateRow[]) => void;
  setDaily: (rows: TokenDailyRow[]) => void;
}

export const useTokenUsageStore = create<TokenUsageState>((set) => ({
  rates: [],
  topToday: [],
  daily: [],
  setRates: (rows) => set({ rates: rows }),
  setTopToday: (rows) => set({ topToday: rows }),
  setDaily: (rows) => set({ daily: rows }),
}));
