/**
 * Phase 1.4 (plan deep-review-batch-a1-b-followup-r3-20260519)：MockSdkQuery 共享 helper。
 *
 * **stateful AsyncGenerator 三态机** — open / closed / interrupted。模拟 SDK Query 真实
 * 行为，让 Phase 1.4 race test 能精确控制 frame 推送时机 + endStream 时机 + interrupt() 行为。
 *
 * **核心契约**（spike1 实证铁证 + R2 plan-review MED-B 完整补全 3 处）：
 *
 * 1. **`pushFrame` 状态机** — endStream 后静默 ignore + warn（避免错用 mock 推 frame 进
 *    closed stream 让 race test 观察不到的 bug）
 * 2. **`endStream` idempotent** — 多次调 no-op，drain buffer 后 done=true 让 trailing values
 *    仍能 yield（与真 SDK Query 终止行为一致）
 * 3. **`interrupt` 不 auto-end stream** — spike1 case A 实测 SDK 调 interrupt() 后仍 emit
 *    in-flight 7 frame burst（hook ×4 + init + user + result_error），interrupt resolve 时机
 *    在 frame 之后；mock 仅标记 interrupted=true，caller test 后续 explicit endStream 模拟
 *    SDK 自然终止
 *
 * 用法（与 vi.useFakeTimers 配合测 setTimeout fallback race）：
 * ```ts
 * vi.useFakeTimers();
 * const mockQuery = new MockSdkQuery();
 * // 通过 vi.mock('@main/adapters/claude-code/sdk-loader') 注入到 createSession
 * // ...trigger createSession 进 stream...
 * await vi.advanceTimersByTimeAsync(30_000); // fallback fire
 * mockQuery.pushFrame({ type: 'system', subtype: 'init', session_id: 'late-id' });
 * await vi.runAllTimersAsync();
 * // assert race window: sessions Map 仍指向 fallbackId vs late-id
 * mockQuery.endStream();
 * await vi.runAllTimersAsync();
 * // assert finally cleanup: sessions Map 删 fallbackId
 * vi.useRealTimers();
 * ```
 *
 * @internal Only for sdk-bridge race test (Phase 1.4). Do NOT import from production files.
 */

/** SDK message 最小契约（只用 type + session_id 字段触发 first-id 路径） */
export interface MockSdkFrame {
  type: string;
  session_id?: string;
  // SDK 真实 message 还有 subtype / message / parent_tool_use_id 等字段，mock 不强制
  [key: string]: unknown;
}

/**
 * Mock SDK Query — stateful 三态机（open / closed / interrupted）+ AsyncGenerator-shape。
 *
 * **类型策略**：故意不 `implements AsyncGenerator<MockSdkFrame, void, void>` —— SDK 真实
 * `Query` interface 含 ~20 个 control request method（setModel / setMaxThinkingTokens /
 * applyFlagSettings / initializationResult 等），全部 mock 无意义。MockSdkQuery 提供 SDK
 * createSession 内部真路径需要的最小接口（next / return / throw / interrupt / setPermissionMode
 * / [Symbol.asyncIterator]）让 for-await consume 跑通。Test caller 用 `as unknown as Query`
 * cast 装进 sdk-loader.query() 返回值。
 *
 * 三契约（详 file jsdoc）：
 * 1. pushFrame after endStream → 静默 ignore + warn
 * 2. endStream idempotent + drain buffer
 * 3. interrupt() 不 auto-end，仅标记
 */
export class MockSdkQuery {
  private buffer: MockSdkFrame[] = [];
  private waiter: ((value: IteratorResult<MockSdkFrame, void>) => void) | null = null;
  private done = false;
  private interrupted = false;
  /** 让 caller test 能 assert interrupt() 是否被调（spike1 兼容性 invariant 测试用） */
  public interruptCallCount = 0;
  /** 让 caller test 能 assert setPermissionMode 调用（per-session test 用，1.4 不直接断言） */
  public setPermissionModeCalls: string[] = [];

  /**
   * Push 一个 frame 进 stream。三契约：
   * - stream closed (done=true) → 静默 ignore + warn（防 race test 观察不到 SDK trailing burst）
   * - 有 waiter（next() 在等）→ 直接 resolve waiter
   * - 无 waiter → 入 buffer 等 next() 拉
   */
  pushFrame(msg: MockSdkFrame): void {
    if (this.done) {
      // R2 MED-B + codex LOW-1 修订：closed-stream 状态机 — endStream 后静默 ignore + warn
      console.warn('[MockSdkQuery] pushFrame after endStream — ignored');
      return;
    }
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: msg, done: false });
    } else {
      this.buffer.push(msg);
    }
  }

  /**
   * 终止 stream（对应真 SDK Query 自然结束）。
   *
   * - idempotent：done=true 后再调 no-op
   * - drain buffer：consumer next() 仍能拿 trailing values（与真 SDK 一致）
   * - waiter 在等且 buffer 空 → 立即 resolve { done: true }
   */
  endStream(): void {
    if (this.done) return;
    this.done = true;
    if (this.waiter && this.buffer.length === 0) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined, done: true });
    }
  }

  /**
   * R2 MED-B 修订：next() 实现完整 — done=true 后 drain buffer 再 done。
   *
   * 优先级：buffer 非空 → shift 一个；buffer 空 + done → IteratorResult done=true；
   * buffer 空 + 未 done → 等 push/endStream 触发 waiter resolve。
   */
  async next(): Promise<IteratorResult<MockSdkFrame, void>> {
    if (this.buffer.length > 0) {
      return { value: this.buffer.shift()!, done: false };
    }
    if (this.done) {
      return { value: undefined, done: true };
    }
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  /**
   * R2 MED-B 修订：interrupt() 不 auto-end，与 spike1 实测行为一致 — 仅标记。
   *
   * SDK 实测 interrupt() 后仍 emit in-flight burst（hook ×4 + init + user + result_error），
   * caller test 后续 explicit endStream 模拟 SDK 自然终止。
   */
  async interrupt(): Promise<void> {
    this.interrupted = true;
    this.interruptCallCount++;
  }

  /**
   * SDK Query.setPermissionMode mock — per-session 测用（Phase 2.7 修法配套）。Phase 1.4
   * 测试不直接断言此方法，预留兼容 createSession 内部 InternalSession.query 接口。
   */
  async setPermissionMode(mode: string): Promise<void> {
    this.setPermissionModeCalls.push(mode);
  }

  /**
   * AsyncGenerator return — caller for-await 提前 break 时调。endStream + done=true。
   */
  async return(): Promise<IteratorResult<MockSdkFrame, void>> {
    this.endStream();
    return { value: undefined, done: true };
  }

  /**
   * AsyncGenerator throw — caller for-await 主动抛错时调。透传 error 给上层 catch。
   */
  async throw(e: unknown): Promise<IteratorResult<MockSdkFrame, void>> {
    throw e;
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  // 让 caller 检查内部状态（typing helper）
  get isInterrupted(): boolean {
    return this.interrupted;
  }
  get isDone(): boolean {
    return this.done;
  }
}
