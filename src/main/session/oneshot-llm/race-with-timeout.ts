/**
 * 通用 timeout race helper（R37 P2-H Step 3.2）。
 *
 * **抽出动机**（reviewer 双对抗 R1 H4 finding）：
 * 4 个 LLM oneshot runner 都用相同的 race 模板：
 *   - 提前 catch work promise 防 unhandled rejection（race 输 → work 仍后台跑可能 reject）
 *   - setTimeout 触发 → 可选 onTimeout（claude 调 q.interrupt，codex 调 controller.abort 传
 *     thread.run signal —— 两 adapter 都取消子进程，REVIEW_82）→ reject
 *   - try/finally 必清 timeoutHandle 防 leak（CHANGELOG_13 教训）
 *   - timeoutMs <= 0 直接 return work（与 settingsStore.summaryTimeoutMs=0 「不超时」语义对齐）
 *
 * 4 处实现行为差异为 0（仅 errorMessage / onTimeout 不同），抽公共 helper 收口。
 *
 * **错误传播**：timer 先赢 → 抛 `new Error(errorMessage)` 让 caller catch；work 先赢 → 直接
 * 返回 work 的 resolved value。任何情况下 try/finally 都清 timeout，不会 leak NodeJS.Timeout。
 *
 * **work 的预 catch**：调 `work.catch(() => undefined)` 注册一个 no-op rejection handler（不
 * 改变 work 自身的 rejection 链，仅让 V8 把它视为「已订阅」防 unhandledRejection 警告）。
 * Promise.race 自身也会订阅 work 的 rejection（内部 .then(resolve, reject)），但 vitest /
 * 部分 Node 版本在 race 输后 work 才 reject 的窗口仍可能误报，此处显式 .catch 是防御性。
 */
export async function raceWithTimeout<T>(opts: {
  /** 真正干活的 promise（claude consumeLoop / codex thread.run）。 */
  work: Promise<T>;
  /** 超时毫秒；<= 0 直接 return work（不起 timer，零开销）。 */
  timeoutMs: number;
  /** Timer 触发时 reject 的 Error message（如 `__summarizer_timeout__`）。 */
  errorMessage: string;
  /**
   * 可选：timer 触发时调（reject 之前）。typical use：claude SDK `q.interrupt()`
   * 让子进程优雅退；codex SDK `controller.abort()`（thread.run signal）取消 exec 子进程
   * （REVIEW_82 — 两 adapter 都取消，防周期 timeout 累积后台进程）。
   */
  onTimeout?: () => void;
  /** Optional caller cancellation, used by short-lived UI-owned oneshot work. */
  signal?: AbortSignal;
  /** Cancel the provider operation when `signal` aborts. */
  onAbort?: () => void;
}): Promise<T> {
  if (opts.timeoutMs <= 0 && !opts.signal) return opts.work;
  if (opts.signal?.aborted) {
    opts.onAbort?.();
    throw opts.signal.reason instanceof Error
      ? opts.signal.reason
      : new Error('Operation aborted.');
  }

  // 提前订阅 work rejection 防 unhandled。Race 输（timer 先 reject）后 work 仍后台跑，
  // 最终 reject 时无 .catch 监听则触发 unhandledRejection。这里的 .catch 不消费 work
  // 的实际 rejection 流（仅注册一个 no-op handler），race 仍能拿到 work 的 settle。
  opts.work.catch(() => undefined);

  let timeoutHandle: NodeJS.Timeout | null = null;
  let abortListener: (() => void) | undefined;
  try {
    const competitors: Promise<T>[] = [opts.work];
    if (opts.timeoutMs > 0) {
      competitors.push(new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          opts.onTimeout?.();
          reject(new Error(opts.errorMessage));
        }, opts.timeoutMs);
      }));
    }
    if (opts.signal) {
      const signal = opts.signal;
      competitors.push(new Promise<never>((_, reject) => {
        let abortHandled = false;
        abortListener = (): void => {
          if (abortHandled) return;
          abortHandled = true;
          opts.onAbort?.();
          reject(signal.reason instanceof Error
            ? signal.reason
            : new Error('Operation aborted.'));
        };
        signal.addEventListener('abort', abortListener, { once: true });
        // Close the check→subscribe race: AbortSignal does not replay an abort that happened just
        // before addEventListener(), while an abort just after it can hit both paths below.
        if (signal.aborted) abortListener();
      }));
    }
    return await Promise.race(competitors);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (abortListener && opts.signal) {
      opts.signal.removeEventListener('abort', abortListener);
    }
  }
}
