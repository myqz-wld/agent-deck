/** Composes the domain preload modules into the typed `window.api` facade. */

import { contextBridge, ipcRenderer } from 'electron';
import { IpcInvoke } from '@shared/ipc-channels';
import { sessionsApi } from './api/sessions';
import { adaptersApi } from './api/adapters';
import { miscApi } from './api/misc';
import { eventsApi } from './api/events';
import { issuesApi } from './api/issues';
import { planReviewApi } from './api/plan-review';
import { remoteHostApi } from './api/remote-host';

const api = {
  ...sessionsApi,
  ...adaptersApi,
  ...miscApi,
  ...eventsApi,
  ...issuesApi,
  ...planReviewApi,
  ...remoteHostApi,
};

try {
  contextBridge.exposeInMainWorld('api', api);
    // REVIEW_35 MED-B4: 删除 raw electronIpc.invoke(channel: string) 兜底通道。
    // 该通道 0 个 renderer 消费方（grep 实证），让新增 channel 可绕过 AgentDeckApi 强类型 facade
    // 是潜在反模式。HistoryPanel.tsx:56 注释也明确说「走 preload 强类型 facade 而非 ipcInvokeRaw」。
    // 真未来需要动态 channel 时显式重新 export，避免长期保留死代码。
} catch (e) {
    // CHANGELOG_179 §Step 3.2.6 方案 2: 上报 main 端落盘 (生产 .app 双击启动场景下 console.error
    // 写到 stdout 但 launchd 无终端 → silent failure → main 看不到 init signal 与 §不变量 1
    // 冲突). 走 ipcRenderer.send(IpcInvoke.PreloadFatalError, payload) → main ipcMain.on
    // (logs handler) → log.scope('preload-fatal').error(...) 落 ~/Library/Logs/Agent Deck/
    // main-YYYY-MM-DD.log. 与 webContents.on('preload-error') 互补 (本 channel 拦加载成功后
    // 内部 throw, preload-error 拦 script 本身加载失败).
    const err = e as { message?: string; stack?: string } | null;
    const message = err?.message ?? String(e);
    const stack = err?.stack;
    try {
      ipcRenderer.send(IpcInvoke.PreloadFatalError, { message, stack });
    } catch {
      // ipcRenderer.send 也失败时连 main 都通讯不上, 走 console.error 兜底 (与原行为对齐, 至少
      // 保留 dev 模式 stdout 可见性). 生产 .app 仍 silent — 但 ipcRenderer.send 失败极罕见
      // (Electron preload 内 ipcRenderer 永远 available), 这分支主要给 type narrow.
      console.error(e);
    }
}

export type AgentDeckApi = typeof api;
