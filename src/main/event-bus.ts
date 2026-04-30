import type { EventEmitter } from 'node:events';

/**
 * 类型化的事件总线封装。其它模块通过 emit/on/off 与之交互，
 * 避免直接依赖 Node EventEmitter 的非类型化签名。
 */

import { EventEmitter as NodeEventEmitter } from 'node:events';
import type {
  AgentEvent,
  SessionRecord,
  SummaryRecord,
  TaskChangedEvent,
  TeamDataChangedEvent,
  TeamPermissionCancelled,
  TeamPermissionRequest,
} from '@shared/types';

export interface EventMap {
  'agent-event': [AgentEvent];
  'session-upserted': [SessionRecord];
  'session-removed': [string];
  /** SDK fallback 路径：from=tempKey, to=真实 SDK session_id */
  'session-renamed': [{ from: string; to: string }];
  'summary-added': [SummaryRecord];
  /** CLI 子命令新建会话后请求 renderer 切到「实时」并选中该 sessionId。 */
  'session-focus-request': [string];
  /** Agent Teams M2：team 的 fs 数据变了（config.json / task list / 整个目录被 unlink）。
   *  team-watcher emit；main bootstrap 桥接到 IPC IpcEvent.TeamDataChanged 推 renderer。 */
  'team-data-changed': [TeamDataChangedEvent];
  /** Task Manager (CHANGELOG_43)：tasks 表写操作（task_create/update/delete handler 内
   *  调用 repo 成功后 emit）。main bootstrap 桥接到 IPC IpcEvent.TaskChanged 推 renderer。 */
  'task-changed': [TaskChangedEvent];
  /** Inbox Watcher：teammate 在 inbox 文件里写了一条 permission_request，被识别后 emit。
   *  main bootstrap 桥接到 IPC IpcEvent.TeamPermissionRequested + 同时也走 IpcEvent.AgentEvent
   *  转 waiting-for-user kind 推 PendingTab。 */
  'team-permission-requested': [TeamPermissionRequest];
  /** Inbox Watcher：teammate 自己 abort 了 permission（idle_notification 触发，详见
   *  TeamPermissionCancelled 注释）。main bootstrap 桥接到 IpcEvent.AgentEvent 转
   *  waiting-for-user kind 让 store 从 pendingTeamPerm 删 + activity-feed 标灰。 */
  'team-permission-cancelled': [TeamPermissionCancelled];
  /** UI 端响应（写 permission_response 回 teammate inbox）成功后 emit，让所有 renderer
   *  把对应的 pending 列表里这条删掉。payload: { teamName, requestId } */
  'team-permission-resolved': [{ teamName: string; requestId: string }];
}

export class TypedEventBus {
  private inner: EventEmitter = new NodeEventEmitter();

  emit<K extends keyof EventMap>(event: K, ...args: EventMap[K]): void {
    this.inner.emit(event, ...args);
  }

  on<K extends keyof EventMap>(
    event: K,
    listener: (...args: EventMap[K]) => void,
  ): () => void {
    this.inner.on(event, listener as (...a: unknown[]) => void);
    return () => this.inner.off(event, listener as (...a: unknown[]) => void);
  }

  off<K extends keyof EventMap>(
    event: K,
    listener: (...args: EventMap[K]) => void,
  ): void {
    this.inner.off(event, listener as (...a: unknown[]) => void);
  }

  removeAllListeners(): void {
    this.inner.removeAllListeners();
  }
}

export const eventBus = new TypedEventBus();
