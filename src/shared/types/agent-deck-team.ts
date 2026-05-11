/**
 * Agent Deck Universal Team Backend types (R3.E1)
 *
 * 跨进程共享：adapter-agnostic team 抽象的核心类型。本文件仅依赖标准库 / TS 自带能力，
 * 不引入 Electron / Node 特有 API。
 *
 * 设计依据：`docs/agent-deck-team-protocol.md` (E0 ADR §2.4)。
 *
 * 与老 `team.ts` 的关系：
 * - 老 team.ts (TeamMember / TeamConfig / TeamSnapshot / TeamSummary / TeamDataChangedEvent /
 *   TeamTaskPayload / TeamTeammateIdlePayload) 在 PR-A 阶段保留（不破坏老 backend）
 * - PR-B (E6) 阶段整文件删除，所有 renderer / IPC 同步重写
 * - 老类型与本文件类型**无任何兼容 alias**：硬切策略下，老 inbox 协议 + fs watcher 的语义
 *   不对应新 backend 任何概念
 */

/**
 * Team member 角色二态。
 *
 * - 'lead'：可发起 spawn / 接 cross-adapter message / wait_reply teammate；一个 team 至少 1 个 lead
 *   （上限 10，invariant 由 repo 层 + vitest 强制，不走 SQL trigger）
 * - 'teammate'：仅参与 message 收发，不主动 spawn 其它 member
 */
export type AgentDeckTeamMemberRole = 'lead' | 'teammate';

/** team_members 表的运行时投影（DB row 经 repo 转 camelCase 后）。 */
export interface AgentDeckTeamMember {
  teamId: string;
  /** 关联到 sessions.id（FK ON DELETE RESTRICT，hard-delete 路径 §2.5 必须 pre-check leaveTeam） */
  sessionId: string;
  role: AgentDeckTeamMemberRole;
  /** 可选别名（如 "reviewer-claude"）；UI 显示优先于 sessions.title */
  displayName: string | null;
  joinedAt: number;
  /** NULL = active member；非 NULL = 退出（仍可 read 历史，但 universal-message-watcher 不再投递） */
  leftAt: number | null;
}

/** Team 元信息。`getWithMembers` 聚合时 members 字段非空，裸 list 时省略。 */
export interface AgentDeckTeam {
  id: string;
  /** 用户可见名；active 内 unique（部分索引落地，§2.2）；归档后允许重名 */
  name: string;
  createdAt: number;
  /** NULL = active；非 NULL = 用户归档（UI 默认隐藏，已 enqueued pending message 仍投递完成） */
  archivedAt: number | null;
  /**
   * JSON 自由扩展位（描述 / 标签 / 来源 'cli'/'ui'/'mcp' 等）。
   * **读路径必须 type-guard，禁止裸 cast**（reviewer INFO 收口）。
   * SQLite CHECK(json_valid(metadata)) 兜底，防误塞非 JSON。
   */
  metadata: Record<string, unknown>;
  /** 由 repo.getWithMembers 聚合返回；裸 team list 不带 */
  members?: AgentDeckTeamMember[];
}

/**
 * universal-message-watcher 的状态机（§4.3）。
 *
 * 终态（delivered / failed / cancelled）不可再变。
 * failed 后用户可在 UI 重新发同样内容（= insert 一条新 row），不支持「重试已 failed 的旧 row」。
 */
export type AgentDeckMessageStatus =
  | 'pending'      // 入队后待 watcher 投递
  | 'delivering'   // watcher 已选中并在调 adapter（短暂态；进程 crash recovery 见 §4.6）
  | 'delivered'    // adapter receiveTeammateMessage 成功
  | 'failed'       // 重试上限到达 / adapter 不支持 / session closed 等
  | 'cancelled';   // 显式 cancel（lead 撤回 / team 整体 archive 后兜底）

/**
 * cross-adapter 通讯的 envelope（不可变 + status 机器化推进）。
 *
 * 字段命名约定：DB row snake_case → repo 转 camelCase；本接口 camelCase。
 */
export interface AgentDeckMessage {
  id: string;
  teamId: string;
  /** 不强制 FK（允许已 closed / 已删的 sender 留痕）；displayName 反查走 §4.4 fallback 链 */
  fromSessionId: string;
  toSessionId: string;
  /**
   * 消息正文。**100KB hard cap**（caller-side 在 messageRepo.insert 校验 +
   * SQLite CHECK(length(body) <= 102400) 兜底）。
   *
   * watcher 投递前会拼上 §4.4 统一 wire 前缀 `[from <displayName> @ <adapterId>]\n`，
   * 但 DB body 列存的是**原始 body 字符串**（前缀拼装在 watcher 内存里完成，不写回 DB）。
   * adapter 端调 receiveTeammateMessage 时收到的是「带前缀的完整 body」。
   */
  body: string;
  status: AgentDeckMessageStatus;
  /** failed / cancelled 时的可读原因（UI 显示）；其他状态 NULL */
  statusReason: string | null;
  /** caller 入队时间（不可变） */
  sentAt: number;
  /** watcher 成功调 receiveTeammateMessage 后填；其它状态 NULL */
  deliveredAt: number | null;
  /** 已用 attempt 次数。0 初始 → throw 时 ++ → ≥ MAX_RETRY (3) 进 failed */
  attemptCount: number;
  /**
   * 最近一次 attempt 触发时间（reviewer HIGH-1 修法：替代 sent_at 做退避基准）。
   * NULL = 从未尝试；非 NULL = 上次 attempt 时间，下次 poll 用 backoff(attemptCount) 算 next eligible。
   */
  lastAttemptAt: number | null;
  /**
   * 进入 delivering 状态时间。crash recovery (§4.6) 用：
   * 进程启动时 watcher 把 status='delivering' 的行重置为 'pending'（**不 ++ attemptCount**），
   * 让 last_attempt_at 主导 backoff 节奏。
   */
  deliveringSince: number | null;
}

/**
 * §4.9 dispatcher 投给 adapter.notifyTeammateEvent 的元事件 union。
 *
 * 设计为 best-effort：dispatcher 不等返回也不重试，adapter 可不实现（默认丢弃）。
 * 实现的 adapter 把事件以 system message / banner 形式插入 session
 * （如 "[team] codex-helper joined"）。
 */
export type AgentDeckTeammateEvent =
  | { kind: 'member-joined'; teamId: string; sessionId: string; displayName: string }
  | { kind: 'member-left'; teamId: string; sessionId: string; displayName: string }
  | { kind: 'team-archived'; teamId: string };

// ────────────────────────────────────────────────────────────────────────────
// IPC / event-bus payload（§6.5 新 event）
// ────────────────────────────────────────────────────────────────────────────

/**
 * `agent-deck-team-member-changed` event payload（§6.5）。
 *
 * 触发点：members 表 insert / update (role/displayName) / leave 后；
 * IPC 桥接层 16ms debounce + per-team 累加合并，避免 burst 投递时 renderer 高频重渲染。
 */
export interface AgentDeckTeamMemberChangedEvent {
  teamId: string;
  sessionId: string;
  /**
   * - 'joined': 新加入（agent_deck_team_members INSERT）
   * - 'left':   退出（leftAt set 非 NULL）
   * - 'role-changed': role 字段变更（lead ↔ teammate）
   */
  kind: 'joined' | 'left' | 'role-changed';
}

/**
 * `agent-deck-message-status-changed` event payload（§6.5）。
 *
 * 触发点：watcher 每次 update messages.status 后；
 * IPC 桥接层同款 16ms debounce + per-team 合并。
 */
export interface AgentDeckMessageStatusChangedEvent {
  id: string;
  teamId: string;
  status: AgentDeckMessageStatus;
  statusReason: string | null;
}
