# ADR — Agent Deck Universal Team Backend (E0)

> R3 阶段架构决策记录。本文件先于 E1-E13 任何代码落地，定义 universal team 数据模型、
> AgentAdapter 接口扩展、universal-message-watcher 投递语义、agent-deck-mcp 接管路径、
> 以及对老 Claude Code Agent Teams in-process backend 的硬切删除清单。所有 R3 后续任务
> 以本文件为单一信源。

**状态**：ACCEPTED（2026-05-11；reviewer 双对抗 5+5 HIGH 经反驳轮收敛后全部 ✅ / ❓→MED 修订）
**关联**：plan v3 R3 节 / `docs/agent-deck-mcp-protocol.md` (R2 ADR) / CHANGELOG_45-47 / CHANGELOG_56 / REVIEW_17

---

## 1. 目标 & 非目标

### 1.1 目标

把 Agent Deck 的 team 抽象从「Claude Code Agent Teams in-process backend 的薄壁纸」**硬切**
为 **adapter-agnostic 的 first-class 容器**，让任意 adapter（claude-code / codex-cli）的
session 都能以 member 身份加入 team，并通过 DB 通道接收 / 发送 cross-adapter
message，无需依赖 Claude Code CLI 的 `~/.claude/teams/<X>/` 目录、inbox 文件协议、CLI 实验
特性 env。

完成后的核心能力：

```
[Team T = { lead: claude-session-A, teammate: codex-session-B }]
                                          ↑
[claude-session-A] —MCP→ mcp__agent-deck__send_message(target_session: codex-B, team_id: T, text: ...)
                                          ↓
[universal-message-watcher（DB row → adapter dispatch）]
                                          ↓
[codex.adapter.receiveTeammateMessage(codex-B, fromMemberId: claude-A, content: ...)]
                                          ↓
[codex-session-B 内显示为 user message 进 turn]
```

### 1.2 非目标

- **不**复刻 Claude Code Agent Teams 的所有语义细节。CHANGELOG_45/46/56 + REVIEW_17 多轮加固
  里依附于 inbox 协议 / 文件 watcher / CLI 兼容兜底的实现细节（60s grace、prewarm、嵌套
  try/catch、reverse sync ...）一律不保留实现，仅保留**精神**：跨 session 消息传递的可靠性、
  permission_request 的可视化（仅限 own session）、teammate 离线时不阻塞 lead。新 backend
  在 DB / event-bus 层原生达成这些性质，而不是模拟 inbox 文件 race 条件。
- **不**引入 backend 抽象层 / 多 backend dispatch。只有一种 backend = `agent_deck_teams` SQL
  表 + universal-message-watcher。plan v3 §157 明确的「无 backend 抽象层」约束。
- **不**做 cross-tenant / multi-user 隔离。Agent Deck 是单用户桌面应用，team / member /
  message 全在同一信任域。
- **不**接管「用户在 Claude Code CLI 内自然语言起的 team」的可视化。CLI 内自起的 team 走
  `~/.claude/teams/<X>/config.json` + inbox 文件协议，硬切后**完全失明**——agent-deck 不再
  watch、不再 emit、不再在 PendingTab 弹 permission_request。replace 路径见 §10：用户必须改用
  `mcp__agent-deck__*` 6 个 tool 在 Claude 会话内编排 teammate。
- **不**在本 ADR 内重新定义 agent-deck-mcp 6 tool 的 wire schema **整体**（已在 R2 ADR §3 锁定）。
  本 ADR 仅对 `send_message` 与 `spawn_session` 做最小必要 amend（§5.1 / §5.2 详）；其他 tool
  schema 不动。R2 ADR §12 路线图原本提到「R3 加 create_team / delete_team / list_teams MCP
  tools」**作废**（§5.3 决策：不引入新 tool），R2 ADR 同 PR amend。
- **不**做 team 外 cross-session message（超出 R3 范围；任何 cross-session 通讯必须显式建 team）。

---

## 2. 数据模型

### 2.1 设计原则

- **DB 是 SSOT**（与 R2 spawn_chain v009 / sessions 表同款）。fs / event-bus / 任何 in-memory
  cache 都不能成为 team 状态权威源。
- **团队 ≠ 会话集合**。team 是一个独立 entity（有 id / name / metadata），sessions 通过 member
  表与 team 多对多关联。一个 session 可以同时在多个 team（如 reviewer-claude session 既在
  本轮 review team 又在历史汇总 team）。一个 team 可以零成员（用户先建 team 再陆续加 member），
  但一旦有成员则**必须**至少一个 lead；可以多 lead（multi-leader 协作场景），lead 数量上限 10
  （防御 fan-out 异常）。**该 invariant 由 repo 层（agent-deck-team-repo.removeMember /
  setRole）强制并配 vitest 单测覆盖**——SQL trigger 在 better-sqlite3 跨 statement 一致性弱，
  不走 trigger 路径。
- **active team name 唯一**：`agent_deck_teams.name` 在 `archived_at IS NULL` 子集内 UNIQUE
  （部分索引落地，§2.2）。归档后允许重名（同名复活 / 历史保留）。
- **member role 二态**：`lead | teammate`。没有 sub-role 概念（observer / approver / ...）；
  所有 collaboration capability 由 adapter 层 capabilities 决定，不在 member 表区分。
- **message 是事件**，不是状态。`agent_deck_messages` 表存的是不可变 envelope（id +
  team_id + from_session_id + to_session_id + body + sent_at + status），状态变迁通过追加
  新 row 或 update status 列；不是「可编辑的 chat history」。
- **正交于 sessions 表**。新增的 3 张 team 表完全不依赖 `sessions.team_name` 列（v006 遗留），
  也不写它。`sessions.team_name` 标 deprecated，UI 不再读，下次大版本（v012+）删列。

### 2.2 SQL Schema（migration v010 + v011）

> 编号纠正：plan v3 §163 写的是 v008，但项目已存在 v008 (`sessions_codex_sandbox`) /
> v009 (`mcp_spawn_chain`)，本 ADR 实际落地编号 = **v010**（team 三表）+ **v011**（tasks.team_id
> 迁移，§5.4 详）。两个 migration 同 PR 落地。

```sql
-- v010_agent_deck_teams.sql

-- 1) team 元信息
CREATE TABLE IF NOT EXISTS agent_deck_teams (
  id          TEXT PRIMARY KEY NOT NULL,           -- nanoid 12 字符（与 task-repo 同款）
  name        TEXT NOT NULL,                       -- 用户可见名（active 内 unique，见下方部分索引）
  created_at  INTEGER NOT NULL,                    -- 毫秒
  archived_at INTEGER,                             -- NULL = active；非 NULL = 用户归档（UI 默认隐藏）
  metadata    TEXT NOT NULL DEFAULT '{}'           -- JSON（自由扩展位）
              CHECK (json_valid(metadata))         -- SQLite 兜底；防误塞非 JSON
);

-- active team name 唯一（archived 不限）：
-- 落地了 §2.1 invariant + §5.1 spawn_session ensure-team-by-name 并发安全（reviewer 反驳轮 finding #4）。
-- 用 INSERT ... ON CONFLICT DO NOTHING + 同步 SELECT 序列化（repo 层），不走 BEGIN IMMEDIATE 长事务避免
-- 与 universal-message-watcher poll 竞争 WAL 写锁。
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_deck_teams_active_name
  ON agent_deck_teams(name) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_agent_deck_teams_archived_at
  ON agent_deck_teams(archived_at);
CREATE INDEX IF NOT EXISTS idx_agent_deck_teams_created_at
  ON agent_deck_teams(created_at DESC);

-- 2) team ↔ session 多对多
--
-- session_id FK 用 RESTRICT（非 CASCADE）：sessions 行被 hard-delete（用户 UI 删 / lifecycle-scheduler
-- 30 天清理）时不会级联干掉 member 历史。session 删除前必须先调 agent-deck-team-repo.leaveTeam(sid)
-- 或 archiveTeam，否则 sessionRepo.delete throw FK 错。该护栏由 sessionManager.delete 内
-- pre-check 兜底（详 §2.5），UI 入口同步显式 confirm「成员 X 还在 team Y，删除会从 team 移除」。
--
-- team_id FK 仍 CASCADE：用户显式 hardDeleteTeam（管理员行为）才走，正常归档不删行。
CREATE TABLE IF NOT EXISTS agent_deck_team_members (
  team_id      TEXT NOT NULL REFERENCES agent_deck_teams(id) ON DELETE CASCADE,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  role         TEXT NOT NULL CHECK (role IN ('lead', 'teammate')),
  display_name TEXT,                                -- 可选别名（如 "reviewer-claude"）
  joined_at    INTEGER NOT NULL,                    -- 毫秒
  left_at      INTEGER,                             -- NULL = active；非 NULL = 退出（仍可 read，但 watcher 不再投递）
  PRIMARY KEY (team_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_team_members_session_id
  ON agent_deck_team_members(session_id);
CREATE INDEX IF NOT EXISTS idx_team_members_team_id_role
  ON agent_deck_team_members(team_id, role);
-- 反查「同 caller 与 target 共享哪些 team」用：
-- SELECT a.team_id FROM agent_deck_team_members a
-- INNER JOIN agent_deck_team_members b ON a.team_id=b.team_id
-- WHERE a.session_id=? AND b.session_id=? AND a.left_at IS NULL AND b.left_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_team_members_active_session
  ON agent_deck_team_members(session_id, team_id) WHERE left_at IS NULL;

-- 3) message envelope（cross-session 通讯日志 + 投递状态机）
CREATE TABLE IF NOT EXISTS agent_deck_messages (
  id              TEXT PRIMARY KEY NOT NULL,        -- nanoid 16 字符
  team_id         TEXT NOT NULL REFERENCES agent_deck_teams(id) ON DELETE CASCADE,
  from_session_id TEXT NOT NULL,                    -- 不强制 FK（允许已 closed / 已删的 sender 留痕）
  to_session_id   TEXT NOT NULL,                    -- 同上
  body            TEXT NOT NULL CHECK (length(body) <= 102400),  -- 100KB hard cap（caller-side 也校验）
  status          TEXT NOT NULL DEFAULT 'pending'   -- 状态机见 §4.3
                  CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'cancelled')),
  status_reason   TEXT,                             -- failed / cancelled 时的原因（可读，UI 显示）
  sent_at         INTEGER NOT NULL,                 -- 毫秒（caller 入队时间，不可变）
  delivered_at    INTEGER,                          -- watcher 成功调 receiveTeammateMessage 后填
  attempt_count   INTEGER NOT NULL DEFAULT 0,       -- watcher 重试次数（见 §4.5）
  -- HIGH-1 修法（reviewer 双对抗 finding #1）：last_attempt_at 替代 sent_at 做退避基准
  last_attempt_at INTEGER,                          -- 最近一次 attempt 触发时间；attempt_count++ 同步更新
  delivering_since INTEGER                          -- 进入 delivering 时间；crash recovery 用 (§4.6)
);

CREATE INDEX IF NOT EXISTS idx_messages_status_last_attempt
  ON agent_deck_messages(status, last_attempt_at);
CREATE INDEX IF NOT EXISTS idx_messages_team_id_sent_at
  ON agent_deck_messages(team_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_to_session_id
  ON agent_deck_messages(to_session_id);
-- per-target backpressure 反查「to_session_id 当前 in-flight count」用 (§7.5)：
CREATE INDEX IF NOT EXISTS idx_messages_to_session_pending
  ON agent_deck_messages(to_session_id, status) WHERE status IN ('pending','delivering');
```

```sql
-- v011_tasks_team_id.sql （task-manager 迁移，§5.4 详）

-- tasks 加 team_id 列；老 team_name 列保留兼容直到 v012 大版本删
ALTER TABLE tasks ADD COLUMN team_id TEXT REFERENCES agent_deck_teams(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_team_id
  ON tasks(team_id) WHERE team_id IS NOT NULL;

-- 注：
-- 1) 不做 backfill（老 task 的 team_id 全 NULL，需要时由 task-manager 重写阶段 lazy 关联）
-- 2) task-repo.list({teamId}) 优先走 team_id 列；旧 team_name 仅做 fallback
-- 3) 老 mcp__agent-deck__task_create 入参 team_name 临时映射：lookup agent_deck_teams.name → team_id（active 唯一）
```

### 2.3 老字段 deprecate 策略

- `sessions.team_name` (v006) **保留列**，**新代码不再 write**。`sessionRepo.upsert` 内 `team_name`
  字段保留 INSERT 列位（避免改 column 顺序触发 SQL 重写），但写值固定 `null` —— 不读用户传入。
  `distinctTeamNames` / `findByTeamName` / `clearTeamName` / `setTeamName` **全删**（IPC 不再
  暴露相关 channel）。
- v006 migration 文件 `v006_sessions_team_name.sql` **不删**，注释加一段说明「R3 起 deprecated，
  仅历史保留；新代码走 agent_deck_teams 三表」。
- `tasks.team_name` (v007) **保留列**，新代码读 `team_id`（v011 加）；read 路径 v010/v011 期间
  双写：task-repo.list({teamId}) 优先 team_id，缺失时 fallback `tasks.team_name = (SELECT name
  FROM agent_deck_teams WHERE id=?)` 兼容历史。
- 下次大版本（约 12 个月后或 v012 重构）做 `ALTER TABLE sessions DROP COLUMN team_name` +
  `ALTER TABLE tasks DROP COLUMN team_name`，本 ADR 不动。

### 2.4 TypeScript 类型（`src/shared/types/agent-deck-team.ts`）

```ts
export type AgentDeckTeamMemberRole = 'lead' | 'teammate';

export interface AgentDeckTeamMember {
  teamId: string;
  sessionId: string;
  role: AgentDeckTeamMemberRole;
  displayName: string | null;
  joinedAt: number;
  leftAt: number | null;
}

export interface AgentDeckTeam {
  id: string;
  name: string;
  createdAt: number;
  archivedAt: number | null;
  metadata: Record<string, unknown>;     // 读路径必须 type-guard，禁止裸 cast
  // 由 repo.getWithMembers 聚合返回；裸 team list 不带
  members?: AgentDeckTeamMember[];
}

export type AgentDeckMessageStatus =
  | 'pending'      // 入队后待 watcher 投递
  | 'delivering'   // watcher 已选中并在调 adapter（短暂态，crash recovery 看 §4.6）
  | 'delivered'    // adapter receiveTeammateMessage 成功
  | 'failed'       // 重试上限到达 / adapter 不支持 / session closed 等
  | 'cancelled';   // 显式 cancel（如 lead 撤回 / team 整体 archive）

export interface AgentDeckMessage {
  id: string;
  teamId: string;
  fromSessionId: string;
  toSessionId: string;
  body: string;
  status: AgentDeckMessageStatus;
  statusReason: string | null;
  sentAt: number;
  deliveredAt: number | null;
  attemptCount: number;
  lastAttemptAt: number | null;
  deliveringSince: number | null;
}

// adapter 收到的 teammate 元事件（§4.9 dispatcher 投）
export type AgentDeckTeammateEvent =
  | { kind: 'member-joined'; teamId: string; sessionId: string; displayName: string }
  | { kind: 'member-left'; teamId: string; sessionId: string; displayName: string }
  | { kind: 'team-archived'; teamId: string };
```

老 `src/shared/types/team.ts` 的所有导出（`TeamMember` / `TeamConfig` / `TeamSnapshot` /
`TeamSummary` / `TeamDataChangedEvent` / `TeamTaskPayload` / `TeamTeammateIdlePayload`）**全删**，
不保留兼容 alias。renderer / IPC 全部按新类型重写（E7/E8）。

老 `src/shared/types/permission.ts` 的 `TeamPermissionRequest` / `TeamPermissionCancelled`
（lines 109-129）**也删**——permission inbox 协议下线后不再有 producer，存留即死代码（reviewer
finding #15 已实证 50 处 renderer 消费点全部清掉）。

### 2.5 session 删除 / 历史保留与 team membership 协调

reviewer 双对抗 finding #2 + #4 合并：`sessions` 行 hard-delete 路径有两条：

1. **用户 UI 删除**：`HistoryPanel` / `SessionCard` 调 `IPC SessionDelete` → `sessionManager.delete`
2. **lifecycle-scheduler 自动清理**：`historyRetentionDays` 默认 30 天，超期 batchDelete

两条路径都被 `agent_deck_team_members.session_id ON DELETE RESTRICT` FK 拦下后必须显式处理：

- **`sessionManager.delete` 入口加 pre-check**：
  ```ts
  const memberships = teamRepo.findActiveMembershipsBySession(sid);
  if (memberships.length > 0) {
    // 1) 自动 leaveTeam（写 left_at = now）—— 不删 team 本体
    for (const m of memberships) {
      teamRepo.leaveTeam(m.teamId, sid);
      // 2) 触发 0-lead 检查：lead 离开后若该 team 无 active lead，自动 archive
      const remaining = teamRepo.countActiveLeads(m.teamId);
      if (remaining === 0) {
        teamRepo.archive(m.teamId, { reason: 'last-lead-deleted' });
        eventBus.emit('agent-deck-team-updated', teamRepo.get(m.teamId)!);
      }
    }
  }
  ```
- **lifecycle-scheduler 30 天清理走同套逻辑**：在 `batchDelete` 内复用 `sessionManager.delete`
  ——避免两条路径各写一份语义。
- **UI 入口体验**：删除 confirm dialog 增加「该会话在 N 个 team 内，删除会自动从所有 team 退出」
  提示文案；用户继续删则走 leaveTeam。

---

## 3. AgentAdapter 接口扩展

### 3.1 新增 capability + 方法

```ts
// src/main/adapters/types.ts 增补
export interface AdapterCapabilities {
  // ... 现有字段保留 ...

  /**
   * 是否支持作为 team member 接收 cross-adapter 消息。
   * - claude-code / codex-cli: true
   *
   * UI 据此与 archived/closed 双条件决定 NewTeamMember dialog 是否暴露该 adapter。
   * 取代老 capability `canJoinTeam`（仅指 Claude Code experimental teams flag）。
   *
   * **注意 PR 拆分时序**（reviewer finding #5 修订）：
   * - PR-A（E4）：仅**新增** canCollaborate 字段，与 canJoinTeam 共存一个周期，
   *   保证 NewSessionDialog / sdk-bridge env 注入旧路径不破坏
   * - PR-B（E6）：删除 canJoinTeam + 同步删 NewSessionDialog 旧消费点 + 删 sdk-bridge env 注入
   */
  canCollaborate: boolean;
}

export interface AgentAdapter {
  // ... 现有字段保留 ...

  /**
   * 把另一个 team member（来自任意 adapter）发来的消息塞进本 session 的 user turn。
   *
   * 实现约束：
   * - 必须是**至少一次** delivery（重试 ≥ 1 次后才认为 failed）。watcher 先 update
   *   status='delivering' 再调；adapter 抛错 → watcher catch + 退避（详 §4.5）。
   * - **不要**自己拼 fromMember 元信息前缀。watcher 已在 body 里拼好（统一格式见 §4.4）。
   *   adapter 直接 sendMessage(sessionId, body)。fromMemberId 仅用于 logging / 路由调试。
   * - 必须是异步：返回 Promise；resolve 表示「已成功提交给 adapter 的 message queue」（不是
   *   「session 已生成 reply」）。watcher 不等 reply。
   */
  receiveTeammateMessage?(
    sessionId: string,
    fromMemberId: string,
    body: string,
  ): Promise<void>;

  /**
   * 通知本 session 同 team 有 teammate 元事件（§4.9 dispatcher 投）。
   * 设计为 **optional + best-effort**：adapter 可不实现（默认丢弃事件）。
   * 实现的 adapter 把事件以 system message / banner 形式插入 session（如「[team] codex-helper joined」）。
   * dispatcher 不等返回，也不重试。
   */
  notifyTeammateEvent?(
    sessionId: string,
    event: AgentDeckTeammateEvent,
  ): Promise<void>;
}
```

### 3.2 各 adapter 落地（E4）

| Adapter | canCollaborate (E4) | receiveTeammateMessage 实现 (E4) | notifyTeammateEvent | canJoinTeam 删除时机 |
|---|---|---|---|---|
| claude-code | true | 调 `sdkBridge.sendMessage(sessionId, body)`（与 IPC 路径同款） | optional 实现：sendMessage 一条 system-style 文本 | E6 删 |
| codex-cli | true | 调 `codexSdkBridge.sendMessage(sessionId, body)`（注意配套 §7.5 backpressure，避免触发 codex MAX_PENDING_MESSAGES=20 限制） | 同上 | E6 删 |

**老 capability `canJoinTeam` E6 同步删除**（reviewer 修订）：定义里它只表征「是否能让 Claude
Code CLI 启用 experimental teams flag」，与 universal team 无关。settings.agentTeamsEnabled
一并 REMOVED_KEYS（§6.3）。删除时机统一推到 PR-B / E6，避免 PR-A 中间窗口破坏 NewSessionDialog
旧消费点。

---

## 4. universal-message-watcher 设计（E5）

### 4.1 总体架构

```
[Caller] —┐
          ├→ INSERT agent_deck_messages (status='pending', sent_at=now, last_attempt_at=null)
          │       │
          │       └→ eventBus.emit('agent-deck-message-enqueued', { id, teamId })
          │
[universal-message-watcher (singleton)]
   on('agent-deck-message-enqueued') → schedule poll (debounced 50ms)
   on tick (default 250ms 兜底):
     SELECT * FROM agent_deck_messages
       WHERE status='pending'
         AND (last_attempt_at IS NULL OR last_attempt_at < now - backoff(attempt_count))
       ORDER BY sent_at ASC
       LIMIT 16
     for each row:
       per-target backpressure check (§7.5):
         pending_for_target = SELECT count(*) FROM messages
           WHERE to_session_id=? AND status IN ('pending','delivering')
         if pending_for_target > MAX_TARGET_INFLIGHT (default 10): skip this round
       try claim atomically:
         UPDATE agent_deck_messages
           SET status='delivering', delivering_since=now, last_attempt_at=now
           WHERE id=? AND status='pending'
           RETURNING *
       resolve adapter from sessionRepo.get(to_session_id) → adapterRegistry.get(agentId)
       if adapter not found / closed:
         status='failed', reason='adapter-closed-or-missing'
       elif !adapter.capabilities.canCollaborate || !adapter.receiveTeammateMessage:
         status='failed', reason='adapter-no-collaborate'
       else:
         await adapter.receiveTeammateMessage(toSid, fromMemberId, body)
         status='delivered', delivered_at=now
       on throw:
         attempt_count++; last_attempt_at=now
         if attempt_count >= MAX_RETRY: status='failed', reason='retry-exhausted: <error>'
         else: status='pending'  -- 退避后下次 poll 再选
```

### 4.2 触发模式（hybrid event + poll）

- **event 触发**（fast path）：`messageRepo.insert()` 内 emit `eventBus.emit('agent-deck-message-enqueued', ...)`，
  watcher 监听后立刻 `process()` 一轮（debounce 50ms 防 burst）。
- **poll 触发**（兜底）：每 250ms 全量扫一次 status='pending' 行（防 event 漏 emit / 进程
  crash recovery / `attempt_count > 0` 退避后再投）。
- 两路 idempotent —— `claim` 用 `UPDATE ... WHERE status='pending' RETURNING` 原子化竞争，重复
  触发只成交一次。

### 4.3 状态机

```
                  ┌──────────────────────────────────────────────┐
                  │                                              │
                  ▼                  (claim 失败 / row 已被处理)  │
[insert] → pending ──claim──→ delivering ──success──→ delivered  │
                  │                  │                            │
                  │                  └──throw──→ pending          │
                  │                              (attempt_count++)─┘
                  │                              if attempt_count >= MAX_RETRY → failed
                  │
                  ├──cancel API──→ cancelled
                  │
                  └──watcher detects to-session closed→ failed (reason='session-closed')
```

- **MAX_RETRY = 3**；具体语义：`attempt_count` 是「已用 attempt 次数」，初值 0；进入
  `delivering` 时不变；从 `delivering → pending` (throw) 时 ++。所以 `attempt_count` 取值
  `{0,1,2,3}`：
  - 0: 初次尝试
  - 1, 2: 退避中
  - 3: 已超限 → 直接 `failed`，不再选
  这是 reviewer codex MED-2 反馈的 off-by-one 修订。
- **退避表**：基于 `last_attempt_at`（reviewer HIGH-1 修法）：
  - attempt_count = 1 → 1s
  - attempt_count = 2 → 4s
  - attempt_count = 3 → never picked（直接 failed）
- `delivering` 是短暂态：watcher 内部 critical section 持续时间 = 一次 `await
  adapter.receiveTeammateMessage(...)`，正常 < 1s。crash recovery 见 §4.6。
- `cancelled`：仅来自显式 IPC cancelMessage（E8 暴露 channel，UI 撤回按钮用）；watcher 不会
  自己改成 cancelled。
- 终态（delivered / failed / cancelled）不可再变。failed 后用户可在 UI 重新发同样内容（=
  insert 一条新 row），不支持「重试已 failed 的旧 row」（避免幻觉 / debugging 复杂）。

### 4.4 fromMemberId / displayName 拼装（**统一格式**）

watcher 在调 adapter 前要把 sender 信息拼进 body（adapter 端无法自己反查）。**统一约定 wire 格式**（reviewer finding #6 修订，§3.1 与 §4.4 一致）：

```
[from <displayName> @ <adapterId>]
<原始 body>
```

`displayName` 来源优先级：
1. 当 caller 与 target 共享多个 team 时，`team_id` 必填 → 取该 team 的 `display_name`
2. 共享单个 team 时取该 team 的 `display_name`
3. fallback `<adapterId>:<sessionId 前 8 字符>`（如 `claude-code:abcd1234`）
4. 二级 fallback（adapter 已删）：`unknown-adapter:<sessionId 前 8 字符>`（防 `null:abcd1234`）

这是**单一前缀**，adapter 不再二次封装。如果 sender == receiver（自循环 message，理论不应发生），
caller-side messageRepo.insert 直接 throw + watcher 兜底拒（reason='self-message-not-allowed'）。

### 4.5 重试 & 幂等（reviewer 修订）

- 单次 `claim → adapter call → status update` 中任何 throw 都 catch + 写
  `attempt_count++` + `last_attempt_at=now`。
- 重试间不擦 body / fromMemberId / sentAt（只动 status / attempt_count / last_attempt_at /
  status_reason）；adapter 端**理论上**收两份相同 body 是用户可观测的副作用（teammate session
  看到两条相同 user message），属可接受 trade-off：宁可重复也不丢。
- adapter 端可选实现「同 body 短期 dedup」但**不强制**——universal-message-watcher 自己不做
  body 哈希 dedup（避免 attempt_count++ 后状态不一致 / 短期 dedup 窗口外的合理重发被吞）。

### 4.6 进程 crash recovery（reviewer 修订）

进程启动时（`watcher.start()` 内）执行（**不再无条件 attempt_count++**，避免 crash 把本来
还有重试余量的 row 直接拍 failed —— reviewer claude MED-12）：

```sql
-- 把上次进程崩溃时卡在 delivering 的行重置为 pending，但 attempt_count 不变。
-- 第一次重投触发 status='pending' → claim 走正常退避：因为 last_attempt_at 仍是上次进入
-- delivering 的时间，按 backoff(attempt_count) 算 next_eligible_at，避免过快重投同一行。
UPDATE agent_deck_messages
   SET status='pending',
       status_reason = 'recovered-from-delivering (process restart)',
       delivering_since = NULL
 WHERE status='delivering';
```

**rationale**：上次 crash 时 adapter 可能已经成功 `receiveTeammateMessage`（已 sendMessage
入 SDK queue 但 watcher 没来得及写 `delivered`）→ 重启后 watcher 重发 → 接收方第二份相同
user message。这是 §4.5 已声明的「可接受重复」边界条件之一。

如果某 attempt_count 已 = 3 时 crash → 重启后该行已 `failed`（不在 delivering），不受本节
影响。

### 4.7 与现有 spawn_chain (v009) 的关系

R2 引入的 `sessions.spawned_by` / `spawn_depth` 是 **MCP spawn-time 防递归**字段，与本 ADR
正交。不所有 team member 关系都来自 spawn（用户可显式建空 team 后陆续加 member），也不所有
spawn 关系都形成 team。watcher **不**用 spawn_chain 字段做 team 路由。

### 4.8 与 wait-reply-coordinator 的关系（reviewer finding #7 修订）

`waitReplyCoordinator` (R2) 监听 `eventBus.on('agent-event')` 等任意 session 的 emit；E5
universal-message-watcher 投递成功后，receiver session 正常 emit AgentEvent，coordinator
解锁 lead 的 `wait_reply`。

**已知漏洞**（R2 carry-over，reviewer codex HIGH-2）：coordinator 仅监听 `session-removed`，
不监听 `session-upserted.lifecycle === 'closed'`。`sessionManager.close` / `markClosed` /
`setLifecycle(closed)` 都只 emit `session-upserted`（实证 src/main/session/manager.ts:357 /
366 / 396 / 403 / 411 / 419 / 436 / 449 / 504），**不**触发 `session-removed`。结果是：
- `until=idle`（default）：coordinator idleTimer 5s 内 fire → 影响小
- `until=turn_complete` / `first_message`：close 流程不必然 emit `finished` /
  `waiting-for-user` / `message`，lead 卡到 timeout（默认 60s，最大 600s）

**修法**（E5 同 PR 落地，与 watcher 一起）：在 `WaitReplyCoordinator.waitFor` 内增加监听：
```ts
const onSessionUpserted = (rec: SessionRecord) => {
  if (rec.id !== sessionId) return;
  if (rec.lifecycle === 'closed') finish('session-closed');
};
const unsubscribeUpsert = eventBus.on('session-upserted', onSessionUpserted);
// finish 时同步 unsubscribeUpsert()
```

同时给 `wait-reply-coordinator.test.ts` 加「shutdown_session → wait_reply 立即 resolve」case
防退化。

### 4.9 notifyTeammateEvent dispatcher（reviewer finding #7 / claude MED-7）

universal-message-watcher 单例同模块内提供 `TeamEventDispatcher`：
- 监听 `eventBus.on('agent-deck-team-member-changed', ...)` + `agent-deck-team-updated` (with archived_at delta)
- 拉本 team 所有 active members（去重 sender 自己）
- 对每个 active member 反查 `sessionRepo.get(sid).agentId → adapterRegistry.get(adapterId)`
- `if (adapter.notifyTeammateEvent) Promise.allSettled(...)`，不等返回也不重试

`notifyTeammateEvent` 标 optional —— 没实现的 adapter 自然丢弃事件。这只是观察性事件，不是
关键路径。

---

## 5. agent-deck-mcp 与 team 抽象的边界

### 5.1 `spawn_session` amend（最小破坏）

R2 ADR 已锁定 `spawn_session({ adapter, cwd, prompt, team_name?: string, ... })` schema
（详 R2 §3.1）。R3 重写**实现语义**（不改 wire schema，向后兼容）：

```
当 team_name 非空时：
  1. 在 agent_deck_teams 表内 ensure-team-by-name（active 唯一，并发安全见下）
  2. 把 caller_session_id 加入该 team 作为 'lead' role（如未在；若已是 teammate 不改 role）
  3. spawn 出来的新 session 加入该 team 作为 'teammate' role
  4. 不再写 sessions.team_name 列（v006 deprecated）

当 team_name 缺省时：
  孤立 spawn，不建 team，sessions.team_name 也不写
```

**ensure-team-by-name 并发安全**（reviewer claude HIGH-4 → MED 修订）：

依赖 §2.2 的 `idx_agent_deck_teams_active_name` 部分 unique 索引 + repo 层用 `INSERT ...
ON CONFLICT(name) WHERE archived_at IS NULL DO NOTHING; SELECT id ...` 短同步 statement，
避免 BEGIN IMMEDIATE 长事务与 watcher 抢 WAL 写锁。better-sqlite3 + partial index 在 sqlite3
3.43+ 实测兼容（reviewer codex 反驳轮验证）。

### 5.2 `send_message` amend（**reviewer codex HIGH-1 必修**）

R2 ADR §3.2 当前 schema：`{ session_id, text, caller_session_id }`。R3 在「caller 与 target
共享多个 team」场景下需要 team selector（messages.team_id NOT NULL，displayName / ACL /
rate limit bucket 都按 team_id 分桶）。

**amend 后 schema**（向后兼容：`team_id` optional，单 team 共享时可省）：

```ts
send_message: z.object({
  session_id: z.string().min(1).max(128),
  text: z.string().min(1).max(100_000),
  caller_session_id: z.string().min(1).max(128),
  team_id: z.string().min(1).max(128).optional()
    .describe('Team scope for this message. Required when caller and target share more than one active team; optional when sharing exactly one (auto-resolved). Reject when sharing zero teams.'),
})
```

**handler 行为**：
1. 用 `team_members` 反查 caller 与 target 共享的 active teams（`left_at IS NULL`）
2. count = 0 → reject `{ error: 'no-shared-team' }`
3. count = 1 → 用该 team_id（args.team_id 缺省时填）
4. count ≥ 2 → 必填 args.team_id；缺省 reject `{ error: 'ambiguous-team', shared: [...] }`；
   非缺省时校验在 shared 集合内
5. messageRepo.insert({ teamId, fromSessionId, toSessionId, body, ... }) → emit
   `agent-deck-message-enqueued` → watcher 接

**IPC 同步加 `team_id` 字段**：`agent-deck-team:send-message` (E8) 同款 zod schema。

### 5.3 「不引入新 MCP tool」决策（**R2 ADR §12 路线图作废**）

R2 ADR §12「未来可能加 create_team / delete_team / list_teams MCP tools」**作废**。
R3 阶段 team 创建 / 归档 / 加退 member 通过：
1. `spawn_session({team_name})` 隐式建 team + 加 member
2. IPC channel（E8）显式建 / 归档 / 加退（UI / CLI 用）

MCP client 想显式控制 team → 通过 spawn 多次同 team_name 即可。**注意** spawn_session 必填
prompt（R2 ADR §3.1），意味着「先建空 team 后陆续加 member」对 MCP / Claude 会话内不可达
（reviewer claude MED-14）；对 UI / CLI 入口可达（IPC `agent-deck-team:create` 不带 prompt）。
这是 spec 上的有意限制，避免 MCP surface 膨胀。

未来如有强需求（用户反馈 ≥ 3 次）再升级 ADR 加 `agent_deck_team_create` 等。

### 5.4 task-manager 迁移路径（**reviewer codex HIGH-3 必修**）

老路径：`sdk-bridge` 注册 `teamNameProvider = () => sessionRepo.get(sid)?.teamName ?? null`
→ task-manager `task_create` 强制塞 closure team_name → tasks.team_name 列做分桶。

R3 不写 sessions.team_name 后该路径**功能性可用但语义全错**（task 全进 global scope）。
迁移方案（**v011 同 PR 落地**，与 v010 同步）：

1. **v011 加 `tasks.team_id` 列**（§2.2 已列 SQL）
2. **改 sdk-bridge teamNameProvider → teamIdProvider**：
   ```ts
   () => {
     const sid = internal.realSessionId ?? tempKey;
     // 反查 caller 当前所属 team；多 team 时取最近 join 的（lead role 优先）
     const memberships = teamRepo.findActiveMembershipsBySession(sid)
       .sort((a, b) => b.joinedAt - a.joinedAt);
     const lead = memberships.find(m => m.role === 'lead');
     return (lead ?? memberships[0])?.teamId ?? null;
   }
   ```
3. **task-manager/tools.ts 重写 closure injection**：把 `teamName` 改成 `teamId`，写入
   `tasks.team_id` 列；旧 `team_name` 列不写（保留 NULL 兼容）
4. **task-repo.ts 新增 `list({ teamId })` 优先**；老 `list({ teamName })` 重写为
   `team_name → resolve to team_id → list({ teamId })` 兼容 helper（可选保留 1 个版本）
5. **mcp__tasks__task_create / task_list / task_update / task_delete schema 加 `team_id`**
   字段（与 closure 同款 enforcement：write tools 强制 closure，read tools 允许 args 覆盖）

**任务迁移时序**：v011 + task-manager 重写在 PR-A 内同 v010 一起落地（task-manager 自身依赖
v010 的 agent_deck_team_members 反查），PR-B 阶段不再动 task-manager。

### 5.5 替换老 builtin tool 的语义映射（用户教育）

| 老 Claude builtin | 替代 MCP 调用 | 备注 |
|---|---|---|
| `TeamCreate({team_name, ...})` | `spawn_session({adapter, cwd, prompt, team_name})`（首次 spawn 自动建 team）<br>或 IPC `agent-deck-team:create` 经 UI / CLI（E10） | 不再有「先建 team 再加 member」MCP 路径；UI / CLI 可建空 team |
| `Agent(team_name=..., subagent_type=...)` 起 teammate | `spawn_session({adapter:..., cwd:..., prompt:..., team_name:..., parent_session_id: caller})` | 多 adapter 自由选；prompt 必须自带（不再有 subagent_type 隐式 prompt） |
| `SendMessage({to:'reviewer-codex', message:...})` | `send_message({session_id: codex-session-id, team_id?: ..., text:...})`<br>+ `wait_reply({session_id: codex-session-id, until:'turn_complete', since_ts: spawn_response.sentAt - 5000})` | 必须显式拿 session_id（不能用 name 路由）；多 team 共享时必填 team_id；E11 SKILL 给 since_ts 防 race 推荐 |
| `TeamDelete()` | `mcp__agent-deck__shutdown_session` 各 member<br>+ IPC `agent-deck-team:archive`（不删历史，标 archived） | 不再 cascade 删 fs；纯 DB 操作 |

---

## 6. 删除清单（E6）

> plan v3 §145-156 列出，本 ADR 锁定具体行为。
> reviewer 双对抗 finding #3 / claude HIGH-3 + codex HIGH-5 修订：原表 1340 LOC 漏列多处死代码 / 调用点，本节完整列表如下。

### 6.1 全删文件（合计 ~1671 LOC + tests）

| 文件 | LOC | 关联 CHANGELOG / REVIEW | 删除影响 |
|---|---|---|---|
| `src/main/teams/inbox-watcher.ts` | 452 | CHANGELOG_45/47/56 + REVIEW_17 | inbox 文件协议监听完全停止；CLI 内自起 team 的 permission_request 不再弹 PendingTab |
| `src/main/teams/team-coordinator.ts` | 313 | CHANGELOG_45/46 | unsetTeamFromAllSessions / 30s dedup 等收口逻辑废弃 |
| `src/main/teams/inbox-protocol.ts` | 306 | CHANGELOG_45 | inbox 文件 wire 解析 / append 逻辑废弃 |
| `src/main/teams/auto-approve.ts` | 117 | CHANGELOG_56 + REVIEW_17 | autoApproveTeammateMode 三档功能完全下线 |
| `src/main/teams/team-watcher.ts` | 152 | CHANGELOG_45 | chokidar 引用计数 / fs 监听全停 |
| `src/main/teams/__tests__/team-coordinator.test.ts` | 239 | — | 同步删 |
| `src/main/teams/__tests__/inbox-protocol.test.ts` | 331 | — | 同步删（reviewer claude MED-11 补） |
| **小计** | **1910** | | |

### 6.2 部分删除文件（行号 reviewer claude HIGH-3 + codex HIGH-5 实证补全）

| 文件 | 删除部分 | 保留部分 | 理由 |
|---|---|---|---|
| `src/main/teams/team-fs.ts` (334 LOC) | 296 LOC：`listTeams` / `readTeamConfig` / `readTaskList` / `getTeamSnapshot` / `forceCleanupTeam` / `getTasksRoot` | ~38 LOC：保留 `getTeamsRoot` + 新增 `exportLegacyTeamConfig(teamName)` 给 E12 「Export legacy team config」按钮用 | 纯只读历史导出，不入 hot path |
| `src/main/adapters/claude-code/hook-routes.ts` | line 9-11（`translateTaskCreated/Completed/TeammateIdle` import）<br>line 14（`extractTeamNameFromToolInput, teamCoordinator` import）<br>line 32-44（`maybeSyncFromPreToolUse` + `maybeSyncFromTeamHook` helpers）<br>line 95（PreToolUse handler 内 `maybeSyncFromPreToolUse(b)` 调用）<br>line 107-130（三个 team hook makeRoute 块） | 其他 hook route（permission / pre-tool-use / 等）保留；PreToolUse handler 重写去掉 sync helper 调用 | hook 不再触发 team-* 事件；DB events 表不再写 hook origin team_name |
| `src/main/adapters/claude-code/translate.ts` | line 1（`TeamPermissionRequest/Cancelled` import）<br>line 42-60（`TeamHookPayload` interface + helpers）<br>line 82-160（3 个 translate fn：TaskCreated/Completed/TeammateIdle）<br>line 163-200（`translateTeamPermissionRequest/Cancelled` 两 fn） | 其他 translate fn（hook event normalize 主路径）保留 | dead code |
| `src/main/index.ts` | line 27（`teamWatcher / inboxWatcher / teamCoordinator` import）<br>line 30（`translateTeamPermission*` import）<br>line 240-245（`team-data-changed` listener 注册）<br>line 265-302（`team-permission-requested/cancelled` listener 注册段）<br>line 304-339（`autoSubscribedTeams` + `refreshAutoSubscribe` + 3 个 listener）<br>line 403-407（before-quit cleanup 段） | 其他 bootstrap / listener 保留 | 老 backend wiring 整体下线 |
| `src/main/adapters/claude-code/sdk-bridge/index.ts` | line 164-165 注释段（CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS 注释）<br>line 285-300（teamNameProvider 闭包旧实现）<br>line 388-403（CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS env 注入段，5 处 grep 命中） | 主体 sdk-bridge 保留 | env 注入逻辑 + 老 teamName 反查整体重写为 §5.4 teamIdProvider |
| `src/main/ipc/_helpers.ts` | `parseTeamName` helper（如纯属 team IPC 用） | 其他 helpers | 视实际使用情况决定 |
| `src/shared/types/team.ts` (123 LOC) | 全部老接口 | — | 类型 break；renderer 同 PR 重写 |
| `src/shared/types/permission.ts:109-129` | `TeamPermissionRequest` / `TeamPermissionCancelled` 接口 | 其他 permission 类型保留 | 50 处 renderer 消费点同步删（详 §6.6） |
| `src/main/store/migrations/v006_sessions_team_name.sql` | **不删** | 加注释「R3 起 deprecated，仅历史保留；新代码走 agent_deck_teams 三表」 | 不破坏 migration 链 |

### 6.3 Settings 字段 REMOVED_KEYS（reviewer 已确认 settings-store.ts 既有机制可用）

`src/shared/types/settings.ts` 删字段 + `src/main/store/settings-store.ts` REMOVED_KEYS 加：

```ts
// settings-store.ts REMOVED_KEYS 数组追加：
const REMOVED_KEYS: string[] = [
  // ... 既有 'anthropicApiKey' 等 ...
  'agentTeamsEnabled',          // R3 E6
  'autoApproveTeammateMode',    // R3 E6
];
```

字段相关分发（IPC `SettingsSet` handler 内）一并删；env 注入逻辑（sdk-bridge
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`）一并删（§6.2 行号已列）。

新增 settings 字段（§7.5 / §7.6 详）：
- `mcpMessageRatePerTeamPerMin: number`（默认 60，范围 [10, 600]）
- `mcpMessageMaxTargetInflight: number`（默认 10，范围 [1, 50]）

### 6.4 IPC channel 删除（E8）

| 老 channel | 替换 | 备注 |
|---|---|---|
| `team:list` (TeamList) | `agent-deck-team:list` | 返回新 AgentDeckTeam[] |
| `team:get` (TeamGet) | `agent-deck-team:get` | 返回 AgentDeckTeam + members + recent messages |
| `team:subscribe` (TeamSubscribe) | **删**（无 fs 监听必要） | renderer 改用 IpcEvent 推 |
| `team:unsubscribe` (TeamUnsubscribe) | **删** | 同上 |
| `team:force-cleanup` (TeamForceCleanup) | `agent-deck-team:archive` | 新语义：标 archived_at（不 rm fs） |
| `team:subscribe-inbox` (TeamSubscribeInbox) | **删** | inbox 协议下线 |
| `team:unsubscribe-inbox` (TeamUnsubscribeInbox) | **删** | 同上 |
| `team:respond-permission` (TeamRespondPermission) | **删** | CLI 内自起 team 的 permission **不再可视化**（硬切代价，§10） |
| `team:list-pending-permissions` (TeamListPendingPermissions) | **删** | 同上 |
| `task:list-by-team` (TaskListByTeam) | **重写**：入参从 teamName 改 teamId（§5.4 task-manager 迁移配套） | 老 teamName 入口提供 1 个版本兼容 helper（lookup name → id），下版本删 |

新增 IPC channel：
- `agent-deck-team:create({ name, metadata? })` → 返回 AgentDeckTeam
- `agent-deck-team:archive(teamId)`
- `agent-deck-team:add-member({ teamId, sessionId, role, displayName? })`
- `agent-deck-team:remove-member({ teamId, sessionId })`
- `agent-deck-team:send-message({ teamId, fromSessionId, toSessionId, body })`
- `agent-deck-message:cancel(messageId)`
- `agent-deck-message:list-by-team({ teamId, limit?, offset? })`

### 6.5 event-bus 事件清理（E9）

| 老 event | 处理 | 备注 |
|---|---|---|
| `team-data-changed` | 删 | fs 不再 watch |
| `team-permission-requested` | 删 | inbox 协议下线 |
| `team-permission-cancelled` | 删 | 同上 |
| `team-permission-resolved` | 删 | 同上 |

新增 event：

| 新 event | payload | 触发点 |
|---|---|---|
| `agent-deck-team-created` | `AgentDeckTeam` | repo.create 成功后 |
| `agent-deck-team-updated` | `AgentDeckTeam`（含 archived_at 变化 / metadata 变化） | repo.update / archive 成功后 |
| `agent-deck-team-deleted` | `{ id }` | repo.hardDelete（仅 admin / 测试用） |
| `agent-deck-team-member-changed` | `{ teamId, sessionId, kind: 'joined' \| 'left' \| 'role-changed' }` | members 表 insert/update/delete 后 |
| `agent-deck-message-enqueued` | `{ id, teamId, fromSessionId, toSessionId }` | messageRepo.insert 后 |
| `agent-deck-message-status-changed` | `{ id, teamId, status, statusReason? }` | watcher 每次 update status 后 |

main bootstrap 桥接到 IPC：`IpcEvent.AgentDeckTeamChanged` / `IpcEvent.AgentDeckMessageChanged`
两个 event channel；**桥接层 16ms debounce + per-team 累加合并**，避免 burst 投递时 renderer
高频重渲染（reviewer claude LOW 收口）。

### 6.6 renderer 删除清单（reviewer claude MED-10 补全，50 处 grep 实证）

| 文件 | 删除 | 备注 |
|---|---|---|
| `src/renderer/components/TeamHub.tsx` (152) | 整文件 | E7 重写 |
| `src/renderer/components/TeamDetail/index.tsx` (297) + `TeamDetail/sub*.tsx` (444) | 整目录 | E7 重写 |
| `src/renderer/components/NewSessionDialog.tsx` (342) | 整文件或重写 | E7 重写：`teamName` / `canJoinTeam` 旧路径全删 |
| `src/renderer/components/PendingTab.tsx` + `pending-rows/*` | 删 team-permission-row + 相关分支 | own session permission 仍保留 |
| `src/renderer/stores/event-type-guards.ts:5-6, 30-43` | `isTeamPermissionRequest / isTeamPermissionCancelled` 类型守卫 | 用 grep `isTeamPermission` 验证 0 处后删 |
| `src/renderer/stores/session-store.ts:9, 18-19, 39, 92, 252, 304+` | `pendingTeamPermissionsBySession` Map state + `EMPTY_TEAM_PERMISSIONS` 常量 + 多处 ingestion 分支 | 同步加 unit test 保护 reducer 不退化 |
| `src/renderer/components/activity-feed/index.tsx:7, 319` | `payload as TeamPermissionRequest` cast 走 team 专用 row | 改走 own-permission 单一路径 |
| `src/renderer/lib/session-selectors.ts:6, 52, 61` | `teamPermissions: TeamPermissionRequest[]` 字段 + selector 函数签名 | 同步 selector 单测 |
| `src/preload/index.ts:353-358` | `TeamSubscribeInbox / TeamUnsubscribeInbox` facade | facade 表整体收口 |
| `src/shared/ipc-channels.ts:77-96, 129, 132-138` | 老 team: / TeamPermission* channel 名 | 改用新 agent-deck-team:* |

### 6.7 typecheck 验证

PR-B 合入前必跑 `pnpm typecheck` 验证以上删除完成后无悬挂 import：
- 任何遗漏的 `import ... from '@main/teams/inbox-watcher'` 等 → typecheck 立刻挂
- 任何遗漏的 `eventBus.on('team-permission-requested', ...)` → typecheck 通过但运行时 emit 不到，加 `pnpm vitest run` 跑 reducer 单测兜底

---

## 7. 鉴权 / ACL / 限流

### 7.1 caller_session_id 校验（沿用 R2）

R2 ADR §5 + §6 的鉴权 / 防递归 4 条规则**完全继承**。E5 universal-message-watcher 在 `claim`
前不重新校验 caller —— message 已在 enqueue 时（caller 调 `mcp__agent-deck__send_message` 或
IPC 直发）通过 R2 caller validation。

### 7.2 team 内 ACL

- **任意 lead** 可以 send_message 给同 team 任意 teammate / 其他 lead。
- **teammate** 可以 send_message 给本 team 内**任意 member**（不限于 lead），但每条消息要求
  `from_session_id` 与 `to_session_id` 同 team（messageRepo.insert 校验，不同 team 直接 throw）。
- 不在 team 的 session 不能给该 team 任何 member 发消息（IPC + MCP 都校验）。
- archived team：不能新发消息（messageRepo.insert 拒），但已 enqueued 的 pending 行**继续**
  投递完成（避免 race）。

### 7.3 防自循环

`from_session_id == to_session_id` → messageRepo.insert 直接 throw（caller-side validation）
+ watcher 兜底拒（reason='self-message-not-allowed'）。

### 7.4 防递归 fan-out（与 R2 spawn_chain 协同）

- R2 防递归是「spawn 时」检查（spawn_depth ≤ 3 / per-parent fan-out ≤ 5）。
- E5 message 投递不再叠加深度限制（message 不创建新 session，不形成新 spawn）。

### 7.5 per-team rate limit + per-target backpressure（reviewer codex MED-3 + claude MED-7 修订）

**per-team rate limit**：默认 60 messages/min 每 team。
- **实施位置**：`messageRepo.insert` 入口（覆盖 IPC + MCP 两路；MCP handler 不再二次校验）
- **实现**：新建 `src/main/agent-deck-mcp/per-key-rate-limiter.ts`（与 R2 单例 spawnRateLimiter
  同 patterns，但 key=teamId、桶 per-team）
- **settings 字段**：`mcpMessageRatePerTeamPerMin: number`（默认 60，范围 [10, 600]）
- 触发限流：rejection error `{ code: 'team-rate-limit-exceeded', retryAfterMs: ... }`，caller
  decide 重试

**per-target backpressure**：避免 burst 投递把 codex MAX_PENDING_MESSAGES=20 队列灌爆。
- watcher 每轮 claim 前查 `to_session_id` 当前 in-flight count（`status IN ('pending','delivering')`）
- 超过 `mcpMessageMaxTargetInflight`（默认 10）则跳过本 row 本轮（下一 poll 重试）
- caller-side 不阻塞 enqueue（避免 lead 卡死）；UI 显示队列堆积警告
- **settings 字段**：`mcpMessageMaxTargetInflight: number`（默认 10，范围 [1, 50]）

### 7.6 prompt-injection 横向攻击声明（reviewer codex *未验证* 收口）

teammate 通过 user prompt 操纵 LLM 调 `mcp__agent-deck__send_message` 给同 team 其他 member
（非 lead 也行）—— 这是 *未验证* 但合理风险。R3 ADR 默认信任 team 内 ACL（任意 member 可
send 给同 team 任意 member），不针对此攻击面做 ACL 收紧；防御依赖：
1. per-team rate limit (§7.5) 限制刷屏量级
2. user 在 PendingTab / ActivityFeed 可观测所有 message 流转，发现异常人工 archive team
3. 用户侧不应在 untrusted prompt 注入场景下使用 team 协作（与 prompt-injection 防御通用建议一致）

如未来发现实际攻击 → 升级为 ACL 加 sender role 限制（teammate 只能 send 给 lead）。

---

## 8. R3 阶段任务依赖图（v3 §157 表的细化）

```
E0 (本 ADR)
 ├─→ E1 (types) ─┐
 │               ├─→ E2 (migration v010 + v011) ─→ E3 (repo) ─┐
 │                                                              ├─→ E5 (watcher + coord 修) ─┐
 │                  E4 (adapter ext, 仅新增 canCollaborate) ───┘                              ├─→ E6 (老 backend 删) ─→ E7 (UI 重写) ─┐
 │                                                                                            │                                          │
 │                                                                                            ├─→ E8 (IPC 重写, 含 task-manager 迁移) ──┤
 │                                                                                            │                                          │
 │                                                                                            ├─→ E9 (event-bus) ────────────────────────┤
 │                                                                                            │                                          │
 │                                                                                            └─→ E10 (CLI 跨 adapter) ──────────────────┤
 │                                                                                                                                       │
 └─→ E11 (deep-code-review SKILL 重写) ─────────────────────────────────────────────────────────────────────────────────────────────────┤
                                                                                                                                         │
     E12 (Settings export 按钮) ─────────────────────────────────────────────────────────────────────────────────────────────────────────┤
                                                                                                                                         ▼
                                                                                                                              E13 (文档 / CHANGELOG / README)
```

**plan v3 §259 风险节强约束**（reviewer 反驳轮 finding #5 修订后**进一步收紧**）：

E5 / E6 / E7 / E8 / E9 / E10 / E11 / E13 必须**同 PR 落地**（PR-B），不能拆分。理由：
- E5 上线但 E6 不删 → 老 inbox-watcher 仍跑，DB watcher 也跑，PendingTab 双 section
- E6 删了但 E5 没起来 → 老 backend 没了，新 backend 还没投递通道，跨 adapter 通讯**完全断**
- E11 不重写 → SKILL 文档里仍要求用户调 `TeamCreate / SendMessage`，被 E6 删完后 SKILL 完全不工作
- E4 删 canJoinTeam 但 E7 UI 没重写 → 中间窗口 NewSessionDialog 旧消费点失效

PR-A / PR-B 拆分（reviewer 修订后）：

- **PR-A**（先行准备，**不**触发硬切）：
  - E0 (本 ADR) + E1 (types 仅**新增** AgentDeckTeam，**保留**老 team.ts) + E2 (migration v010 + v011)
  - E3 (repo 层) + E12 (Settings export 按钮 + 一次性 dialog)
  - E4 仅**新增** canCollaborate / receiveTeammateMessage / notifyTeammateEvent，**不删** canJoinTeam
  - PR-A 落地后：老 backend 仍跑，新表已就位但无投递通道激活
  - 上线发版：包含 export dialog + 用户教育「即将硬切，请备份老 team」
- **PR-B**（同 PR 硬切，~3000 LOC churn）：
  - E5 (watcher + coordinator session-upserted 监听) + E6 (老 backend 删 + canJoinTeam 删)
  - E7 (UI 重写) + E8 (IPC 重写 + task-manager 迁移到 teamIdProvider) + E9 (event-bus)
  - E10 (CLI 跨 adapter) + E11 (deep-code-review SKILL 重写) + E13 (文档 / CHANGELOG / README)
  - **发版纪律**：E11 SKILL 必须与 PR-B **同日发版**，否则用户 update 后 deep-code-review SKILL 直接挂

**间隔建议**：PR-A 与 PR-B 间隔 ≥ 2 天（让用户先用 export 备份）。

---

## 9. 与 deep-code-review SKILL 重写（E11）的接口

E11 重写后的 SKILL 必须**只**依赖：
1. agent-deck-mcp 6 tool（spawn / send / wait_reply / list / get / shutdown）
2. R3 新增 IPC `agent-deck-team:list / get`（如果 SKILL 想可视化也可不用）

**不允许**继续依赖：
- `TeamCreate / Agent(team_name=...) / SendMessage(to=...) / TeamDelete`（Claude builtin tools，硬切后无对应 backend）
- `~/.claude/teams/<X>/config.json` 文件协议
- inbox 文件 / `inbox-watcher` / `team-coordinator`

**重写关键模式**（lead = 当前 Claude session；reviewer-claude / reviewer-codex 起为 teammate session）：

```ts
// 在 Claude 会话内（lead），SKILL 指导 LLM 调：
const teamName = `review-${Date.now()}`;

const reviewerClaude = await spawn_session({
  adapter: 'claude-code',
  cwd: REPO_ABS_PATH,
  prompt: REVIEWER_CLAUDE_PROMPT,
  team_name: teamName,
});
const teamSpawnedAt = Date.now();   // 用作 wait_reply since_ts 防 race（reviewer claude MED-13）

const reviewerCodex = await spawn_session({
  adapter: 'codex-cli',
  cwd: REPO_ABS_PATH,
  prompt: REVIEWER_CODEX_PROMPT,
  team_name: teamName,
});

// 等两个 reviewer 各自完成首轮 review
// 关键：since_ts = teamSpawnedAt - 5000（buffer 5s 防 SDK adapter event 比 wait_reply
// 注册更早到达，被 baselineTs 过滤掉的 race window）
const [claudeReply, codexReply] = await Promise.all([
  wait_reply({
    session_id: reviewerClaude.sessionId,
    until: 'turn_complete',
    timeout_ms: 600_000,
    since_ts: teamSpawnedAt - 5000,
  }),
  wait_reply({
    session_id: reviewerCodex.sessionId,
    until: 'turn_complete',
    timeout_ms: 600_000,
    since_ts: teamSpawnedAt - 5000,
  }),
]);

// lead 自己做三态裁决；如有 HIGH 单方独有 → 反驳轮：
// send_message + wait_reply（注意每次 send 后用新 sentAt 做 since_ts）
const sendResp = await send_message({
  session_id: reviewerCodex.sessionId,
  text: REBUTTAL_PROMPT,
  // multi-team 共享时必填 team_id；单 team 共享时可省
});
const codexRebuttal = await wait_reply({
  session_id: reviewerCodex.sessionId,
  until: 'turn_complete',
  timeout_ms: 180_000,
  since_ts: sendResp.sentAt - 5000,   // 用 send_message 返回的 sentAt
});

// 收尾
await Promise.all([
  shutdown_session({ session_id: reviewerClaude.sessionId }),
  shutdown_session({ session_id: reviewerCodex.sessionId }),
]);
```

**老 SKILL 的 §Step 2 团队模式 + §Round 2 反驳轮**整段重写。reviewer-claude / reviewer-codex
的 agent body（`reviewer-*.md`）也重写：删去所有「lead SendMessage / inbox 协议 /
shutdown_request / TeamDelete 异步延迟」相关段落，改写「reviewer 是 teammate session，被
lead 通过 send_message 驱动；reviewer 用 plain text reply（不要试图调 SendMessage）；turn 结束
自动触发 turn_complete 让 lead 拿到」。

---

## 10. 用户工作流断点（README + 启动 dialog 必须显式说明）

### 10.1 永久失效

1. **Claude Code CLI 内自起的 team 不再被 agent-deck UI 看到**。用户在 Claude 会话内通过自然
   语言 / `Task(team_name=...)` 起的 team，PendingTab / TeamHub / TeamDetail 完全没反应。
   permission_request 不再弹 PendingTab。
2. **CHANGELOG_56 `autoApproveTeammateMode` 三档 setting 消失**。新 backend 自带「按 capability +
   工具白名单」自动审批语义，不暴露给用户调档。
3. **老 team 数据废弃**。`~/.claude/teams/<X>/config.json` 不再被读取 / 不再显示。Settings
   提供 export 按钮一次性导出（E12）。
4. **老 deep-code-review SKILL workflow 废弃**。重写后用户需重新熟悉新 6 tool 路径。

### 10.2 替换路径

| 老操作 | 新操作 |
|---|---|
| 在 Claude 会话内说「创建 team T」让 Claude 自起 | 在 Claude 会话内调 `mcp__agent-deck__spawn_session({team_name:'T', ...})` |
| 在 Claude 会话内 `SendMessage(to:'reviewer', ...)` | `mcp__agent-deck__send_message({session_id: <reviewer-sid>, team_id?: ..., text:...})` |
| 等 teammate idle | `mcp__agent-deck__wait_reply({session_id:..., until:'idle', since_ts: ...})` |
| `TeamDelete()` | `mcp__agent-deck__shutdown_session` 各 member + IPC archive team |

### 10.3 不变

- agent-deck UI 起的 team（NewTeamDialog / NewSessionDialog 入口）继续工作（走新 backend）
- agent-deck CLI（`agent-deck new --team T --member-claude X --member-codex Y`，E10）
- agent-deck-mcp 6 tool 自身的 wire schema 整体保留（仅 `send_message` 加 optional team_id；
  `spawn_session` 实现语义重写但 wire 兼容）

---

## 11. 风险 & 兜底

### 11.1 PR-B 一次性切换的 blast radius

**风险**：PR-B 包含 E5/E6/E7/E8/E9/E10/E11/E13 八个任务一次合入，文件 churn ~3000 LOC，
review 工作量大；任何 bug 都会让用户的 team 工作流完全失效。

**兜底**：
- PR-B 合入前必须跑：`pnpm typecheck` + `pnpm vitest run`（含 E5 watcher 单测 + E11 SKILL
  本地手验「跨 adapter 起 reviewer-claude + reviewer-codex」端到端 + coordinator session-upserted
  监听单测）
- 单独 PR-A 先合入预备 schema / 接口 / 导出按钮（与 PR-B 间隔 ≥ 2 天，让用户先用 export 备份）
- PR-B 合入当晚发版，README 大改 + 启动 dialog 提示老 workflow 失效；用户首次启动新版本时
  Settings 自动跳到「老 team 数据已禁用，点击导出」页面（E12 兜底）
- 万一 E5 watcher 出严重 bug（消息全卡 pending）→ 紧急回滚仅需 revert PR-B（PR-A 数据无害；
  v010/v011 schema 已在 → 回滚 PR-B 后 schema 仍在但 universal-watcher 不启动 → message 表停写）
- E11 SKILL 单跑测试：在 worktree 内手动调 `/agent-deck:deep-code-review` 跑一轮真 review
  case 验证（E13 verification 步骤）

### 11.2 watcher 投递可靠性

- crash recovery（§4.6）已设计；进程 crash → 重启自动重投 delivering 状态行（不再无条件 ++）
- adapter 长时间无响应 → MAX_RETRY=3 退避 1s/4s 后 status='failed'，UI 显示 / 不阻塞 lead
- 大 body（> 100KB）：messageRepo.insert 在 enqueue 时校验长度（与 R2 send_message tool 同款
  100KB 上限）+ SQLite CHECK 兜底，超过 reject

### 11.3 老 fs 残留

用户磁盘上的 `~/.claude/teams/<X>/` / `~/.claude/tasks/<X>/` 目录硬切后**不主动清理**。E12
export 按钮把它们打包成 zip 让用户备份；用户自己决定是否 `rm -rf`（防误删工作内容）。

### 11.4 老用户工作流依赖度未知（reviewer codex *未验证*）

「Claude 自起 team 的 PendingTab 不再弹」对实际用户使用影响无遥测数据支撑。如果重度用户比例
高（≥ 30%），README + 启动 dialog 不足以降低迁移成本。

兜底：
- 启动 dialog **不可关闭**直到用户阅读完毕并显式 ack（避免「点叉 → 后续就不知道了」）
- 用户首次升级版本后 Settings 顶端有持久 banner（不可隐藏）：「Claude 自起 team 已停止支持，
  请改用 mcp__agent-deck__spawn_session」附「查看迁移指南」按钮
- E13 README 顶端加大写醒目段；deep-code-review SKILL 文档加「老用户必看」前置章节

### 11.5 multi-team 设计的 caller 多义性

§5.2 `send_message` 加 `team_id` 解决了「caller 与 target 共享多 team」歧义；但 §5.4
task-manager 迁移路径下 `teamIdProvider` 在 lead 多 team 时取「最近 join + lead role 优先」
启发式，仍可能与用户预期不一致。E13 文档需明确：
- 多 team 协作场景下，用户应**显式**在 IPC `agent-deck-team:create` 后只把当前会话加入一个 team
- task-manager 不支持「同一 lead 同时管多 team 的 task」（取最近 join 的 team 是 best-effort）
- 如有强需求 → 升级 task-manager schema 加 lead 显式 selector

---

## 12. Verification（E13 阶段写完 R3 后回填）

完成后必须能跑通：

1. `pnpm typecheck` 全绿（E1 + E6 删完无悬挂 import）
2. `pnpm vitest run`（含 E3 repo + E5 watcher 单测 + coordinator session-upserted 监听单测 +
   PerKeyRateLimiter 单测）
3. **跨 adapter 端到端**（E5 verification）：
   ```
   IPC create_team("T") → IPC create_session(adapter='claude-code', team='T', role='lead') = sid_A
                       → IPC create_session(adapter='codex-cli',   team='T', role='teammate') = sid_B
   IPC send_message(team='T', from=sid_A, to=sid_B, body='hello from claude')
   等 1-2s
   verify codex session sid_B 内出现 user message 包含 "hello from claude"
   ```
4. **deep-code-review SKILL 端到端**（E11 verification）：
   ```
   在本仓库一个 Claude 会话内调 /agent-deck:deep-code-review
   预期：lead 调 spawn_session 起 reviewer-claude + reviewer-codex 两个 teammate
        各 wait_reply 拿到结论
        lead 自己做三态裁决
        最终 shutdown_session 收尾
   ```
5. **老 inbox-watcher / team-coordinator 完全不加载**：启动后 ps + log 验证；renderer team UI
   仅显示新 backend team
6. **老 settings 字段自动消失**：启动后 settings.json 不再含 `agentTeamsEnabled` /
   `autoApproveTeammateMode` 字段（settings-store REMOVED_KEYS 自动 delete）
7. **export 按钮**（E12 verification）：用户能下载 `legacy-teams-export-<date>.zip`，含所有
   `~/.claude/teams/<X>/` 子目录的递归内容
8. **task-manager 迁移**（§5.4 verification）：`mcp__tasks__task_create` in claude session
   that joined team T → tasks.team_id 列填 T.id 而不是 NULL；TaskListByTeam(T.id) 拉到
9. **wait_reply close 解锁**（§4.8 verification）：lead `wait_reply(until='turn_complete')`
   pending 期间 receiver shutdown_session → lead 立即拿到 `reason='session-closed'` 结果（≤ 200ms），
   不卡 60s timeout
10. **send_message multi-team 校验**（§5.2 verification）：
    - 共享 0 team → reject `no-shared-team`
    - 共享 1 team → 自动选成功
    - 共享 ≥ 2 team 不传 team_id → reject `ambiguous-team`
    - 共享 ≥ 2 team 传错的 team_id → reject `team-not-shared`

---

## 13. 已 review 验证的方向（reviewer 双对抗结论已落地）

### 13.1 双方一致 ✅（直接落地）

- §2.2 schema 设计基本骨架（团队 + member + message 三表 + 状态机正交）
- §3 adapter 接口扩展方向（canCollaborate / receiveTeammateMessage / notifyTeammateEvent）
- §6 删除清单路径（inbox-watcher / team-coordinator / inbox-protocol / auto-approve / team-watcher 全删）
- §10 用户工作流断点声明的必要性
- §11 PR-A / PR-B 拆分大方向

### 13.2 ✅ HIGH（双方独立提出 / 反驳证实，本 ADR 已修订）

- HIGH-1 watcher backoff schema 缺 `last_attempt_at` → §2.2 + §4.1 + §4.5 修订
- HIGH-2 CASCADE on team_members.session_id 与 hard-delete 冲突 → §2.2 + §2.5 修订
- HIGH-3 删除清单不完整 → §6.1 + §6.2 + §6.6 详细行号补全
- HIGH-4 `send_message` 缺 team selector（codex 提，反驳证实）→ §5.2 amend
- HIGH-5 Task Manager 仍依赖 sessions.team_name（codex 提，反驳证实）→ §5.4 task-manager 迁移路径

### 13.3 ❓ → MED（反驳轮证伪 HIGH 严重度，但仍需修订）

- MED-降级 1 spawn_session ensure-team-by-name 设计层面需 partial unique 索引（claude 提，反驳：当前代码无 race 但 ADR 设计需补） → §2.2 部分 unique 索引落地
- MED-降级 2 canJoinTeam 删除时机（claude 提，反驳：破坏面较小但排期需修） → §3.2 + §8 PR 拆分修订（删除推到 PR-B）
- MED-降级 3 wait_reply 不监听 lifecycle closed（codex 提，反驳：default 路径有兜底但 turn_complete 真卡 600s） → §4.8 修订（coordinator 加 session-upserted 监听）

### 13.4 其他 MED ✅（双方覆盖不同角度，本 ADR 已修订）

- wire format 前缀字符串不一致 → §3.1 + §4.4 统一格式
- notifyTeammateEvent dispatcher 缺失 → §4.9 新增 dispatcher 设计
- per-team 60/min 限流实施位置 + adapter queue 协同 → §7.5 详细化（PerKeyRateLimiter / settings 字段）
- task:list-by-team 与重名 team 歧义 → §5.4 task-manager 迁移配套（用 team_id）
- renderer 删除清单遗漏 50 处 TeamPermissionRequest 消费点 → §6.6 详列
- inbox-protocol.test.ts 漏列 → §6.1 补
- crash recovery `attempt_count++` 体验差 → §4.6 修订（不再无条件 ++）
- wait_reply since_ts race window → §9 SKILL 范例显式传 since_ts
- spawn_session 必带 prompt → 无法 MCP 内先建空 team → §5.3 明确 spec 限制
- R2 ADR §12 路线图与 R3 决策矛盾 → §1.2 + §5.3 声明 R2 ADR 路线图作废
- schema lead>=1 / lead<=10 / body<=100KB 不变量 → §2.1 repo 层强制 + §2.2 SQL CHECK 兜底

### 13.5 ❌ 反驳证伪条目

- 「migration v010 编号错误」→ 实证 v001-v009 已存在，v010 + v011 编号正确
- 「ADR §6.3 REMOVED_KEYS 机制不可用」→ 实证 settings-store.ts 既有机制工作正常
- 「§2.3 sessionRepo.upsert 仍写 team_name 列方案不可行」→ 实证可行（INSERT 列位保留 + 写值固定 null）
- 「session 可在多 team 设计应砍」→ 多 team 场景（reviewer 跨多轮 review）合理；通过 §5.2
  send_message 加 team_id selector 解决歧义

### 13.6 INFO（设计澄清，已落地）

- caller 自动以 'lead' role 加入团队，与 caller adapter type 无关 → §3.2 表已隐含
- PR-A 后启动一次性 dialog 引导用户去 Settings 点 export → §11.4 兜底
- metadata 读路径必须 type-guard → §2.4 注释
- sdk-bridge env 注入段行号定位 → §6.2 已列

---

**End of ADR.** 状态置 ACCEPTED，可启动 E1。

> reviewer-claude (Opus 4.7) + reviewer-codex (gpt-5.5) 双对抗共 27+11 finding，
> 经反驳轮收敛：5 HIGH ✅ + 3 HIGH→MED 修订 + 7 MED 修订 + 5 反驳证伪 + INFO 落地。
> 双方独立读 R3 ADR + R2 ADR + 现有 team backend 代码 + adapter / coordinator / scheduler /
> task-manager 各路径，结论可信度高。
