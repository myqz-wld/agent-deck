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
  IssueChangedEvent,
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
   * Issue Tracker (plan issue-tracker-mcp-20260529 §Step 3.4.2 + §不变量)：issues 表写
   * 操作（report_issue / append_issue_context mcp tool + IPC IssuesUpdate / IssuesSoftDelete /
   * IssuesUndelete / IssuesResolveInNewSession handler + IssueLifecycleScheduler tick 内调用
   * issueRepo 成功后 emit）。main bootstrap 桥接到 IPC IpcEvent.IssueChanged 推 renderer。
   *
   * kind 语义见 IssueChangedEvent.kind 注释（created / updated / appended / softDeleted /
   * undeleted / hardDeleted）。hardDeleted 时 event.issue=null + sourceSessionId 取删前 snapshot
   * 让 renderer 仍能精细 invalidate（§D7 R3 LOW F7 与 TaskChangedEvent.ownerSessionId 对称）。
   */
  'issue-changed': [IssueChangedEvent];
  /**
   * archive-failure-ux-upthrow-20260515 plan(P1 已落地)+ archive-toctou-fix-20260515 plan
   * (R1 双方共识 union narrow + 加 'probe-throw'): caller archive 失败 UX 上抛通道。
   *
   * 触发点 3 处（mcp baton-cleanup 2 + K3 SessionHandOffSpawn 1）：
   * - baton-cleanup.ts probe 路径(reasonKind='row-missing' getFn 返回 null / 'probe-throw' getFn 抛错)
   * - baton-cleanup.ts archiveFn 路径(reasonKind='row-missing' SessionRowMissingError / 'archive-throw' 其他 Error)
   * - ipc/sessions.ts SessionHandOffSpawn archive 路径同款 reasonKind 区分
   *
   * main/index.ts bootstrap listener 桥接到 notifyUser + safeSend(IpcEvent.CallerArchiveFailed)。
   * 不在 mcp handler 内直接 import notify/visual.ts —— 保持 mcp handler 与通知层职责分离。
   *
   * archive-toctou-fix-20260515 plan: toolName 从 `string` narrow 到 union literal,加新 emit
   * 触发点忘加 TOOL_DISPLAY_NAME 映射时 tsc 编译期 fail(强制完整覆盖)。reasonKind 加 'probe-throw'
   * 区分 DB 异常 (可重试) 与 row 真不存在 (重试无效),给 UI 准确决策依据。
   */
  'caller-archive-failed': [{
    sessionId: string;
    /**
     * 触发的工具名(union narrow):
     * - 'archive_plan' / 'hand_off_session': mcp tool 名(用户在 codex/claude 调用 mcp 时熟悉)
     * - 'SessionHandOffSpawn': K3 IPC channel 内部名(用户 UI 看不到,main listener 通过
     *   TOOL_DISPLAY_NAME 映射成「会话接力」)
     * 加新 emit 触发点必须先在此 union 加值,否则 baton-cleanup / sessions-hand-off-helper
     * 调用处 tsc 报错(✅ feature)。
     */
    toolName: 'archive_plan' | 'hand_off_session' | 'SessionHandOffSpawn';
    /** 完整 reason 描述（含 stringified Error 或 'not in sessions table' 类提示），UI 显示用 */
    reason: string;
    /**
     * 失败子类，决定 UI 是否显示「重试归档」按钮:
     * - 'row-missing': row 真不存在 (getSession 返回 null 或 setArchived 抛 SessionRowMissingError) →
     *   重试无效,UI 仅告知;K3 IPC SessionArchive handler 视为幂等静默 (row 已不在 = 等价已归档无害)
     * - 'probe-throw': getSession 自身抛错 (SQLite locked / DB read failure 等) → 状态未知,可重试,
     *   UI 显示「重试归档」按钮(与 'archive-throw' 同款重试路径,但 reason 文案区分 DB probe 错)
     * - 'archive-throw': row 存在但 archive 函数抛错 (FK constraint / DB locked 等非 SessionRowMissingError) →
     *   row 仍存在,可重试,UI 显示「重试归档」按钮
     */
    reasonKind: 'row-missing' | 'probe-throw' | 'archive-throw';
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
