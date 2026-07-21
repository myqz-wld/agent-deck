/**
 * raceWithTimeout 真单测（Follow-up #10 — 替换 hand-off.test.ts:170 的 `expect(true).toBe(true)`
 * 占位断言）。
 *
 * **为什么纯 promise 无 fake-timer 不 brittle**：原占位注释担心 `vi.useFakeTimers + Promise.race`
 * 触发 vitest unhandled-rejection 警告(fake timer reject 后 race 内部 timer promise 仍被当
 * unhandled)。本测试用**真实短 timeout**(work 用 never-resolve / 慢 promise)走真实 setTimeout,
 * race 输的一方(work 或 timer)都被 race 自身 .then(resolve,reject) 订阅 + raceWithTimeout 内
 * `opts.work.catch(()=>undefined)` 预订阅,无 unhandled。不碰 SDK / 不碰 fake timer → 不 brittle。
 *
 * 覆盖矩阵：
 * - timer 先赢 → reject(errorMessage) + onTimeout 被调一次
 * - work 先赢 → 正常返回 work value,onTimeout 不调
 * - timeoutMs <= 0 → 直接 return work(不起 timer,onTimeout 不调,即使设了超时也不触发)
 * - work 先赢 → finally clearTimeout(无 leak;通过 onTimeout 不被调 + 进程不挂起间接验证)
 * - work reject 先于 timer → 透传 work 的 rejection(非 timeout error)
 */

import { describe, expect, it, vi } from 'vitest';
import { raceWithTimeout } from '../race-with-timeout';

/** 永不 resolve 的 promise(模拟 work 卡死)。raceWithTimeout 预 .catch 订阅防 unhandled。 */
function neverResolve<T>(): Promise<T> {
  return new Promise<T>(() => {
    /* never settles */
  });
}

/** 延迟 resolve 的 promise。 */
function delayedResolve<T>(value: T, ms: number): Promise<T> {
  return new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
}

describe('raceWithTimeout (Follow-up #10)', () => {
  it('timer 先赢(work 永不 resolve)→ reject errorMessage + onTimeout 被调一次', async () => {
    const onTimeout = vi.fn();
    await expect(
      raceWithTimeout({
        work: neverResolve<string>(),
        timeoutMs: 20,
        errorMessage: '__test_timeout__',
        onTimeout,
      }),
    ).rejects.toThrow('__test_timeout__');
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('work 先赢(快于 timeout)→ 正常返回 work value + onTimeout 不调', async () => {
    const onTimeout = vi.fn();
    const result = await raceWithTimeout({
      work: delayedResolve('done', 5),
      timeoutMs: 200,
      errorMessage: '__test_timeout__',
      onTimeout,
    });
    expect(result).toBe('done');
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('timeoutMs <= 0 → 直接 return work(不起 timer,onTimeout 不调)', async () => {
    const onTimeout = vi.fn();
    const result = await raceWithTimeout({
      work: Promise.resolve('immediate'),
      timeoutMs: 0,
      errorMessage: '__test_timeout__',
      onTimeout,
    });
    expect(result).toBe('immediate');
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('timeoutMs < 0 → 同样直接 return work(负值也走零开销分支)', async () => {
    const result = await raceWithTimeout({
      work: Promise.resolve(42),
      timeoutMs: -1,
      errorMessage: '__test_timeout__',
    });
    expect(result).toBe(42);
  });

  it('work reject 先于 timer → 透传 work 的 rejection(非 timeout error)+ onTimeout 不调', async () => {
    const onTimeout = vi.fn();
    await expect(
      raceWithTimeout({
        work: Promise.reject(new Error('work_failed')),
        timeoutMs: 200,
        errorMessage: '__test_timeout__',
        onTimeout,
      }),
    ).rejects.toThrow('work_failed');
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('onTimeout 可选省略 → timer 先赢仍 reject errorMessage(不因缺 onTimeout 崩)', async () => {
    await expect(
      raceWithTimeout({
        work: neverResolve<void>(),
        timeoutMs: 20,
        errorMessage: '__no_callback_timeout__',
      }),
    ).rejects.toThrow('__no_callback_timeout__');
  });

  it('work 先赢后 timer 不应再 fire onTimeout(finally clearTimeout 生效)', async () => {
    const onTimeout = vi.fn();
    const result = await raceWithTimeout({
      work: delayedResolve('fast', 5),
      timeoutMs: 30,
      errorMessage: '__test_timeout__',
      onTimeout,
    });
    expect(result).toBe('fast');
    // work 先赢后再等一段(超过原 timeoutMs)确认 timer 已被 clearTimeout — onTimeout 仍 0 次
    await delayedResolve(null, 50);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('caller abort wins promptly, preserves its reason, and cancels provider work once', async () => {
    const controller = new AbortController();
    const onAbort = vi.fn();
    const result = raceWithTimeout({
      work: neverResolve<void>(),
      timeoutMs: 1_000,
      errorMessage: '__test_timeout__',
      signal: controller.signal,
      onAbort,
    });

    controller.abort(new Error('review closed'));

    await expect(result).rejects.toThrow('review closed');
    expect(onAbort).toHaveBeenCalledOnce();
  });

  it('rejects an already-aborted signal without starting a timer', async () => {
    const controller = new AbortController();
    const onAbort = vi.fn();
    controller.abort(new Error('already closed'));

    await expect(raceWithTimeout({
      work: neverResolve<void>(),
      timeoutMs: 1_000,
      errorMessage: '__test_timeout__',
      signal: controller.signal,
      onAbort,
    })).rejects.toThrow('already closed');
    expect(onAbort).toHaveBeenCalledOnce();
  });

  it('does not miss an abort that lands immediately before listener registration', async () => {
    const onAbort = vi.fn();
    const reason = new Error('closed during subscribe');
    const state: { aborted: boolean; reason?: Error } = { aborted: false };
    const signal = {
      get aborted() { return state.aborted; },
      get reason() { return state.reason; },
      addEventListener() {
        state.aborted = true;
        state.reason = reason;
      },
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;

    await expect(raceWithTimeout({
      work: neverResolve<void>(),
      timeoutMs: 1_000,
      errorMessage: '__test_timeout__',
      signal,
      onAbort,
    })).rejects.toThrow('closed during subscribe');
    expect(onAbort).toHaveBeenCalledOnce();
  });
});
