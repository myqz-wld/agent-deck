// @vitest-environment happy-dom
/**
 * useImageBlob hook 异步状态机回归测试（REVIEW_102 follow-up，issue 6f86ac86）。
 *
 * 背景：REVIEW_102 R2 双 reviewer（claude + codex）独立命中 INFO —— 本轮风险最高的 hook 级
 * 异步 race 行为仅靠 /tmp sim 实证（/tmp/blob-reject2.mjs），未落 repo committed test。
 * 用户拍板方案 (a)：引入 happy-dom + @testing-library/react renderHook 直测真实 hook 行为。
 * 本文件覆盖 useImageBlob 的两条修法（spike1-jsdom-rtl-compat.md 验证可行 + mutation test 挡回归）：
 *
 * - LOW-1（codex 单方 + lead sim 实证）：loader reject → loading:false + io_error result，
 *   不永久停在 loading:true（旧实现 `void loader().then()` 无 .catch → transport reject 时
 *   UI 永远「加载中…」+ unhandledRejection）。守门 useImageBlob.ts:118-129 的 .catch 分支。
 * - LOW-2（codex LOW-2 / claude INFO 双方命中）：cache hit 刷新 ts，让淘汰按「最近访问」LRU
 *   而非插入顺序 FIFO。守门 useImageBlob.ts:102 的 `cached.ts = Date.now()`。
 *
 * 注：evictToBudget / isAnimatedWebpHeader 等纯函数测试在 image-attachments-logic.test.ts
 * （node 环境，无需 jsdom）。本文件专测需要 React 渲染上下文的 hook 状态机行为。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { useImageBlob, createImageBlobCache, type CacheEntry } from '../useImageBlob';
import type { LoadImageBlobResult } from '@shared/types';

afterEach(() => cleanup());

const okResult = (bytes = 10): LoadImageBlobResult => ({
  ok: true,
  mime: 'image/png',
  bytes,
  dataUrl: 'data:image/png;base64,aGVsbG8=',
});

describe('useImageBlob — 加载成功路径', () => {
  it('loader resolve ok → loading:false + result + 入 cache', async () => {
    const cache = createImageBlobCache();
    const result = okResult();
    const { result: hook } = renderHook(() => useImageBlob(() => Promise.resolve(result), 'k1', cache));

    // 初始：有 cacheKey 时 loading:true
    expect(hook.current.loading).toBe(true);
    expect(hook.current.result).toBeNull();

    await waitFor(() => expect(hook.current.loading).toBe(false));
    expect(hook.current.result).toEqual(result);
    // ok result 入 cache（后续同 key 命中）
    expect(cache.get('k1')?.result).toEqual(result);
  });

  it('cacheKey=null → 立即 (loading:false, result:null) 空态，不调 loader', async () => {
    const cache = createImageBlobCache();
    const loader = vi.fn(() => Promise.resolve(okResult()));
    const { result: hook } = renderHook(() => useImageBlob(loader, null, cache));

    expect(hook.current.loading).toBe(false);
    expect(hook.current.result).toBeNull();
    // 给 effect 一拍确认 loader 始终没被调
    await act(async () => {
      await Promise.resolve();
    });
    expect(loader).not.toHaveBeenCalled();
  });
});

describe('useImageBlob — LOW-1：loader reject 不永久 loading', () => {
  it('loader reject → loading:false + io_error result（不停在 loading:true）', async () => {
    const cache = createImageBlobCache();
    const { result: hook } = renderHook(() =>
      useImageBlob(() => Promise.reject(new Error('IPC channel closed')), 'k-reject', cache),
    );

    await waitFor(() => expect(hook.current.loading).toBe(false));
    expect(hook.current.result).toMatchObject({
      ok: false,
      reason: 'io_error',
      detail: 'IPC channel closed',
    });
  });

  it('reject 的失败结果不入 cache（失败短期可恢复，与 result.ok 才缓存策略一致）', async () => {
    const cache = createImageBlobCache();
    const { result: hook } = renderHook(() =>
      useImageBlob(() => Promise.reject(new Error('transient')), 'k-nocache', cache),
    );
    await waitFor(() => expect(hook.current.loading).toBe(false));
    expect(cache.has('k-nocache')).toBe(false);
  });

  it('reject 非 Error（抛字符串/undefined）→ detail 兜底不崩', async () => {
    const cache = createImageBlobCache();
    const { result: hook } = renderHook(() =>
      // eslint-disable-next-line prefer-promise-reject-errors
      useImageBlob(() => Promise.reject(undefined), 'k-weird', cache),
    );
    await waitFor(() => expect(hook.current.loading).toBe(false));
    expect(hook.current.result).toMatchObject({ ok: false, reason: 'io_error' });
    // detail 走 `?? 'loader rejected'` 兜底（err?.message 对 undefined 是 undefined）
    expect((hook.current.result as { detail?: string }).detail).toBe('loader rejected');
  });
});

describe('useImageBlob — LOW-2：cache hit 刷新 ts（LRU 非 FIFO）', () => {
  it('cache hit → 刷新 ts + 不调 loader + 直接返回缓存 result', async () => {
    const cache = createImageBlobCache();
    const cached: CacheEntry = { result: okResult(5), ts: 1000 };
    cache.set('hit', cached);
    const loader = vi.fn(() => Promise.reject(new Error('should NOT be called on cache hit')));

    const { result: hook } = renderHook(() => useImageBlob(loader, 'hit', cache));

    await waitFor(() => expect(hook.current.loading).toBe(false));
    expect(hook.current.result).toEqual(cached.result);
    expect(loader).not.toHaveBeenCalled();
    // LOW-2 核心：ts 被刷新（> 旧值 1000），淘汰按最近访问 LRU 而非 FIFO
    expect(cache.get('hit')!.ts).toBeGreaterThan(1000);
  });
});

describe('useImageBlob — aborted guard（unmount/cacheKey 切换防 setState 泄漏）', () => {
  it('loader resolve 在 unmount 后到达 → 不抛错（aborted guard 生效）', async () => {
    const cache = createImageBlobCache();
    let resolveLoader!: (r: LoadImageBlobResult) => void;
    const loader = () => new Promise<LoadImageBlobResult>((res) => (resolveLoader = res));

    const { unmount } = renderHook(() => useImageBlob(loader, 'k-unmount', cache));
    unmount();
    // unmount 后才 resolve；aborted=true 守卫让 .then 内 setState 被跳过，无 act warning / 抛错
    await act(async () => {
      resolveLoader(okResult());
      await Promise.resolve();
    });
    // ok result 仍写入 cache（cache.set 在 aborted guard 之前？—— 不，看实现：aborted guard
    // 在 .then 最前，return 前不 set）。断言：unmount 后 result 不入 cache（aborted 提前 return）
    expect(cache.has('k-unmount')).toBe(false);
  });

  it('cacheKey 从 A 切到 B → 重新加载 B；A 的 in-flight resolve 不污染 B 的 state', async () => {
    const cache = createImageBlobCache();
    const resolvers: Record<string, (r: LoadImageBlobResult) => void> = {};
    const loader = (key: string) => () =>
      new Promise<LoadImageBlobResult>((res) => (resolvers[key] = res));

    const { result: hook, rerender } = renderHook(
      ({ k }: { k: string }) => useImageBlob(loader(k), k, cache),
      { initialProps: { k: 'A' } },
    );
    expect(hook.current.loading).toBe(true);

    // 切到 B（A 的 effect cleanup 把 A 的 aborted 置 true）
    rerender({ k: 'B' });
    expect(hook.current.loading).toBe(true);

    // 迟到的 A resolve 应被 aborted guard 丢弃，不写 state
    await act(async () => {
      resolvers['A']?.(okResult(111));
      await Promise.resolve();
    });
    // 再 resolve B → state 反映 B
    const bResult = okResult(222);
    await act(async () => {
      resolvers['B']?.(bResult);
      await Promise.resolve();
    });
    await waitFor(() => expect(hook.current.loading).toBe(false));
    expect(hook.current.result).toEqual(bResult);
  });
});
