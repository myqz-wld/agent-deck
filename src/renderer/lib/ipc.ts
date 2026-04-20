/**
 * 简单封装 ipcRenderer.invoke 的代理。preload/index.ts 已经把 window.api 暴露好；
 * 但少数动态 channel（如 session:list-history）没有出现在 IpcInvoke 常量里，
 * 这里提供一个不强类型的兜底入口。
 */

declare global {
  interface Window {
    electronIpc?: {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    };
  }
}

export async function ipcInvokeRaw(channel: string, ...args: unknown[]): Promise<unknown> {
  // 通过 preload 注入一个兜底 invoker；如果未注入则回退到 fetch 等替代方案
  if (window.electronIpc) {
    return window.electronIpc.invoke(channel, ...args);
  }
  // 没有兜底也不报错，返回 null 让 UI 自行处理
  console.warn(`[ipc] window.electronIpc not available for channel ${channel}`);
  return null;
}
