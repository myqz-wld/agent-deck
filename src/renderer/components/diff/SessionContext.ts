import { createContext, useContext } from 'react';

/**
 * 把当前 session id 通过 Context 注入给嵌套的 diff renderer。
 *
 * 背景：DiffViewer 当前签名只接 `payload`，但 ImageDiffRenderer 内部需要 sessionId
 * 才能调 `window.api.loadImageBlob(sessionId, source)`（main 进程白名单要求 sessionId）。
 * 用 Context 而不是 prop drill 是为了不强迫所有 renderer 都改签名 —— 文本 / pdf 渲染器不需要。
 *
 * 调用方（ActivityFeed.ToolStartRow / PermissionRow / SessionDetail）把 sessionId 传给 DiffViewer，
 * DiffViewer 用 SessionIdProvider 包裹具体 renderer。
 */
const Ctx = createContext<string>('');

export const SessionIdProvider = Ctx.Provider;

export function useDiffSessionId(): string {
  return useContext(Ctx);
}
