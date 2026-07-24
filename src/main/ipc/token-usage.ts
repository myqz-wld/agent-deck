/**
 * Token 使用统计 IPC handlers（plan model-token-stats-and-dashboard-20260602 §Phase 2 Q3）。
 *
 * 3 个 channel 给 UI header Top3 + 数据 tab 用（agent 不消费，与采集/mcp 路径正交）：
 * - TokenUsageRates：最近 WINDOW_MS 窗口各 bucket output 总量（renderer 算 token/s）
 * - TokenUsageTopToday：今日各 bucket output 总量降序（Top3 + 数据页今日汇总）
 * - TokenUsageDaily：bucket × 本地日期的统一 token 账本聚合（表格）
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
import type {
  TokenDailyRow,
  TokenRateRow,
  TokenUsageQueryOptions,
} from '@shared/types';
import { on } from './_helpers';
import { ensureGrokHistoryTokenUsage } from '@main/adapters/grok-build/history-usage';

/** 本地午夜的 epoch ms（今日起点）。用本地 tz 而非 UTC，与 SQL date(...,'localtime') 对齐。 */
function startOfTodayLocalMs(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** 最近 WINDOW_MS 窗口各 bucket output 总量（renderer 算 token/s = out ÷ 窗口秒数）。 */
export async function tokenUsageRatesHandler(
  options?: TokenUsageQueryOptions,
): Promise<TokenRateRow[]> {
  if (options?.includeGrokHistory) await ensureGrokHistoryTokenUsage();
  return tokenUsageRepo.ratesSince(Date.now() - WINDOW_MS);
}

/** 今日各 bucket output 总量降序（Top3 / 今日汇总）。 */
export async function tokenUsageTopTodayHandler(
  options?: TokenUsageQueryOptions,
): Promise<TokenRateRow[]> {
  if (options?.includeGrokHistory) await ensureGrokHistoryTokenUsage();
  return tokenUsageRepo.today(startOfTodayLocalMs());
}

/** bucket × 本地日期的统一 token 账本聚合（数据 tab 表格）。无参 = 全量历史。 */
export async function tokenUsageDailyHandler(
  options?: TokenUsageQueryOptions,
): Promise<TokenDailyRow[]> {
  if (options?.includeGrokHistory) await ensureGrokHistoryTokenUsage();
  return tokenUsageRepo.dailyByModel();
}

export function registerTokenUsageIpc(): void {
  on(IpcInvoke.TokenUsageRates, (_event, options) =>
    tokenUsageRatesHandler(parseTokenUsageQueryOptions(options)),
  );
  on(IpcInvoke.TokenUsageTopToday, (_event, options) =>
    tokenUsageTopTodayHandler(parseTokenUsageQueryOptions(options)),
  );
  on(IpcInvoke.TokenUsageDaily, (_event, options) =>
    tokenUsageDailyHandler(parseTokenUsageQueryOptions(options)),
  );
}

function parseTokenUsageQueryOptions(value: unknown): TokenUsageQueryOptions | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return {
    includeGrokHistory:
      (value as { includeGrokHistory?: unknown }).includeGrokHistory === true,
  };
}
