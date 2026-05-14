/**
 * preload/api/events: 全局事件订阅 facade。
 *
 * 包含 main → renderer 的实时推送订阅（agent event / session 增删改 / summary / task /
 * pin / transparent / focus request）。每个订阅返回 unsubscribe 函数。
 *
 * 注：team / message 域的两个订阅（onAgentDeckTeamChanged / onAgentDeckMessageChanged）
 * 在 api/teams.ts 内（语义归属）。
 *
 * R37 P1 Step 1.1：8 个 onXxx 5 行模板（`const handler = ...; on(); return off`）
 * 压缩为单行 `subscribe<T>(channel, cb)` 调用，节省 -32 LOC + 防漏 unsubscribe。
 */

import { IpcEvent } from '@shared/ipc-channels';
import type {
  AgentEvent,
  SessionRecord,
  SummaryRecord,
  TaskChangedEvent,
} from '@shared/types';
import { subscribe } from './_helpers';

export const eventsApi = {
  // 事件订阅
  onAgentEvent: (cb: (e: AgentEvent) => void): (() => void) =>
    subscribe<AgentEvent>(IpcEvent.AgentEvent, cb),
  onSessionUpserted: (cb: (s: SessionRecord) => void): (() => void) =>
    subscribe<SessionRecord>(IpcEvent.SessionUpserted, cb),
  onSessionRemoved: (cb: (id: string) => void): (() => void) =>
    subscribe<string>(IpcEvent.SessionRemoved, cb),
  onSessionRenamed: (cb: (p: { from: string; to: string }) => void): (() => void) =>
    subscribe<{ from: string; to: string }>(IpcEvent.SessionRenamed, cb),
  onSummaryAdded: (cb: (s: SummaryRecord) => void): (() => void) =>
    subscribe<SummaryRecord>(IpcEvent.SummaryAdded, cb),
  /**
   * Task Manager (CHANGELOG_43)：订阅 tasks 写操作（create/update/delete）after-commit
   * 推送。当前 renderer 没 task UI 消费此事件（Layer A+B only），但基础设施有了，未来
   * 加 Tasks tab 直接 onTaskChanged 订阅即可（与 onTeamDataChanged 同模式）。
   */
  onTaskChanged: (cb: (e: TaskChangedEvent) => void): (() => void) =>
    subscribe<TaskChangedEvent>(IpcEvent.TaskChanged, cb),
  onPinToggled: (cb: (pinned: boolean) => void): (() => void) =>
    subscribe<boolean>(IpcEvent.PinToggled, cb),
  onTransparentToggled: (cb: (transparent: boolean) => void): (() => void) =>
    subscribe<boolean>(IpcEvent.TransparentToggled, cb),
  onSessionFocusRequest: (cb: (sessionId: string) => void): (() => void) =>
    subscribe<string>(IpcEvent.SessionFocusRequest, cb),
};
