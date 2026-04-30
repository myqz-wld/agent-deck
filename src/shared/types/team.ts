/**
 * 跨进程共享：Agent Teams (M2/M3) 类型。
 */

import type { AgentEvent } from './agent';
import type { SessionRecord } from './session';

/**
 * Agent Teams 团队成员（来自 ~/.claude/teams/<name>/config.json 的 members 数组）。
 * Claude Code 自管这个文件，应用层只读不写。字段按官方文档约定，但**实验特性 schema
 * 可能演进**，所有字段除 name 外都标可选，解析失败兜底降级而不是报错。
 */
export interface TeamMember {
  /** 成员名（lead 在 config.json 里也以一个成员条目存在） */
  name: string;
  /** subagent 类型（如 "general-purpose" / "agent-deck:reviewer-claude"） */
  agentType?: string;
  /** Claude 内部分配的 agent id（不是应用层 sessionId） */
  agentId?: string;
  /** 仅 split-pane 模式下有：该 teammate 自己的 SDK session_id */
  sessionId?: string;
  /** 任意附加字段（schema 演进时不丢） */
  [key: string]: unknown;
}

/** ~/.claude/teams/<name>/config.json 解析结果。corrupt / 文件不存在 → readTeamConfig 返回 null。 */
export interface TeamConfig {
  members: TeamMember[];
  /** mtime（毫秒），renderer 显示「上次更新 X 分钟前」用 */
  mtime: number;
  /** 原始 JSON（解析失败时为 null）；UI 调试 / 「显示 raw config」入口用 */
  raw: Record<string, unknown> | null;
}

/**
 * 一个 team 的完整快照：聚合 SQL 里同 team_name 的 sessions + fs 里 ~/.claude/teams/<name>/config.json
 * 的成员清单 + ~/.claude/tasks/<name>/ 下的 shared task list markdown。
 * TeamHub / TeamDetail 一次性拉取这个对象渲染。
 */
export interface TeamSnapshot {
  name: string;
  /** 应用 DB sessions 表里 team_name = name 的会话（含 closed / archived） */
  sessions: SessionRecord[];
  /** ~/.claude/teams/<name>/config.json 解析结果；目录不存在或 JSON 损坏 → null */
  config: TeamConfig | null;
  /** ~/.claude/tasks/<name>/ 下的 shared task list 文件路径（绝对路径，UI 显示用） */
  taskListFile: string | null;
  /** task list markdown 文本；目录 / 文件不存在 → null */
  taskListMarkdown: string | null;
  /** task list 文件 mtime（毫秒）；用于 UI 显示「最后更新时间」+ chokidar 防抖判断 */
  taskListMtime: number | null;
  /**
   * Agent Teams M3：team 内所有 team-* event（最近 100 条），按 ts DESC。
   * 来自 hook-server 接 TaskCreated / TaskCompleted / TeammateIdle 写入 events 表，
   * JOIN sessions 表按 team_name 聚合。renderer TeamDetail 事件流 section 用。
   */
  events: AgentEvent[];
}

/**
 * TeamList IPC 返回的简表项（不含完整 sessions / task list 内容，仅元信息）。
 * TeamHub 列表用，避免 N 个 team 一次拉全量数据撑爆 IPC payload。
 */
export interface TeamSummary {
  name: string;
  /** 应用 DB 里 team_name = name 的 sessions 数量 */
  sessionCount: number;
  /** ~/.claude/teams/<name>/config.json 是否存在（即 Claude 已建队） */
  hasConfig: boolean;
  /** ~/.claude/tasks/<name>/ 是否存在且含至少 1 个 .md */
  hasTasks: boolean;
  /** sessions 表里同 team 最后一条 lastEventAt；无 session 则 null */
  lastEventAt: number | null;
}

/** TeamDataChanged IPC event payload：哪个 team 的哪个数据源变了，renderer 据此决定要不要重拉。 */
export interface TeamDataChangedEvent {
  name: string;
  /** 'config' = config.json 变了；'task-list' = tasks 目录下的 markdown 变了；'unlinked' = 整个 team 目录被删 */
  kind: 'config' | 'task-list' | 'unlinked';
}

/**
 * Agent Teams M3 hook event payload。Claude Code v2.1.32+ 实验特性 hook
 * （TaskCreated / TaskCompleted / TeammateIdle）转换后的 AgentEvent payload 形态。
 *
 * **字段全可选 + raw 备查**：实验特性 schema 仍在演进，hook payload 可能改字段名 / 结构；
 * translate 函数 best-effort 提取常见字段（`teamName` / `teammateName` / `task.*`），
 * 同时把原始 hook payload 全量塞进 raw，让 UI / debug 能看全。
 */
export interface TeamTaskPayload {
  cwd?: string;
  /** 来自 hook payload 的 team_name 字段（lead 所属 team） */
  teamName?: string;
  /** 来自 hook payload 的 teammate_name / agent_name（如果是某 teammate 创建/完成的 task） */
  teammateName?: string;
  /** 任务 id（如果 hook 给了；用于跨 created/completed 事件配对） */
  taskId?: string;
  /** 任务描述（hook 给的 description / title / content） */
  description?: string;
  /** 指派对象（如果 lead 显式分派） */
  assignee?: string;
  /** 依赖 task id 列表（hook 给了 depends_on / dependencies） */
  dependsOn?: string[];
  /** 状态（hook 给了 status / state，如 'pending' / 'in_progress' / 'done'） */
  status?: string;
  /** 完整原始 hook payload，UI 调试 / schema 演进时可全量看 */
  raw?: Record<string, unknown>;
}

export interface TeamTeammateIdlePayload {
  cwd?: string;
  /** 来自 hook payload 的 team_name */
  teamName?: string;
  /** 哪个 teammate idle 了 */
  teammateName?: string;
  /** 上次完成的 task 描述（如果 hook 给了） */
  lastTask?: string;
  /** idle 原因（如 'task-complete' / 'no-pending-tasks' / 'manual-shutdown'） */
  reason?: string;
  /** 完整原始 hook payload */
  raw?: Record<string, unknown>;
}
