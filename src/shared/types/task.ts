/**
 * 跨进程共享：Task Manager 类型（plan task-team-id-restore-20260525 v024 重设计 — v023
 * follow-up 加回 team_id NULLABLE 字段消灭 lead 多 team task 串流 + hand_off ownership 边界）。
 */

/**
 * Task Manager 的状态枚举。对齐 Claude Code CLI TaskCreate / TaskUpdate 的字段语义，
 * 方便将来跟 ~/.claude/tasks/<team>/<list>.md 自然语言任务互通（互通方向：
 * 本结构化 task → markdown 摘要；不反向同步）。
 */
export type TaskStatus = 'pending' | 'active' | 'completed' | 'blocked' | 'abandoned';

/**
 * Task Manager 持久化记录。in-process MCP server 5 个工具（task_create / task_list /
 * task_get / task_update / task_delete）的统一返回形状。
 *
 * 字段语义（plan task-team-id-restore-20260525 v024 schema）：
 * - id：UUID v4，create 时由 repo 自动生成
 * - ownerSessionId：必填，绑当前 session（v023 起 task 必有 owner，无 global task 概念）。
 *   session 被 sessionRepo.delete 时 ON DELETE CASCADE 自动删 task（plan §不变量 1）。
 * - teamId：v024 新增，NULL = personal task（仅 owner 可见可写，first-class 用例）/
 *   非 NULL = team-bound task（caller 必须在该 team 是 active member 才能可见可写,
 *   plan §设计决策 D1-D3 / §不变量 2-3）。team 硬删 ON DELETE SET NULL 让 task 退化为
 *   personal task（仍挂 owner_session_id 名下不丢，§不变量 4）。
 * - blocks / blockedBy：任务 ID 数组，构成依赖图。当前实现**不**做循环检测
 *   （sdk-task-manager-spec §5 known limitation）。
 * - createdAt / updatedAt：ISO8601 字符串。每次 update 强制刷新 updatedAt（reassignOwner
 *   操作不刷 updatedAt 让 list 默认排序保持稳定 — §不变量 11）。
 */
export interface TaskRecord {
  id: string;
  /** v023：必填 owner session id。FK → sessions(id) ON DELETE CASCADE。 */
  ownerSessionId: string;
  /**
   * v024：team 归属字段（plan task-team-id-restore-20260525 D1）。
   * - `null` = personal task（仅 owner 可见可写,first-class 用例 — RFC R1.Q1 用户强调「没有加入 team 也能起 task」）
   * - `string` (team uuid) = team-bound task,caller 必须在该 team 是 active member（D3）
   * FK → agent_deck_teams(id) ON DELETE SET NULL（team 硬删时退化为 personal,不丢,§不变量 4）。
   */
  teamId: string | null;
  subject: string;
  description: string | null;
  status: TaskStatus;
  activeForm: string | null;
  priority: number;
  blocks: string[];
  blockedBy: string[];
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Task Manager 写操作事件。tools.ts 的 task_create / task_update / task_delete handler
 * 在 repo 写完后通过 main 进程 eventBus emit；main/index.ts 桥接到 IpcEvent.TaskChanged
 * 推 renderer。当前 renderer 没有 task UI 消费这个事件，未来加 Tasks tab 直接
 * onTaskChanged 订阅。
 */
export interface TaskChangedEvent {
  kind: 'created' | 'updated' | 'deleted';
  taskId: string;
  /** deleted 时是 null；created/updated 时是新状态 */
  task: TaskRecord | null;
  /** v023：方便 renderer 按 owner 过滤；deleted 时取自被删 task 原 ownerSessionId */
  ownerSessionId: string | null;
  ts: number;
}
