/**
 * preload/api/_helpers: preload facade 共用 helper（R37 P1 Step 1.1）。
 *
 * 抽 `subscribe<T>` 让 events.ts / teams.ts 各自 8 + 2 个 onXxx 5 行模板（独立维护
 * `const handler = (_, payload) => cb(payload); ipcRenderer.on(channel, handler);
 *  return () => ipcRenderer.off(channel, handler);`）压缩成一行调用。
 *
 * 不放 invoke<T> 封装 — 当前 `ipcRenderer.invoke(channel, ...args)` 已是泛型 method
 * 各 facade 调用都附 `Promise<T>` 显式 return type，重复抽一层 helper 收益小。
 * 真未来加 telemetry / 错误统一处理 时再扩展。
 */

import { ipcRenderer } from 'electron';

/**
 * 订阅 main → renderer push channel，返回 unsubscribe 函数。
 *
 * 模板：
 * ```ts
 * const handler = (_: unknown, payload: T): void => cb(payload);
 * ipcRenderer.on(channel, handler);
 * return () => ipcRenderer.off(channel, handler);
 * ```
 */
export function subscribe<T>(
  channel: string,
  cb: (payload: T) => void,
): () => void {
  const handler = (_: unknown, payload: T): void => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}
