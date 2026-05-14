/**
 * preload/index: contextBridge facade 拼装入口。
 *
 * **CHANGELOG_105 拆分**（universal-message-watcher-split-20260514 #2）：原 524 LOC 单文件
 * 按域拆为 5 个 `api/` 子文件 + 本 facade（spread 拼装 + contextBridge.expose）：
 * - `api/sessions.ts`  会话 CRUD / 历史 / 子表 / hand-off
 * - `api/adapters.ts`  Adapter 通道 / pending response / sandbox 冷切
 * - `api/teams.ts`     R3.E8 Universal Team Backend
 * - `api/misc.ts`      app / window / hook / settings / dialog / claude-md / assets / image / summarizer
 * - `api/events.ts`    全局事件订阅（agent / session / summary / task / window）
 *
 * `typeof api` 类型推导走 spread 字面量合并，外部 `AgentDeckApi` 类型 zero-change。
 */

import { contextBridge } from 'electron';
import { sessionsApi } from './api/sessions';
import { adaptersApi } from './api/adapters';
import { teamsApi } from './api/teams';
import { miscApi } from './api/misc';
import { eventsApi } from './api/events';

const api = {
  ...sessionsApi,
  ...adaptersApi,
  ...teamsApi,
  ...miscApi,
  ...eventsApi,
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api);
    // REVIEW_35 MED-B4: 删除 raw electronIpc.invoke(channel: string) 兜底通道。
    // 该通道 0 个 renderer 消费方（grep 实证），让新增 channel 可绕过 AgentDeckApi 强类型 facade
    // 是潜在反模式。HistoryPanel.tsx:56 注释也明确说「走 preload 强类型 facade 而非 ipcInvokeRaw」。
    // 真未来需要动态 channel 时显式重新 export，避免长期保留死代码。
  } catch (e) {
    console.error(e);
  }
} else {
  (window as unknown as { api: typeof api }).api = api;
}

export type AgentDeckApi = typeof api;
