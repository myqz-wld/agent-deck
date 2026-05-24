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
 * - LRU 50 条 cap：缩略图列表 + diff viewer 同屏不会超
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

const MAX_CACHE = 50;

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
      setState({ loading: false, result: cached.result });
      return;
    }
    setState({ loading: true, result: null });
    let aborted = false;
    void loader().then((result) => {
      if (aborted) return;
      if (result.ok) {
        cache.set(cacheKey, { result, ts: Date.now() });
        if (cache.size > MAX_CACHE) {
          let oldestKey: string | null = null;
          let oldestTs = Infinity;
          for (const [k, v] of cache) {
            if (v.ts < oldestTs) {
              oldestTs = v.ts;
              oldestKey = k;
            }
          }
          if (oldestKey) cache.delete(oldestKey);
        }
      }
      setState({ loading: false, result });
    });
    return () => {
      aborted = true;
    };
    // loader 是 thunk，不应进依赖（每次 render 新闭包会死循环）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  return state;
}
