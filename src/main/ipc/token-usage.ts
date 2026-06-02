/**
 * Token 使用统计 IPC handlers（plan model-token-stats-and-dashboard-20260602 §Phase 2 Q3）。
 *
 * 3 个 channel 给 UI header Top3 + 数据 tab 用（agent 不消费，与采集/mcp 路径正交）：
 * - TokenUsageRates：最近 WINDOW_MS 窗口各 bucket output 总量（renderer 算 token/s）
 * - TokenUsageTopToday：今日各 bucket output 总量降序（Top3 + 数据页今日汇总）
 * - TokenUsageDaily：bucket × 本地日期 4 指标聚合（表格）
 *
 * **边界参数在本层（IPC handler）用本地 tz 算**（plan §不变量 F6）：startMs = 本地午夜 epoch ms，
 * sinceMs = now - WINDOW_MS。main 与 renderer 同机同 tz，与 repo dailyByModel 的 SQL
 * date(...,'localtime') 口径一致。repo 只收 epoch ms 参数。
 *
 * handler 全 named export（test 直接 import 验业务，与 issues.ts 同款 pattern）。
 */
import { IpcInvoke } from '@shared/ipc-channels';
import { WINDOW_MS } from '@shared/model-normalize';
import { tokenUsageRepo } from '@main/store/token-usage-repo';
import type { TokenRateRow, TokenDailyRow } from '@shared/types';
import { on } from './_helpers';

/** 本地午夜的 epoch ms（今日起点）。用本地 tz 而非 UTC，与 SQL date(...,'localtime') 对齐。 */
function startOfTodayLocalMs(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** 最近 WINDOW_MS 窗口各 bucket output 总量（renderer 算 token/s = out ÷ 窗口秒数）。 */
export function tokenUsageRatesHandler(): TokenRateRow[] {
  return tokenUsageRepo.ratesSince(Date.now() - WINDOW_MS);
}

/** 今日各 bucket output 总量降序（Top3 / 今日汇总）。 */
export function tokenUsageTopTodayHandler(): TokenRateRow[] {
  return tokenUsageRepo.today(startOfTodayLocalMs());
}

/** bucket × 本地日期 4 指标聚合（数据 tab 表格）。无参 = 全量历史。 */
export function tokenUsageDailyHandler(): TokenDailyRow[] {
  return tokenUsageRepo.dailyByModel();
}

export function registerTokenUsageIpc(): void {
  on(IpcInvoke.TokenUsageRates, () => tokenUsageRatesHandler());
  on(IpcInvoke.TokenUsageTopToday, () => tokenUsageTopTodayHandler());
  on(IpcInvoke.TokenUsageDaily, () => tokenUsageDailyHandler());
}
