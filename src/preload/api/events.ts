/**
 * preload/api/events: 全局事件订阅 facade。
 *
 * 包含 main → renderer 的实时推送订阅（agent event / session 增删改 / summary / task /
 * pin / transparent / focus request）。每个订阅返回 unsubscribe 函数。
 *
 * 注：team / message 域的两个订阅（onAgentDeckTeamChanged / onAgentDeckMessageChanged）
 * 在 api/teams.ts 内（语义归属）。
 */

import { ipcRenderer } from 'electron';
import { IpcEvent } from '@shared/ipc-channels';
import type {
  AgentEvent,
  SessionRecord,
  SummaryRecord,
  TaskChangedEvent,
} from '@shared/types';

export const eventsApi = {
  // 事件订阅
  onAgentEvent: (cb: (e: AgentEvent) => void): (() => void) => {
    const handler = (_: unknown, e: AgentEvent): void => cb(e);
    ipcRenderer.on(IpcEvent.AgentEvent, handler);
    return () => ipcRenderer.off(IpcEvent.AgentEvent, handler);
  },
  onSessionUpserted: (cb: (s: SessionRecord) => void): (() => void) => {
    const handler = (_: unknown, s: SessionRecord): void => cb(s);
    ipcRenderer.on(IpcEvent.SessionUpserted, handler);
    return () => ipcRenderer.off(IpcEvent.SessionUpserted, handler);
  },
  onSessionRemoved: (cb: (id: string) => void): (() => void) => {
    const handler = (_: unknown, id: string): void => cb(id);
    ipcRenderer.on(IpcEvent.SessionRemoved, handler);
    return () => ipcRenderer.off(IpcEvent.SessionRemoved, handler);
  },
  onSessionRenamed: (cb: (p: { from: string; to: string }) => void): (() => void) => {
    const handler = (_: unknown, p: { from: string; to: string }): void => cb(p);
    ipcRenderer.on(IpcEvent.SessionRenamed, handler);
    return () => ipcRenderer.off(IpcEvent.SessionRenamed, handler);
  },
  onSummaryAdded: (cb: (s: SummaryRecord) => void): (() => void) => {
    const handler = (_: unknown, s: SummaryRecord): void => cb(s);
    ipcRenderer.on(IpcEvent.SummaryAdded, handler);
    return () => ipcRenderer.off(IpcEvent.SummaryAdded, handler);
  },
  /**
   * Task Manager (CHANGELOG_43)：订阅 tasks 写操作（create/update/delete）after-commit
   * 推送。当前 renderer 没 task UI 消费此事件（Layer A+B only），但基础设施有了，未来
   * 加 Tasks tab 直接 onTaskChanged 订阅即可（与 onTeamDataChanged 同模式）。
   */
  onTaskChanged: (cb: (e: TaskChangedEvent) => void): (() => void) => {
    const handler = (_: unknown, e: TaskChangedEvent): void => cb(e);
    ipcRenderer.on(IpcEvent.TaskChanged, handler);
    return () => ipcRenderer.off(IpcEvent.TaskChanged, handler);
  },
  onPinToggled: (cb: (pinned: boolean) => void): (() => void) => {
    const handler = (_: unknown, pinned: boolean): void => cb(pinned);
    ipcRenderer.on(IpcEvent.PinToggled, handler);
    return () => ipcRenderer.off(IpcEvent.PinToggled, handler);
  },
  onTransparentToggled: (cb: (transparent: boolean) => void): (() => void) => {
    const handler = (_: unknown, transparent: boolean): void => cb(transparent);
    ipcRenderer.on(IpcEvent.TransparentToggled, handler);
    return () => ipcRenderer.off(IpcEvent.TransparentToggled, handler);
  },
  onSessionFocusRequest: (cb: (sessionId: string) => void): (() => void) => {
    const handler = (_: unknown, sessionId: string): void => cb(sessionId);
    ipcRenderer.on(IpcEvent.SessionFocusRequest, handler);
    return () => ipcRenderer.off(IpcEvent.SessionFocusRequest, handler);
  },
};
