import type { ReactNode } from 'react';
import type { ImageSource } from '@shared/types';
import {
  createImageBlobCache,
  useImageBlob,
  type BlobLoaderState,
} from '@renderer/hooks/useImageBlob';

/**
 * 模块级 LRU 缓存（独立 namespace，与 UploadedImageThumb 不共享）。
 * cache key 格式：`<sessionId>|<JSON.stringify(ImageSource)>`，与该 IPC 入参一一对应。
 */
const cache = createImageBlobCache();

interface Props {
  sessionId: string;
  source: ImageSource | null;
  /** render-prop：按 loading / result 状态自渲染（缩略图 / diff viewer 等） */
  children: (state: BlobLoaderState) => ReactNode;
}

/**
 * 通用图片加载器：通过 window.api.loadImageBlob 拿 dataURL，带模块级 LRU 缓存 + abort 保护。
 * source = null 时立刻返回 (loading:false, result:null)；这样调用方可以用同一个组件处理「无 before」场景。
 *
 * 内部走 useImageBlob hook 共享 cache + loading 状态机（CHANGELOG_<X> 抽出，与
 * UploadedImageThumb 共用底层但各持独立 cache）。
 */
export function ImageBlobLoader({ sessionId, source, children }: Props): ReactNode {
  const sourceKey = source ? `${sessionId}|${JSON.stringify(source)}` : null;
  const state = useImageBlob(
    () => window.api.loadImageBlob(sessionId, source!),
    sourceKey,
    cache,
  );
  return children(state);
}
