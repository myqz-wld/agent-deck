/**
 * 跨进程共享：Task Manager (v007 / CHANGELOG_41 / CHANGELOG_43) 类型。
 */

/**
 * Task Manager（v007 / CHANGELOG_41）的状态枚举。对齐 Claude Code CLI TaskCreate /
 * TaskUpdate 的字段语义，方便将来跟 ~/.claude/tasks/<team>/<list>.md 自然语言任务
 * 互通（互通方向：本结构化 task → markdown 摘要；不反向同步）。
 */
export type TaskStatus = 'pending' | 'active' | 'completed' | 'blocked' | 'abandoned';

/**
 * Task Manager 持久化记录。in-process MCP server 5 个工具（task_create / task_list /
 * task_get / task_update / task_delete）的统一返回形状。
 *
 * 字段语义：
 * - id：UUID v4，create 时由 repo 自动生成
 * - teamName：与 sessions.team_name 同语义。null = 全局任务；非 null = 该 team 范围
 *   共享。team 在 fs 被 Claude 删掉后**不**联动删 task（保留为 orphan）。
 * - blocks / blockedBy：任务 ID 数组，构成依赖图。当前实现**不**做循环检测
 *   （sdk-task-manager-spec §5 known limitation）。
 * - createdAt / updatedAt：ISO8601 字符串。每次 update 强制刷新 updatedAt。
 */
export interface TaskRecord {
  id: string;
  /** @deprecated R3.E8：保留只读历史；新代码用 teamId（v011 起 universal team backend）。 */
  teamName: string | null;
  /** R3.E8 / v011：universal team backend id；新代码主路径。 */
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
 * Task Manager 写操作事件（CHANGELOG_43）。tools.ts 的 task_create / task_update /
 * task_delete handler 在 repo 写完后通过 main 进程 eventBus emit；main/index.ts
 * 桥接到 IpcEvent.TaskChanged 推 renderer。
 *
 * 当前 renderer 没有 task UI 消费这个事件，未来加 Tasks tab 直接 onTaskChanged 订阅。
 */
export interface TaskChangedEvent {
  kind: 'created' | 'updated' | 'deleted';
  taskId: string;
  /** deleted 时是 null；created/updated 时是新状态 */
  task: TaskRecord | null;
  /** R3.E8：方便 renderer 按 team 过滤；deleted 时取自被删 task 原 teamId */
  teamId: string | null;
  /** @deprecated R3.E8：兼容旧 renderer；新代码用 teamId */
  teamName: string | null;
  ts: number;
}
