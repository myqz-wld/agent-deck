/**
 * Per-key rate limiter (§7.5)
 *
 * messageRepo.insert 入口校验：覆盖 IPC + MCP 两路。
 * key = teamId；同步操作（不 await），event-loop 单线程下无 race。
 *
 * 与 spawnRateLimiter 同款 patterns，但按 key 分桶。
 */

/**
 * Per-key 滑动窗口限流（与 spawnRateLimiter 同款 patterns，但按 key 分桶）。
 * key = teamId；用 messageRepo.insert 入口校验：覆盖 IPC + MCP 两路。
 *
 * 同步操作（不 await），event-loop 单线程下无 race。
 */
export class PerKeyRateLimiter {
  private buckets = new Map<string, number[]>();

  constructor(
    private maxPerWindow: number,
    private windowMs: number,
  ) {}

  tryConsume(key: string, now = Date.now()): boolean {
    const arr = this.buckets.get(key) ?? [];
    const threshold = now - this.windowMs;
    let i = 0;
    // **REVIEW_85 LOW-2 (reviewer-codex)**: `<= threshold` 与 spawn rate-limiter.ts prune 同款修法
    // 保持两个 limiter 边界语义一致(半开区间 (now-windowMs, now])。修前 `<` 在 now === oldest +
    // windowMs 时不裁 oldest → retryAfterMs 返 0 但 tryConsume 仍拒 1ms,「retry after 0ms 立即
    // retry 仍失败」边界。
    while (i < arr.length && arr[i] <= threshold) i++;
    const fresh = i > 0 ? arr.slice(i) : arr;
    if (fresh.length >= this.maxPerWindow) {
      // 写回（如果裁剪过）
      if (i > 0) this.buckets.set(key, fresh);
      return false;
    }
    fresh.push(now);
    this.buckets.set(key, fresh);
    return true;
  }

  /**
   * **REVIEW_86 LOW (reviewer-claude)**: 周期性清理空桶，防 buckets Map 随历史 team（含已 archive）
   * 单调增长。每个 team send 过一次就留一个常驻 entry；archived team 的 bucket 裁剪到空后仍占位，
   * 无自然 eviction（tryConsume 只对当前 key 操作，不扫别 key）。bounded by team 总数（每桶 ≤
   * maxPerWindow 个 number），影响小但架构上是泄漏。
   *
   * 调用方：universal-message-watcher.start() 的 poll tick 顺带调（low-freq sweep 即可，无需
   * 单独 timer）。把所有窗口外（全部 timestamp ≤ threshold）的桶删除。
   */
  sweepEmptyBuckets(now = Date.now()): void {
    const threshold = now - this.windowMs;
    for (const [key, arr] of this.buckets) {
      // 桶内最新 timestamp 也已出窗 → 整桶可删（下次该 key tryConsume 会重建空桶）
      if (arr.length === 0 || arr[arr.length - 1] <= threshold) {
        this.buckets.delete(key);
      }
    }
  }

  retryAfterMs(key: string, now = Date.now()): number {
    const arr = this.buckets.get(key);
    if (!arr || arr.length === 0) return 0;
    return Math.max(0, this.windowMs - (now - arr[0]));
  }

  setLimits(maxPerWindow: number, windowMs: number): void {
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
  }

  reset(): void {
    this.buckets.clear();
  }

  /** 当前桶数（debug / 单测用：验证 sweepEmptyBuckets 真删空桶，REVIEW_86 LOW）。 */
  get bucketCount(): number {
    return this.buckets.size;
  }
}

/** 应用全局单例。messageRepo.insert 调用方（IPC + MCP send_message）入口校验。 */
export const messageRateLimiter = new PerKeyRateLimiter(60, 60_000);
