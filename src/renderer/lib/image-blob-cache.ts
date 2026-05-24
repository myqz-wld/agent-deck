import { createImageBlobCache } from '@renderer/hooks/useImageBlob';

/**
 * plan handoff-render-and-image-batch-20260521 §Phase 4 Step 1:UploadedImageThumb +
 * ImageLightbox 共享的 LRU cache(两者都用 `path` 作 cache key 同款 IPC
 * `window.api.loadUploadedImage(path)`,共享避免点缩略图开 lightbox 时重新拉图)。
 *
 * **隔离边界严格限定**(plan §已知踩坑 + R3 reviewer-claude LOW-1):
 * - **仅 thumb + lightbox 两组件共享** sharedImageBlobCache
 * - **`src/renderer/components/diff/renderers/ImageBlobLoader.tsx:10-13` 现有独立 `cache` 不合并**
 *   (用 `<sessionId>|<JSON.stringify(ImageSource)>` 格式 cache key 与 thumb 的 `path` 格式不兼容,
 *   合并会 key collision — 详 ImageBlobLoader.tsx 明文「与 UploadedImageThumb 不共享」invariant)
 *
 * 实施后 `grep -n "createImageBlobCache" src/renderer/` 应只 2 处:
 * 1. `useImageBlob.ts:32` (export 函数本身)
 * 2. 本文件 (新建 shared module,1 处调用 + export `sharedImageBlobCache`)
 * `ImageBlobLoader.tsx:13` 仍保持 `const cache = createImageBlobCache()` 不动。
 */
export const sharedImageBlobCache = createImageBlobCache();
