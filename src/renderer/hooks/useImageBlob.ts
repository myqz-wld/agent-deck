import { useEffect, useState } from 'react';
import type { LoadImageBlobResult } from '@shared/types';

/**
 * 共享的图片加载器底层 hook：cache + loading 状态机 + abort 保护。
 *
 * 抽出原因：ImageBlobLoader（mcp 工具产生的图）和 UploadedImageThumb（用户上传的图）
 * 都需要同款 cache + loading 模式，但 cache key / loader 函数不同，不能直接共用。
 * 把状态机抽到 hook，cache Map 由调用方传入实现独立 namespace。
 *
 * 设计要点：
 * - 仅缓存成功结果（REVIEW_2 修法）：enoent / io_error / denied 等失败短期可恢复
 *   （文件被重命名 / 白名单刚补上 / reaper 在跑），永久缓存会让同一张图永远不重试
 * - LRU 双预算驱逐（REVIEW_102 MED-2）：条数 ≤ 50 且总字节 ≤ 128MB，命中刷新 ts
 * - cacheKey === null 走「无源」路径，立即 (loading:false, result:null) 返回
 *   方便调用方处理「无 before」/「path 缺失」等空态
 */

export interface CacheEntry {
  result: LoadImageBlobResult;
  ts: number;
}

export interface BlobLoaderState {
  loading: boolean;
  result: LoadImageBlobResult | null;
}

export const MAX_CACHE = 50;

/**
 * cache 总字节预算上限（REVIEW_102 MED-2，双 reviewer 独立命中）。
 *
 * 问题：UploadedImageThumb 渲染 56px 缩略图却 load 全分辨率图（loadUploadedImage 无降采样），
 * 单图最大 20MB → base64 dataUrl ~27MB；旧逻辑只按 50 *条数* LRU 驱逐 → 50×27MB ≈ 1.3GB
 * 可常驻 module 级 sharedImageBlobCache（应用生命周期内不清空）。
 *
 * 短期修法：除条数外再加字节预算，总字节超限时按 LRU（ts 最旧）逐出直到回落。128MB 够缓存
 * 数十张正常截图，又挡住病态大图把内存吃爆。彻底修法（落盘 sidecar 缩略图 / IPC maxDim 降采样）
 * 见 REVIEW_102 follow-up。
 */
const MAX_CACHE_BYTES = 128 * 1024 * 1024;

/** 取 CacheEntry 占用字节（仅 ok result 有 bytes；失败 result 不缓存故恒为 0）。 */
function entryBytes(entry: CacheEntry): number {
  return entry.result.ok ? entry.result.bytes : 0;
}

/**
 * 按 LRU（ts 最旧优先）驱逐，直到同时满足条数 ≤ MAX_CACHE 且总字节 ≤ MAX_CACHE_BYTES。
 * 刚 set 的 newKey 永不被本轮驱逐（避免单张超大图刚进就被自己挤掉导致永远 miss）。
 * export 供 REVIEW_102 回归测试直接验证驱逐语义。
 */
export function evictToBudget(cache: Map<string, CacheEntry>, newKey: string): void {
  let totalBytes = 0;
  for (const v of cache.values()) totalBytes += entryBytes(v);
  while (cache.size > MAX_CACHE || totalBytes > MAX_CACHE_BYTES) {
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const [k, v] of cache) {
      if (k === newKey) continue; // 保护刚写入的条目
      if (v.ts < oldestTs) {
        oldestTs = v.ts;
        oldestKey = k;
      }
    }
    if (!oldestKey) break; // 只剩 newKey，无法再驱逐（单图超 budget 也只能留它）
    totalBytes -= entryBytes(cache.get(oldestKey)!);
    cache.delete(oldestKey);
  }
}

/** 创建一个独立 namespace 的 cache Map（每种 loader 配自己的 cache，互不污染）。 */
export function createImageBlobCache(): Map<string, CacheEntry> {
  return new Map();
}

/**
 * @param loader 实际调 IPC 的 thunk（无参，每次调用方自己绑定 path / sessionId+source 等）
 * @param cacheKey 缓存键（null = 跳过加载，立即返回空态）
 * @param cache 调用方传入的 cache Map（用 createImageBlobCache 创建独立 namespace）
 */
export function useImageBlob(
  loader: () => Promise<LoadImageBlobResult>,
  cacheKey: string | null,
  cache: Map<string, CacheEntry>,
): BlobLoaderState {
  const [state, setState] = useState<BlobLoaderState>(() =>
    cacheKey ? { loading: true, result: null } : { loading: false, result: null },
  );

  useEffect(() => {
    if (!cacheKey) {
      setState({ loading: false, result: null });
      return;
    }
    const cached = cache.get(cacheKey);
    if (cached) {
      // REVIEW_102 LOW（codex LOW-2 / claude INFO 双方命中）：cache hit 刷新 ts，让淘汰
      // 真正按「最近访问」走 LRU 语义而非插入顺序 FIFO。否则频繁打开的老图仍会被 50 条
      // 新条目挤掉，lightbox 重开时白白重新 IPC 拉全图。
      cached.ts = Date.now();
      setState({ loading: false, result: cached.result });
      return;
    }
    setState({ loading: true, result: null });
    let aborted = false;
    void loader()
      .then((result) => {
        if (aborted) return;
        if (result.ok) {
          cache.set(cacheKey, { result, ts: Date.now() });
          // REVIEW_102 MED-2：条数 + 字节双预算驱逐（防全图 dataUrl 把 cache 撑到 1GB+）。
          evictToBudget(cache, cacheKey);
        }
        setState({ loading: false, result });
      })
      .catch((err: unknown) => {
        // REVIEW_102 LOW（codex LOW-1 + lead sim 实证）：loader 的「正常业务错误」会返回
        // { ok:false, reason }，但 transport / preload bridge / main handler 未捕获异常仍会
        // reject。原本无 .catch → loading 永久停在 true（UI 永远「加载中…」）+ 产生
        // unhandledRejection。这里把 reject 归一成 io_error result，沿用 aborted guard 防
        // unmount 后 setState。不缓存（失败短期可恢复，与既有 result.ok 才缓存的策略一致）。
        if (aborted) return;
        setState({
          loading: false,
          result: { ok: false, reason: 'io_error', detail: (err as Error)?.message ?? 'loader rejected' },
        });
      });
    return () => {
      aborted = true;
    };
    // loader 是 thunk，不应进依赖（每次 render 新闭包会死循环）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  return state;
}
