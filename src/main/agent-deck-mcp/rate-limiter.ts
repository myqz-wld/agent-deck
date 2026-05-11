/**
 * Agent Deck MCP server 滑动窗口限流 + per-caller in-flight 计数（B'0 ADR §6.3 / §6.6）。
 *
 * **滑动窗口 RateLimiter**：自管 timestamps Array，每次 tryConsume 同步过期裁剪 +
 * 上限校验（不 await，event-loop 单线程下无 race）。
 *
 * **InFlightChildrenCounter**：per-caller spawn-mutex 用，记录还在 await createSession
 * 的 child 数。同步 inc/dec/get（不 await）。与 sessionRepo.listChildren 反查的「DB
 * 已存在 active children」叠加 = 真实 fan-out（reserve + 已落地都计入）。
 */

export class RateLimiter {
  private timestamps: number[] = [];
  constructor(
    private maxPerWindow: number,
    private windowMs: number,
  ) {}

  /**
   * 同步操作：先裁剪过期 timestamp，若当前 < limit 即记录新时间戳并返回 true；
   * 否则返回 false（caller 用 retryAfterMs() 算重试时间）。
   * **必须**在同步段内完成，不能 await，否则 race 失效。
   */
  tryConsume(now = Date.now()): boolean {
    this.prune(now);
    if (this.timestamps.length >= this.maxPerWindow) return false;
    this.timestamps.push(now);
    return true;
  }

  /**
   * 距离最早一个 timestamp 过期还剩多少 ms（达到该时间后 tryConsume 必定再次成功）。
   * timestamps 空时返回 0。
   */
  retryAfterMs(now = Date.now()): number {
    if (this.timestamps.length === 0) return 0;
    const oldest = this.timestamps[0];
    return Math.max(0, this.windowMs - (now - oldest));
  }

  /** 当前窗口内已用 quota（debug / 单测用） */
  get currentCount(): number {
    return this.timestamps.length;
  }

  /** 重置（测试用 / 用户在 Settings 改 maxPerMinute 时调） */
  reset(): void {
    this.timestamps = [];
  }

  setLimits(maxPerWindow: number, windowMs: number): void {
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
    this.prune(Date.now());
  }

  private prune(now: number): void {
    const threshold = now - this.windowMs;
    let i = 0;
    while (i < this.timestamps.length && this.timestamps[i] < threshold) i++;
    if (i > 0) this.timestamps = this.timestamps.slice(i);
  }
}

/**
 * Per-caller in-flight children counter（B'0 ADR §6.6 race protection）。
 *
 * spawn_session handler 同步段内 inc(callerSid) + check fan-out；await createSession
 * 后 dec。这样并发 N 个 spawn_session 不会全部穿透「DB 反查只看到 0 children」的窗口。
 *
 * 与 sessionRepo.listChildren(parentId, 'active').length 叠加：
 * - DB 已落地 active children: K
 * - 本进程内 in-flight reserve: M
 * - effective fan-out = K + M
 * - if effective + 1 > maxFanOut ⇒ deny
 */
export class InFlightChildrenCounter {
  private byParent = new Map<string, number>();

  inc(parentId: string): void {
    this.byParent.set(parentId, (this.byParent.get(parentId) ?? 0) + 1);
  }

  dec(parentId: string): void {
    const cur = this.byParent.get(parentId) ?? 0;
    if (cur <= 1) {
      this.byParent.delete(parentId);
    } else {
      this.byParent.set(parentId, cur - 1);
    }
  }

  get(parentId: string): number {
    return this.byParent.get(parentId) ?? 0;
  }

  reset(): void {
    this.byParent.clear();
  }
}

/**
 * 应用全局单例（main 进程）。tools.ts spawn_session handler 直接消费。
 * 默认 limit = 10/min，运行时由 settings.mcpSpawnRatePerMinute 调（spawn-guards.ts 内
 * 每次进入 handler 时同步 settings 当前值，避免 hot-toggle 漂移）。
 */
export const spawnRateLimiter = new RateLimiter(10, 60_000);
export const inFlightChildren = new InFlightChildrenCounter();
