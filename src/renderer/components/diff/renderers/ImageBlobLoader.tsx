import { useEffect, useState, type ReactNode } from 'react';
import type { ImageSource, LoadImageBlobResult } from '@shared/types';

/**
 * 模块级 LRU 缓存，避免同一 (sessionId, source) 在多个组件实例之间反复 IPC。
 * 50 条 cap 是经验值：缩略图列表 + diff viewer 同屏不会超。
 */
interface CacheEntry {
  result: LoadImageBlobResult;
  ts: number;
}
const cache = new Map<string, CacheEntry>();
const MAX_CACHE = 50;

function cacheKey(sid: string, src: ImageSource): string {
  return `${sid}|${JSON.stringify(src)}`;
}

interface State {
  loading: boolean;
  result: LoadImageBlobResult | null;
}

interface Props {
  sessionId: string;
  source: ImageSource | null;
  /** render-prop：按 loading / result 状态自渲染（缩略图 / diff viewer 等） */
  children: (state: State) => ReactNode;
}

/**
 * 通用图片加载器：通过 window.api.loadImageBlob 拿 dataURL，带模块级 LRU 缓存 + abort 保护。
 * source = null 时立刻返回 (loading:false, result:null)；这样调用方可以用同一个组件处理「无 before」场景。
 */
export function ImageBlobLoader({ sessionId, source, children }: Props): ReactNode {
  const [state, setState] = useState<State>(() =>
    source ? { loading: true, result: null } : { loading: false, result: null },
  );

  // 注意：依赖项里把 source 序列化成字符串，避免父组件每次新对象引用导致死循环
  const sourceKey = source ? JSON.stringify(source) : null;

  useEffect(() => {
    if (!source) {
      setState({ loading: false, result: null });
      return;
    }
    const key = cacheKey(sessionId, source);
    const cached = cache.get(key);
    if (cached) {
      setState({ loading: false, result: cached.result });
      return;
    }
    setState({ loading: true, result: null });
    let aborted = false;
    void window.api.loadImageBlob(sessionId, source).then((result) => {
      if (aborted) return;
      // 仅缓存成功结果。失败（enoent / io_error / denied 等）短期可恢复（用户重命名了文件 /
      // ImageRead 兜底白名单刚补上），永久缓存会让同一张图永远不重试。
      // REVIEW_2 修：原本所有 result 都进 cache，失败也被记住。
      if (result.ok) {
        cache.set(key, { result, ts: Date.now() });
        // LRU 驱逐：超过上限时挤掉最旧的一条
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sourceKey]);

  return children(state);
}
