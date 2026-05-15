import type { EventEmitter } from 'node:events';

/**
 * 类型化的事件总线封装。其它模块通过 emit/on/off 与之交互，
 * 避免直接依赖 Node EventEmitter 的非类型化签名。
 *
 * R3.E9 (PR-B) 重写：删除 4 个老 team event（team-data-changed / team-permission-*）
 * + 新增 6 个 universal team event（agent-deck-team-* / agent-deck-message-*）。
 * 详 docs/agent-deck-team-protocol.md §6.5。
 */

import { EventEmitter as NodeEventEmitter } from 'node:events';
import type {
  AgentDeckMessageStatusChangedEvent,
  AgentDeckTeam,
  AgentDeckTeamMemberChangedEvent,
  AgentEvent,
  SessionRecord,
  SummaryRecord,
  TaskChangedEvent,
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
  /** Task Manager (CHANGELOG_43)：tasks 表写操作（task_create/update/delete handler 内
   *  调用 repo 成功后 emit）。main bootstrap 桥接到 IPC IpcEvent.TaskChanged 推 renderer。 */
  'task-changed': [TaskChangedEvent];
  /**
   * archive-failure-ux-upthrow-20260515 plan：caller archive 失败 UX 上抛通道。
   *
   * 触发点 3 处（mcp baton-cleanup 2 + K3 SessionHandOffSpawn 1）：
   * - baton-cleanup.ts row-missing 短路（reasonKind='row-missing'，reason 含 sessionRepo.get 返回 null 上下文）
   * - baton-cleanup.ts archiveFn 抛错（reasonKind='archive-throw'，reason 含 stringified Error）
   * - ipc/sessions.ts SessionHandOffSpawn archive 抛错（reasonKind='archive-throw'）
   *
   * main/index.ts bootstrap listener 桥接到 notifyUser + safeSend(IpcEvent.CallerArchiveFailed)。
   * 不在 mcp handler 内直接 import notify/visual.ts —— 保持 mcp handler 与通知层职责分离。
   */
  'caller-archive-failed': [{
    sessionId: string;
    /** 触发的工具名（'archive_plan' / 'hand_off_session' / 'SessionHandOffSpawn'），方便用户区分场景 */
    toolName: string;
    /** 完整 reason 描述（含 stringified Error 或 'not in sessions table' 类提示），UI 显示用 */
    reason: string;
    /**
     * 失败子类，决定 UI 是否显示「重试归档」按钮:
     * - 'row-missing': sessionRepo.get 返回 null（session 已被异常清理 / 长 async 期间被删）→ 重试无效，仅告知
     * - 'archive-throw': sessionManager.archive 抛错（FK constraint / DB locked 等）→ row 仍存在，可重试
     */
    reasonKind: 'row-missing' | 'archive-throw';
  }];

  // ──────────── R3.E9 universal team backend events（ADR §6.5）────────────
  /** repo.create 成功后；payload = AgentDeckTeam（裸，不含 members）。 */
  'agent-deck-team-created': [AgentDeckTeam];
  /** repo.archive / unarchive / metadata 更新后；payload = 最新 AgentDeckTeam。 */
  'agent-deck-team-updated': [AgentDeckTeam];
  /** repo.hardDelete 成功后；payload = { id }（仅 admin / 测试用）。 */
  'agent-deck-team-deleted': [{ id: string }];
  /** members 表 insert/update/leave 后。kind 区分新加入 / 退出 / role 变更。 */
  'agent-deck-team-member-changed': [AgentDeckTeamMemberChangedEvent];
  /** messageRepo.insert 后；watcher 监听此 event 立刻 process（debounced 50ms 防 burst）。 */
  'agent-deck-message-enqueued': [{ id: string; teamId: string; fromSessionId: string; toSessionId: string }];
  /** watcher 每次 update messages.status 后；UI 显示投递进度用。 */
  'agent-deck-message-status-changed': [AgentDeckMessageStatusChangedEvent];
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
