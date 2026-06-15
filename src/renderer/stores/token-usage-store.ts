import { create } from 'zustand';
import type {
  ProviderUsageSnapshot,
  TokenRateRow,
  TokenDailyRow,
  TokenRateTickEvent,
} from '@shared/types';
import { LIVE_STALE_MS, type LiveRateEntry } from '../lib/live-rate';

/**
 * Token 使用统计 renderer store（plan model-token-stats-and-dashboard-20260602 §Phase 3 R1）。
 *
 * 持有三类只读视图数据，供 header（Top3 token/s）+ 数据 tab（实时区 + 表格）共享：
 * - **rates**：最近 60s 窗口各 bucket output 总量（token/s = out ÷ 60，渲染时算）
 * - **topToday**：今日各 bucket output 总量降序（header tooltip + 数据页今日汇总）
 * - **daily**：bucket × 本地日期 4 指标（数据 tab 表格）
 * - **liveBySession**：生成中 tok/s display-only 估算（不落库，turn 末清掉）
 * - **providerUsageSnapshots**：额度窗口快照（renderer 缓存，切走数据 tab 不清空）
 *
 * **刷新机制混合**（plan §Phase 3 R2）：
 * - rates / topToday 走 **poll + token-usage-changed 快速校准**（token/s 是时间衰减量，无新事件
 *   旧 turn 也会滑出窗口，纯 push 不触发衰减刷新）— useTokenRatesPoll hook 负责。
 * - daily 走 **push**（事件驱动不衰减）— 组件订阅 onTokenUsageChanged debounce refetch。
 * - providerUsageSnapshots 走 DataPanel 定时刷新 + main IPC TTL cache，失败时保留旧结果。
 *
 * 与 issues-store 同款 zustand 单 store + reducer setter pattern。
 */
interface TokenUsageState {
  rates: TokenRateRow[];
  topToday: TokenRateRow[];
  daily: TokenDailyRow[];
  liveBySession: Record<string, LiveRateEntry>;
  providerUsageSnapshots: ProviderUsageSnapshot[];
  providerUsageFetchedAt: number | null;
  providerUsageLoading: boolean;
  providerUsageError: string | null;
  setRates: (rows: TokenRateRow[]) => void;
  setTopToday: (rows: TokenRateRow[]) => void;
  setDaily: (rows: TokenDailyRow[]) => void;
  setProviderUsageLoading: (loading: boolean) => void;
  setProviderUsageSuccess: (snapshots: ProviderUsageSnapshot[]) => void;
  setProviderUsageError: (message: string) => void;
  applyLiveTick: (event: TokenRateTickEvent) => void;
}

export const useTokenUsageStore = create<TokenUsageState>((set) => ({
  rates: [],
  topToday: [],
  daily: [],
  liveBySession: {},
  providerUsageSnapshots: [],
  providerUsageFetchedAt: null,
  providerUsageLoading: false,
  providerUsageError: null,
  setRates: (rows) => set({ rates: rows }),
  setTopToday: (rows) => set({ topToday: rows }),
  setDaily: (rows) => set({ daily: rows }),
  setProviderUsageLoading: (loading) => set({ providerUsageLoading: loading }),
  setProviderUsageSuccess: (snapshots) =>
    set({
      providerUsageSnapshots: snapshots,
      providerUsageFetchedAt: Date.now(),
      providerUsageLoading: false,
      providerUsageError: null,
    }),
  setProviderUsageError: (message) =>
    set({
      providerUsageLoading: false,
      providerUsageError: message,
    }),
  applyLiveTick: (event) =>
    set((state) => {
      const now = Date.now();
      const next = { ...state.liveBySession };
      for (const [sessionId, entry] of Object.entries(next)) {
        if (now - entry.updatedAt > LIVE_STALE_MS) delete next[sessionId];
      }
      if (event.done) {
        delete next[event.sessionId];
      } else {
        next[event.sessionId] = {
          bucketKey: event.bucketKey,
          tps: event.tps,
          updatedAt: now,
        };
      }
      return { liveBySession: next };
    }),
}));
