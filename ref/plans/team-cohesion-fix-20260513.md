---
plan_id: team-cohesion-fix-20260513
created_at: 2026-05-13
worktree_path: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/team-cohesion-fix-20260513
base_commit: 059327fba07cf156da6f986f7a45a082f0856c2e
status: completed
---

# Plan: 团队凝聚力修复（lead 数据源 / TeamDetail / send_message 内嵌 wait / Pending teammate 标识 / 团队清理）

## 总目标 & 不变量

把"团队"概念在数据 / UI / MCP / 生命周期清理 五层贯通：消除 `sessions.team_name` 双源、把 TeamDetail 从"最小可用"补成"团队工作面板"、把 `wait_reply` 退役为 `send_message` 内嵌 await 的简化模型、PendingTab 显式带出 team + role 上下文、补齐团队级清理机制（lead close 级联 / 幽灵 team 自动归档 / shutdown all teammates / session close 自动 leave member）。

**用户态硬约束**：
- lead 必须在 SessionList 显示 🛡 teamName chip（与 teammate 视觉一致），不允许 lead 静默缺标
- 团队页面打开后能看到团队全貌（成员树 / 聚合事件流 / 跨成员 task / 跨 adapter 消息），不必跳到 N 个 SessionDetail
- MCP caller 一次调用就能拿到 teammate 的 reply（不再 send + wait 拼装）
- PendingTab 看到的每条 permission_request 都要标团队 + 角色
- **团队级生命周期清理可见可控**：lead close 后团队不能成为"僵尸"（无 active member 但 team.archivedAt=null，UI 仍显示但无法操作）；用户能一键 shutdown all teammates；session close 时自动从所属 teams 离开（设 left_at），无需用户手工清理 membership

**技术不变量**：
- universal team backend (`agentDeckTeamRepo` + members 表) 是 team 关系的唯一权威，**任何时刻不允许从 `sessions.team_name` 列读 team 信息**
- multi-team 共享是合法状态（一个 session 可同时属于多个 team），UI 不强制单值化
- DB migration 必须 backward-safe（v012 onUpgrade 自动跑，老 DB 平滑迁移）
- 改 main / preload 必须重启 dev；改 renderer 走 HMR

## 设计决策（实施前需走双对抗 review 收口）

> ⚠️ 用户当前选定 "进 worktree + plan，先不做双对抗"，但实施前**必须**对下列设计决策走 reviewer-claude + reviewer-codex 异构对抗（按 ~/.claude/CLAUDE.md「决策对抗」节，plan 内的设计决策不能因机械触发跳过）。本节先记录决策草案，待对抗轮收口。

### D1. SessionRecord 的 team 字段：单值 fallback vs 数组

**草案**：`SessionRecord.teams: { id, name, role: 'lead'|'teammate', joinedAt, leftAt }[]` 数组（active membership 全列），废弃单值 `teamName` 字段。
- **理由**：multi-team 是 universal team backend 合法状态（CHANGELOG_76 D3 备注里 projectSession 已选"取第一个 active"是 fallback），UI 应正面承认；单值 chip 渲染时取 `teams[0]?.name`，hover 弹完整列表
- **反例考虑**：单值 + multi-team 时强迫排序（first by joinedAt？by activity？），UI 信息隐藏歧义大；数组对调用点改造范围大但收益匹配
- **待对抗**：API 兼容（type 改了 IPC schema 全跟）/ persistence 路径 / 性能（list 路径 N+1）

### D2. DB migration v012：drop `sessions.team_name` 列

**草案**：v012 onUpgrade 直接 `ALTER TABLE sessions DROP COLUMN team_name`，老数据已在 D2.5 步骤 backfill 到 universal team backend。
- **理由**：CHANGELOG_76 备注已明示"下版本 v012 删"，把 v012 提前到本 plan 落地，单源收口
- **反例考虑**：万一漏调用点还在写 `team_name` 列 → SQLite 直接 throw `no such column: team_name`，bootstrap 死。修法：D2 step 0 先 grep 全仓库所有 `team_name` 字面量调用点，保证写路径全清理后才 drop
- **待对抗**：onUpgrade 失败 rollback 策略 / 用户 DB 备份路径 / 老备份 restore 兼容

### D2.5. v011 → v012 migration 数据回填

**草案**：v012 onUpgrade 第一步：
```sql
-- 把 sessions.team_name 非空且 universal team backend 还没 membership 的 session 补 ensureByName + addMember
SELECT id, team_name, started_at FROM sessions
WHERE team_name IS NOT NULL
  AND id NOT IN (SELECT session_id FROM agent_deck_team_members WHERE left_at IS NULL);
-- 对每行：ensureByName(team_name) + addMember({sessionId, role: 'teammate' /* 历史不知道 lead/teammate，统一打 teammate */, displayName: null})
```
然后 drop column。

- **理由**：避免历史 team 信息在 v012 升级时丢失（用户已有 sessions.team_name 数据，不能简单 drop）
- **反例考虑**：role 信息丢失（历史只有 team_name 没有 role）→ 一律 teammate 是粗粒度但安全（lead 角色由后续 spawn_session 重新建立时自然形成；不影响渲染，只是 lead chip 暂缺直到下次 spawn）
- **待对抗**：onUpgrade 跑批的 transaction 边界 / 失败回滚 / dry-run 工具

### D3. send / reply / wait_reply 三 tool — 显式 IM + 对话链 + 催回复（方案 D 收口）

**核心语义**（用户 2026-05-13 三轮澄清后收口）：
1. `send_message` 是 **IM 模型** — lead 在 target session 的 user turn 里**插入一条消息**，**不阻塞 / 不返事件流**
2. teammate 收到后**显式调 reply_message**（或 send_message 带 `reply_to_message_id`）回复，对话链由 `reply_to_message_id` 列在 DB 持久化、可追溯
3. `wait_reply` **保留**，但语义重定义为「**等某条 msg 的 reply + 可选催（塞条内容给对方）**」—— 不是事件流投影

**三 tool 草案**：

#### `mcp__agent_deck__send_message`
```ts
{
  to_session_id: string,
  text: string,
  reply_to_message_id?: string,    // 可选：建立对话链（这条是对某条的回复 / 续问）
  team_id?: string,                 // 多 team 共享时必填，已有逻辑
  caller_session_id: string,
}
→ { messageId, sentAt, replyToMessageId: string | null }
```
**完全 fire-and-forget**，立即返回 messageId。无 await 字段、无 events 字段、无 reply 字段。

#### `mcp__agent_deck__wait_reply`
```ts
{
  message_id: string,               // 等这条 msg 的 reply（DB query: reply_to_message_id=?）
  nudge_text?: string,              // 可选：等久了塞条内容给对方（用作"催回复"）
  nudge_after_ms?: number,          // 可选：多久没回开始催（默认 60s，timeout_ms / 2 兜底）
  timeout_ms?: number,              // 默认 600s
  caller_session_id: string,
}
→ { reply: { messageId, text, sentAt, fromSessionId } | null, nudgesSent: number, timedOut: boolean }
```
内部实现：
- 注册 messages 表 listener（universal-message-watcher emit `agent-deck-message-changed`）filter `reply_to_message_id === args.message_id`
- 拿到 reply → resolve { reply: ..., nudgesSent }
- nudge_after_ms 到了仍无 reply + nudge_text 非空 → 调 enqueueAgentDeckMessage 给 target 塞条 nudge（reply_to_message_id 指向原 msg）+ nudgesSent++ + reset nudge timer
- timeout_ms 到了 → resolve { reply: null, timedOut: true }

#### `mcp__agent_deck__reply_message`（可选语法糖；其实 send_message 带 reply_to_message_id 等价）
```ts
{
  reply_to_message_id: string,
  text: string,
  caller_session_id: string,
}
→ { messageId, sentAt, replyToMessageId }
```
内部 = send_message + 自动算 to_session_id（从原 msg 的 from_session_id 反查）+ 自动 team_id（从原 msg 的 team_id 复用）。让 teammate 写"我回复 X"比"我给 X 的发起方发消息"更直观。

#### DB schema 改动
- `agent_deck_messages` 加 `reply_to_message_id TEXT NULL REFERENCES agent_deck_messages(id) ON DELETE SET NULL`
- 加索引 `idx_messages_reply_to ON agent_deck_messages(reply_to_message_id) WHERE reply_to_message_id IS NOT NULL`
- migration v013（v012 是 drop sessions.team_name；v013 加 messages.reply_to_message_id）

#### SKILL doc 强约束
teammate agent body / SKILL.md 必须写：
> 收到 user message 时（universal-message-watcher 投递），**必须在自己的 turn 内显式调 `mcp__agent_deck__reply_message({reply_to_message_id, text})` 把回复发回**。否则发起方 wait_reply 会 timeout。lead 也同样规则（lead 收 teammate 回复后想再问要走 reply_message）。

### 设计权衡总结

- **优点**：完全异步（HTTP 短 connection）；显式（reply 必须主动调，零 heuristic）；对话链可追溯（DB FK 关联）；wait_reply 保留 + "催" 副作用实用（reviewer 不调 reply 时 lead 主动催）；双向（lead/teammate 互相 reply 形成多轮）
- **缺点**：teammate 不调 reply_message → 无 reply（强依赖 SKILL doc 约束 + reviewer agent body 强提示 + nudge 兜底）；新增 reply_message tool + 1 schema 字段 + 2 个 migration（v012 drop teamname / v013 加 reply_to_message_id）
- **删除项**：`wait_reply` **重定义保留**（不删，但语义彻底重写）；老 `wait-reply-coordinator.ts` 删（它是事件流投影模型，新 wait_reply 是 messages 表 query 模型）

**实施顺序约束**（影响 Phase B step 排序）：
- B1: messages 表 v013 migration + reply_to_message_id 列
- B2: send_message 加 reply_to_message_id 入参
- B3: 实现 reply_message tool（语法糖）
- B4: 重写 wait_reply（删 coordinator → 改成 messages 表 query + universal-message-watcher event listener）
- B5: SKILL doc 强约束更新
- B6: 老 wait-reply-coordinator.ts 整文件删 + tests 同步迁移

#### 方案 A：sync 阻塞 — send_message 等到对方 turn 完成返回 reply 文本

- send_message 内嵌 wait，handler 注册 `agent-event` listener filter `kind === 'message'` 抽 assistant text，target session `finished` / `waiting-for-user` 时 resolve
- 返回 `{ messageId, sentAt, reply: string, replyMeta: {messageCount, firstTs, lastTs}, timedOut, hadError }`
- `reply: string` = 这一轮所有 assistant text 按 ts 升序 join '\n\n'
- 删 `mcp__agent_deck__wait_reply` + `wait-reply-coordinator.ts`
- **优点**：caller 一次 RPC 拿 reply，最少心智负担
- **缺点**：阻塞 MCP RPC（HTTP transport 长 connection 5-10min）；扫 assistant text 拼接是 heuristic（thinking / tool-use 算不算？多 message 拼接边界模糊）；单向（teammate 不能反向给 lead 发新主题，只能在自己 turn 回）

#### 方案 B：异步显式 reply tool — send fire-and-forget + 新 reply_message tool

- `send_message` schema 不变（去掉 `await` 字段），fire-and-forget 返回 `{ messageId, sentAt }`
- 加新 MCP tool **`mcp__agent_deck__reply_message(replyToMessageId, text)`**：teammate 收到 user message 后，在自己的 turn 内显式调 reply_message 把回复发回原发送方
- DB messages 表加 `reply_to_message_id TEXT NULL` 列（指向原 message），FK 到自己
- lead 想看 reply 走 **`mcp__agent_deck__list_messages({ replyToMessageId })`** 或 polling
- 关键约束：teammate SKILL doc / system prompt 必须显式约定"收到 user message 后必须 call reply_message tool"，否则对方没回复
- **优点**：完全异步（HTTP 短 connection）；显式语义（teammate 必须主动回，不靠 heuristic 扫 text）；对话链可追溯（DB FK 关联）；双向（teammate 也能 reply_message 给 lead，或 lead 给 teammate 回 reply 形成多轮）
- **缺点**：teammate 不调 reply_message → lead 永远等不到（强依赖 SKILL doc 约束 + reviewer agent body 强提示）；polling 模型不如 push 实时；新增 2 个 tool（reply_message / list_messages）+ 1 个 schema 字段 + migration

#### 方案 C：A+B 混合 — async fire-and-forget 默认 + 可选阻塞等某条 reply

- `send_message` 默认 fire-and-forget 返回 `{ messageId, sentAt }`
- 加 `reply_message(replyToMessageId, text)` tool（同方案 B）
- 重新定义 `wait_reply` 语义为 **"等某条 msg 的 reply"**（不是事件流）：`wait_reply({ messageId, timeoutMs })` → 阻塞直到 messages 表里出现 `reply_to_message_id = messageId` 的新行 → 返回 reply text
- lead 想等就调 wait_reply，不想等就 polling list_messages，灵活
- **优点**：A 的 sync 易用 + B 的 async 灵活双拥；wait_reply 语义清晰（等具体某条的 reply 而不是事件流投影）
- **缺点**：API 表面最大（send + reply + wait + list 四 tool）；但每 tool 语义干净，比方案 A 的 send_message+await 多档单 tool 更易理解

#### 决策待定（用户 2026-05-13 待裁决）

- 倾向 B/C 还是 A？B/C 牺牲"reviewer 不调 reply_message 就翻车"换取技术完善（异步 + 显式 + 可追溯）；A 牺牲技术细节换取最少 caller 改造
- 如选 B/C：reply_message 的 reply_to_message_id 是必填还是可选（teammate 主动 originate 新对话也用同一 tool）？建议必填，新对话走 send_message
- 如选 A：assistant text 多 message 拼接边界 / thinking 是否计入 / error message 处理 待定

**待对抗**：上述三方案的安全 / 性能 / 易用性 / 与 SKILL doc 约束的耦合度

### D4. PendingTab teammate 上下文展示

**草案**：PendingRow 渲染 `permission_request` 时反查 `findActiveMembershipsBySession(sid)`：
- 有 active membership → 显示 `🛡 <teamName> · 👑 lead | ↳ teammate · <session.title>`
- 无 → 不变（普通 session 审批）

数据走 IPC：PendingTab 拉 pending list 时一并 batch 反查 (`findActiveMembershipsBySessionIds(ids[])` 批量 API，避免 N+1）；订阅 `onAgentDeckTeamChanged` 增量刷新。

- **理由**：用户审批时不知道是哪个团队哪个角色，无法做出"这是 reviewer-codex 在请求 Bash"还是"普通 session 在请求 rm -rf"的差异化决策
- **反例考虑**：pending 数量大时 batch 反查仍要一次 SQL，性能 OK；无 active membership 时不能误标为团队（→ undefined chip）
- **待对抗**：UI 信息密度（标签太多挤占空间）/ pending 列表更新频率（避免每次 ts 变都重查）

### D5. TeamDetail 5 sections 数据流

**草案**：TeamDetail snapshot 走单一 IPC `agent-deck-team:get-full(teamId)` 返回：
```ts
{
  team: AgentDeckTeam,
  members: AgentDeckTeamMember[],
  lineage: { rootSessionId, treeNodes: { sid, spawnedBy, depth }[] },
  recentEvents: AgentEvent[],   // 跨成员聚合，limit 50 ts DESC
  tasks: TaskRecord[],          // 走 task-repo.listByTeamId(teamId)
  recentMessages: AgentDeckMessage[],
  pendingPermissions: { sid, count }[],  // PendingTab 同源数据
}
```

增量更新：subscribe `onAgentEvent` / `onTaskChanged` / `onAgentDeckTeamChanged` / `onAgentDeckMessageChanged` / `onSessionUpserted` 全监听，patch 各 section 而非整 snapshot 重拉。

- **理由**：
  - 5 个 section 走 5 个独立 IPC 会有 race（一个先回一个后回，UI 闪烁）
  - 单 snapshot + 增量 patch 是 React 标准 reactive 模式
- **反例考虑**：
  - snapshot 大（事件流 50 条 + 消息 30 条 + task N 条）→ 首次拉慢；mitigate 走 indexed query + 限 limit
  - 增量 patch 复杂度（5 类事件各自 reducer）→ 收益匹配；写小 helper module 集中 patch 逻辑
- **待对抗**：
  - lineage 计算放主进程（IPC 跑 SQL 拼树）vs renderer（拿 sessions Map 自拼）—— 草案放主进程统一返回，避免 renderer 重复实现
  - tasks 字段：task-repo 当前是否支持 `listByTeamId` 查询？需先确认 schema 有 team_id 列
  - pendingPermissions 数据源与 PendingTab 同源：需保证不走两条独立 IPC（避免不一致）

### D6. session close 时自动 leave membership（被动清理）

**草案**：在 `sessionManager.close(sid)` / `markClosed(sid)` 内部，已 emit `session-upserted` 之后，加一步：
```ts
const memberships = agentDeckTeamRepo.findActiveMembershipsBySession(sid);
for (const m of memberships) {
  agentDeckTeamRepo.setMemberLeftAt(m.teamId, sid, Date.now());
}
```

- **理由**：当前 session close 后 `agent_deck_team_members.left_at` 仍为 NULL → `findActiveMembershipsBySession` / TeamDetail 仍把这个 closed session 算 active member → UI 上看到一堆"已 closed 但仍在 team"的幽灵成员
- **反例考虑**：
  - 用户 reactivate 一个 closed session（lifecycle: closed → active），是否要 rejoin team？→ **不要**自动 rejoin（语义不清，可能加错 team），让用户手工 spawn 新 team；reactivate 是少数场景，UX 可接受
  - DELETE session 时（`sessionRepo.delete(sid)`）的级联：member 表已有 `ON DELETE CASCADE` 还是 ON DELETE NO ACTION？需确认 schema，若无 cascade 要在 sessionRepo.delete 里手工删 membership
- **待对抗**：member 表外键约束 / reactivate 的语义边界 / 与 D7 自动归档的相互作用

### D7. lead close 级联策略 + 幽灵 team 自动归档（主动清理）

**草案**：
1. **lead close 不级联 shutdown teammates**（保守）：lead session close 时只走 D6 setLeftAt，**不**自动 close 其他 teammate session（lead 可能只是临时退出，teammate 继续工作合理）
2. **幽灵 team 自动归档 scheduler**：`TeamLifecycleScheduler` 周期性扫（默认 5 分钟一次）：
   - 拉所有 `archivedAt=NULL` 的 team
   - 对每个 team 拉 active members（`left_at IS NULL`）
   - active members 里所有 session 都 lifecycle ∈ {'closed', 'archived'} → 把 team 设 `archivedAt = Date.now()`，emit `agent-deck-team-changed`（让 TeamHub UI 刷新）
3. **手动批量操作 IPC**：
   - `agent-deck-team:shutdown-all-teammates(teamId)`：批量调 `sessionManager.close(memberSid)`（仅 teammate role，不 close lead）
   - `agent-deck-team:archive-team(teamId)`：手动归档整 team（不 close member session，只标 team archived）
   - 两个 IPC 在 TeamDetail Header 暴露按钮

- **理由**：
  - lead close 不级联是保留用户工作（典型场景：lead 临时关掉去做别的，回来 reactivate；teammate 继续跑也合理）
  - scheduler 兜底"用户忘了归档"的常态：reviewer 跑完 review 自然 closed，没有 lead 主动 archive team → 一周后 TeamHub 仍显示 N 个空 team，找不到现在活跃的
  - 手动 IPC 给"我现在就要清干净"的场景
- **反例考虑**：
  - scheduler 误归档（teammate 短暂 closed 但马上 reactivate）→ scheduler 加 grace period（默认 close 后 30 分钟再归档？）；或要求 team 必须**没有任何 active member 持续 N 分钟**才归档
  - shutdown-all-teammates 失败的成员怎么办（adapter close throw）→ 收集失败列表返回给 UI，不一刀切失败
  - 多 lead team（可能未来支持）：lead A close 但 lead B 还在 → team 不该归档；scheduler 判定"无 active member"时也应包含 lead role
- **待对抗**：
  - scheduler 周期 / grace period 默认值
  - shutdown 顺序（lead 自动级联 vs 用户显式）的安全边界
  - 与 universal-message-watcher / wait-reply 的 race（teammate 正在跑被 shutdown 时 collected events 怎么处理）
  - reactivate 路径的 team 归宿（自动 unarchive team？）

## 步骤 checklist

- [~] **Step 0**：~~实施前对 D1-D5 走 reviewer-claude + reviewer-codex 异构双对抗 review~~ —— **SKIP**（用户 2026-05-13 决定：当前对抗 review 流程坏了，先不管这个继续）。风险记录：D1-D7 设计决策未走异构对抗，可能存在边界遗漏 / 性能未验证 / 兼容性未尽尽，实施过程中遇到反例须及时回到本节修订决策；后续对抗 review 修复后可补审本 plan。

### Phase A：数据层统一（方案 1）

- [ ] **Step A1**：grep 全仓库所有 `team_name` 字面量调用点（包括 sessionRepo.setTeamName / recordCreatedTeamName / distinctTeamNames / findByTeamName / clearTeamName / IPC handler / UI），列清单到本 plan 备忘
- [ ] **Step A2**：在 `agentDeckTeamRepo` 加批量 API `findActiveMembershipsBySessionIds(ids: string[]): Map<sid, Array<{teamId, teamName, role, joinedAt}>>`，单 SQL JOIN members + teams 一次返回
- [ ] **Step A3**：改 `SessionRecord` type（`shared/types.ts`）：删 `teamName`，加 `teams?: Array<{id, name, role, joinedAt, leftAt: null}>`
- [ ] **Step A4**：改 `sessionRepo.toSessionRecord` —— 不再产 `teamName`，改成纯 DB row 投影（不含 teams 字段）
- [ ] **Step A5**：在 `sessionManager` 层加 enrich helper `enrichWithTeams(rec: SessionRecord): SessionRecord`，单 record 用 `findActiveMembershipsBySession(sid)`；批量场景（`sessionManager.snapshot()`）用 batch API
- [ ] **Step A6**：所有 `eventBus.emit('session-upserted', rec)` 调用点确保 `rec` 已 enriched（要么 enrich 到位要么 emit 后由 listener enrich；草案选前者，emit 前 enrich 一次，避免重复 query）
- [ ] **Step A7**：MCP `projectSession` 改成消费新 `teams` 数组，`teamName` 字段保留向后兼容（取 `teams[0]?.name`），加 `teams: rec.teams` 完整数组字段
- [ ] **Step A8**：删写路径：`sessionRepo.setTeamName` / `recordCreatedTeamName` / `distinctTeamNames` / `findByTeamName` / `clearTeamName`，调用点全部改走 universal team backend
- [ ] **Step A9**：DB migration v012：onUpgrade 第一步跑 D2.5 backfill SQL（sessions.team_name 非空且无 membership 的回填到 universal team backend），第二步 `ALTER TABLE sessions DROP COLUMN team_name`
- [ ] **Step A10**：UI 切换：`SessionCard.tsx` 紫色 chip 改读 `session.teams[0]?.name`，title hover 弹完整 team 列表 + 角色
- [ ] **Step A11**：typecheck + build + 跑 task-repo / agent-deck-team-repo / mcp tests + 重启 dev 实测 lead/teammate 都显示 🛡 chip

### Phase B：MCP send_message 内嵌 wait（方案 3）

- [ ] **Step B1**：MCP send_message schema 加 `await?: 'none' | 'first_message' | 'turn_complete' | 'idle'`（default `'turn_complete'`） + `timeout_ms?: number`（default 60000）+ `idle_quiet_ms?: number`（default 5000）
- [ ] **Step B2**：send_message handler 内：enqueue 后注册 agent-event listener，按 `await` 模式 collect + setTimeout，到点 resolve `{ messageId, sentAt, awaited, events: collected, timedOut, reason }`
- [ ] **Step B3**：caller 改造：所有 `wait_reply` 调用点改成 `send_message({await: ...})` 一步式；agent body / SKILL body 同步改
- [ ] **Step B4**：删 `wait_reply` tool 注册 + handler + `wait-reply-coordinator.ts` 整文件 + tests
- [ ] **Step B5**：删 `coordinator.ts:167-168` 的 baseline_ts race 防御（已废弃整文件，跳过；记录决策"为什么不需要"到 CHANGELOG）
- [ ] **Step B6**：HTTP / stdio transport 同款支持新 send_message schema；HTTP keep-alive 测试长 await（5min）能否撑住
- [ ] **Step B7**：typecheck + 跑 mcp tests + 实测 SKILL 流程

### Phase C：TeamDetail 重写（方案 2）

> ⚠️ Step C1 在 2026-05-13 摸盘后取消：task-repo 已有 `list({teamId, limit})` API 直接可用；IPC `IpcInvoke.TaskListByTeam` 已存在；preload `window.api.listTeamTasks(teamId)` 已存在；`onTaskChanged` 事件订阅已存在；`team-task-created/completed` AgentEvent 已写 events 表（聚合事件流可消费）。**直接用现有 API**，无需新 API。

- [x] **~~Step C1~~**：~~task-repo 加 `listByTeamId` 查询~~ — 已有 `list({teamId})`，跳过
- [ ] **Step C2**：主进程加 IPC `agent-deck-team:get-full(teamId): TeamFullSnapshot`，单 query 拼 5 sections 数据（tasks 字段调 `taskRepo.list({teamId, limit:200})`）
- [ ] **Step C3**：preload `window.api.getAgentDeckTeamFull(teamId)` facade
- [ ] **Step C4**：TeamDetail/index.tsx 重写：
  - Header：team name + memberCount + lifecycle + 团队级操作按钮
  - SpawnLineageTree 子组件：用 spawnedBy 拼树，每 node mini SessionCard
  - AggregatedEventStream 子组件：跨成员事件流时间轴（含 `team-task-created/completed` AgentEvent 让 task 操作也显示在事件流），左侧色条区分成员
  - TeamTasks 子组件：按 status group 列 tasks（消费已存在的 `listTeamTasks` + `onTaskChanged`）
  - CrossAdapterMessages 子组件：保留已有 universal-message-watcher 流量
- [ ] **Step C5**：增量 patch：subscribe 5 类事件 + 各自 reducer，避免整 snapshot 重拉
- [ ] **Step C6**：单文件 LOC 护栏（≤500 行）：TeamDetail/index.tsx 拆成多个 sub-component，每个 ≤300 行
- [ ] **Step C7**：实测 dev 模式下打开 TeamDetail 看 5 sections 都有内容（teammate 跑 review 时事件流刷新 / spawn 时 lineage 树更新 / mcp_tasks_create 时 task 列表更新）

### Phase D：PendingTab teammate 上下文（方案 4）

- [ ] **Step D1**：PendingTab 拉 pending list 后用 `findActiveMembershipsBySessionIds(ids[])` batch 反查
- [ ] **Step D2**：PendingRow 渲染：有 active membership 时加 chip "🛡 `<teamName>` · 👑 lead | ↳ teammate · `<session.title>`"
- [ ] **Step D3**：subscribe `onAgentDeckTeamChanged` 增量刷新（teammate join/leave 时 chip 更新）
- [ ] **Step D4**：实测 spawn reviewer-claude/codex 后 PendingTab 看 reviewer 的 Bash 审批带团队 + teammate chip

### Phase F：团队清理机制（方案 5 / 设计决策 D6+D7）

- [ ] **Step F1**：在 `agentDeckTeamRepo` 加 `setMemberLeftAt(teamId, sessionId, leftAt)` API（如已有同款则跳过；确认 members 表有 `left_at` 列）
- [ ] **Step F2**：在 `sessionManager.close(sid)` / `markClosed(sid)` 内 emit `session-upserted` 后加 D6 自动 leave 循环
- [ ] **Step F3**：确认 sessions DELETE 时 members 表外键级联（`ON DELETE CASCADE`？）；如无在 `sessionRepo.delete(sid)` 内手工 `agentDeckTeamRepo.deleteAllMembershipsBySession(sid)`
- [ ] **Step F4**：实现 `TeamLifecycleScheduler`（参考 `LifecycleScheduler` 模式）：默认 5 分钟周期，扫 `archivedAt=NULL` 的 team，所有 active member 全 closed/archived ≥ N 分钟（grace period 默认 30 分钟） → 自动归档 team + emit `agent-deck-team-changed`
- [ ] **Step F5**：scheduler 周期 / grace period 加 settings 配置项（`teamArchiveSchedulerIntervalMs` / `teamArchiveGracePeriodMs`），settings UI 可调
- [ ] **Step F6**：加 IPC `agent-deck-team:shutdown-all-teammates(teamId)` —— 批量 `sessionManager.close(memberSid)` 仅 teammate role；返回 `{ closed: sid[], failed: { sid, error }[] }` 不一刀切失败
- [ ] **Step F7**：加 IPC `agent-deck-team:archive-team(teamId)` —— 手动归档（不级联 close member）
- [ ] **Step F8**：TeamDetail Header 暴露两个按钮（"shutdown all teammates" / "archive team"），二级确认对话框
- [ ] **Step F9**：实测 spawn 一个 team → close lead → 30 分钟后 scheduler 自动归档 + UI 刷新；实测一键 shutdown all teammates 触发 close 链路

### Phase E：归档

- [ ] **Step E1**：写 CHANGELOG_78 / 79 / 80（按主题分文件，A/B 一份，C/D 一份，F 一份）
- [ ] **Step E2**：写 REVIEW（如果 Step 0 异构对抗有 finding 落地）
- [ ] **Step E3**：plan frontmatter status: completed → mv 到 main repo `plans/team-cohesion-fix-20260513.md` + 更新 `plans/INDEX.md`
- [ ] **Step E4**：worktree branch 合回 main → exit worktree (keep) + git worktree remove

## 当前进度

- 已进 worktree `/Users/apple/Repository/personal/agent-deck/.claude/worktrees/team-cohesion-fix-20260513`
- **Phase A 全部完成**（commit `b5ae047`）：
  - A1 grep team_name 调用点（5 类清单已落「已知踩坑」节）
  - A2 `SessionTeamMembership` type + `findActiveMembershipsBySessionIds` 批量 API（chunk 500 防超 IN 上限）
  - A3 SessionRecord 加 `teams[]` + 删 `teamName`
  - A4 sessionRepo.toSessionRecord 不产 teamName（纯 row 投影）
  - A5 sessionManager.enrichWithTeams + enrichWithTeamsBatch + notifyTeamMembershipChanged
  - A6 桥点统一 enrich (main/index.ts:222) + IPC SessionGet/SessionListHistory
  - A7 MCP projectSession 消费 enriched teams[]
  - A8 删 setTeamName / recordCreatedTeamName / distinctTeamNames / findByTeamName / clearTeamName + 调用点切走
  - A9 v014 migration（backfill ensureByName + addMember + drop column） + sessionRepo Row/INSERT/UPDATE/rename SQL 全删 team_name 引用
  - A10 SessionCard 读 teams[0]?.teamName + 多 team +N badge + hover 完整列表
  - A11 mcp tests 全部更新 + 通过
  - bug fix: spawn_session addMember 后立即 notify 让 lead/teammate 立即 enrich
- **Phase B 主干完成**（commit `b5ae047` 含 B1-B6）：
  - B1 v015 migration: messages 表加 reply_to_message_id + idx_messages_reply_to + AgentDeckMessage type + repo `findRepliesByMessageId` + Insert/Enqueue 透传
  - B2 send_message schema 加 reply_to_message_id 入参 + handler 透传
  - B3 reply_message tool（语法糖：自动算 to / team + 安全校验 caller == 原 toSessionId）
  - B4 wait_reply 重写（query messages 表 + listener + 可选 nudge_text 催）
  - B6 删 wait-reply-coordinator.ts + tests + 老 import 清理
  - tests: 42 全过
- **Phase B5 方案 A 完成**（commit `7b92e21`）：
  - SDK streaming 协议要求首条 user message 启动 CLI，无法"无 prompt 起 session shell" → 退回方案 A
  - spawn_session handler 内 enqueueMessageRepo.insert(placeholder) + markDelivered（不重复投递）
  - spawn_session 返回值新增 `spawnPromptMessageId` 让 lead 拿来 wait_reply 等 teammate first reply
  - test mock agentDeckMessageRepo.insert/markDelivered + Phase B5 case 验证
  - tests: 43 全过
- **Phase B7 wire format messageId 注入 + Phase B5 SKILL doc 更新完成**（本次 session）：
  - 实现层：messageRepo.insert 加可选 `id` / spawn handler 先 gen id 拼 `[msg <uuid>]\n` prompt prefix → createSession → insert 用预先 id（DB body 不含 prefix） / buildWireBody 加 `[msg <uuid>]` 让 send_message 路径 wire body 也带 id
  - 注释同步：universal-message-watcher 头注释 / agent-deck-team.ts:106 / adapters/types.ts:237
  - mcp tests +2 case：`Phase B5+B7` 验证 wire prefix + UUID 正确生成 + DB body 不含 prefix；`Phase B7: spawn without team_name skips wire prefix`；`Phase B7: spawn with agent_name + team_name`（45 tests 全过）
  - SKILL.md：description 改 7 tool / Step 1-2/4/5 全部 wait_reply 切 message_id schema / 加「§对话锚点 messageId + wire format」节 / 失败兜底表更新（wait_reply default 600_000 / 投递 failed 描述 / lead 重启后 stranded reviewer）
  - reviewer-claude.md：加 §核心纪律 第 9 条「reply 必须用 reply_message + 顶部 regex 提 [msg <id>]」/ 反模式表 +2 条 / 失败兜底里 reply_message 提示 / 「teammate 模式硬约束」段重写
  - reviewer-codex.md：加 §核心纪律 第 12 条同款（codex 失败模板也必须走 reply_message）/ 反模式表 +2 条 / 「teammate 模式硬约束」段重写
  - resources/claude-config/CLAUDE.md：「Agent Deck Universal Team Backend」节 since_ts buffer 段整段重写 → wait_reply by message_id / spawnPromptMessageId / wire format teammate 约束
  - typecheck + 45 mcp tests 全过
- typecheck 全过、45 mcp tests 全过、worktree 内 main repo `git status` clean（只有 worktree branch）
- **Phase D PendingTab teammate chip 完成**（commit `572f714`）：
  - PendingSection header 加 🛡 teamName chip（紫色，与 SessionCard 同款）+ 👑 lead / ↳ teammate role badge（蓝色）
  - 数据流走 session.teams[0]（Phase A 的 enrichWithTeams 在 main/index.ts:225 桥点已自动 inject），PendingTab 通过 `useSessionStore.sessions` 自动反应 team membership 变化（spawn / addMember / leaveTeam → notifyTeamMembershipChanged → emit session-upserted → 桥点 enrich → store update → renderer 重渲染），不需要新 IPC / 不需要 onAgentDeckTeamChanged listener
  - role 算法：`session.teams[0]?.role`（universal team backend 投影），不复用 SessionList 的 spawnedBy visibility 判定（PendingTab 平铺无 tree context）
  - typecheck 全过；renderer 改动走 HMR 无需重启 dev
- **Phase C TeamDetail 重写完成**（commit `5c93b7e`）：把 TeamDetail 从「最小可用」补成「团队工作面板」
  - Backend：`event-repo.findTeamEvents(teamId)` 重写改用 universal team backend listActiveMembers → events.session_id IN (...) 查询（v014 已 drop sessions.team_name 必修）；新 IPC `AgentDeckTeamGetFull` → 4 sections snapshot（team / members / recentEvents 50 / tasks / recentMessages 100）
  - Renderer 拆 8 文件（TeamDetail/ 目录，均 ≤200 行）：index.tsx 主组件 + Header.tsx 头/Section/EmptyState 容器 + helpers.ts 纯函数 + 6 sections（Members / Lineage / Pending / Events / Tasks / Messages）
  - 6 sections 顺序：Members → Lineage → Pending → Events → Tasks → Messages（按用户「打开 team 想知道什么」次序排）
  - lineage / pending 不入 IPC，由 renderer 从 sessions Map.spawnedBy / store pendingXBySession 自拼（避免重复 SQL + 与 PendingTab 一致）
  - 增量刷新走 onAgentDeckTeamChanged + onAgentDeckMessageChanged 触发整 refetch（main 端 16ms debounce 已限频）；events / tasks / pending 实时性通过 store reactive
  - typecheck + 45 mcp tests 全过；renderer 改动走 HMR 无需重启 dev
- **Phase F 团队级生命周期清理完成**（commit `bb13b32`）：D6 被动 + D7 主动
  - D6 被动清理：sessionManager.close + markClosed 加 `_leaveAllActiveTeams` helper（与 delete 路径同款逻辑：listActiveMemberships → leaveTeam + emit team-member-changed + 0-lead 自动 archive team + emit team-updated；reactivate 路径**不**自动 rejoin team，让用户手工 spawn 新 team）
  - D7 主动清理 - TeamLifecycleScheduler：5min 周期 + 30min grace。扫所有 active team → 检查每个 team 的 active member → 全 closed 且距最近 close ≥ grace → 自动 archive；0-active-member 立即 archive；与 LifecycleScheduler 独立运行（一个管 sessions，一个管 agent_deck_teams）
  - D7 手动批量 - IPC `AgentDeckTeamShutdownAllTeammates`：批量 close 仅 teammate role（lead 不动），串行 close 避免 race，失败收集到 failed[] 不一刀切失败；close 内部已 D6 leaveTeam
  - D7 UI - TeamDetail Header actions 槽加按钮：「关闭 N 个 teammate」（confirmDialog → shutdownAllTeammates）+「归档」（confirmDialog → archiveAgentDeckTeam）；archived team 时隐藏按钮；actionBusy 互斥防双击
  - typecheck + 45 mcp tests 全过；renderer 改动走 HMR

## 未完成 / 已知尾巴

- **未实测**：v014 migration 是否能正常 upgrade 历史 DB（用户原 sessions.team_name 数据未测试 backfill）；新 wait_reply + Phase B7 wire format 在真实 agent-deck-message-watcher 投递路径下的 race 行为；reviewer-* teammate 实际是否能从 wire format 提 messageId 调 reply_message（需 dev 实测一轮 teammate review）；Phase D PendingTab chip 在多 team / spawn / leave / archive 各状态下渲染是否正确；Phase C TeamDetail 6 sections 在 team 实际数据下是否合理；Phase F D6 close 路径触发 / D7 scheduler 5min 周期 + 30min grace 是否符合预期 / shutdown-all-teammates 失败 / archive 后 reactivate 路径
- **未走对抗 review**：D1-D7 设计决策 + B7 wire format + Phase C TeamDetail snapshot+section 拆法 + Phase F D6/D7 团队清理（含 leaveTeam grace / 0-lead archive 边界 / shutdown-all 串行 race）按 CLAUDE.md 强约束应走但用户当前 round 选了"先不做对抗" — 实施前对抗未做。建议下次专门做一轮双对抗 review

## 下一会话第一步

**前置必做**（cold start 步骤）：

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/team-cohesion-fix-20260513.md` 全文（**严禁 Read 工具**，详 ~/.claude/CLAUDE.md 「Step 3 接力姿势 cold start callout」）
2. `EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/team-cohesion-fix-20260513")` 进同一 worktree
3. `git log --oneline -5` 确认 HEAD 是 Phase B7 commit 或之后；`ls /Users/apple/Repository/personal/agent-deck/.claude/worktrees/team-cohesion-fix-20260513/node_modules` 确认 symlink 在（如不在执行 `ln -sf /Users/apple/Repository/personal/agent-deck/node_modules /Users/apple/Repository/personal/agent-deck/.claude/worktrees/team-cohesion-fix-20260513/node_modules`）
4. 跑 `zsh -i -l -c "pnpm typecheck && pnpm exec vitest run src/main/agent-deck-mcp/"` 自检 typecheck 通 + 45 tests 全过

**然后用户选下一步推进方向**（建议 ask 用户）：

- **(1) dev 实测 Phase A + B + B7 + D + C + F 全套**（强烈推荐，全部代码已落地未实测）：
  - kill dev: `lsof -ti:47821,5173 2>/dev/null | xargs -r kill -9; pkill -f "electron-vite dev" 2>/dev/null; pkill -f "Electron.app/Contents/MacOS/Electron" 2>/dev/null`
  - 起 dev: `cd <worktree-abs-path> && zsh -i -l -c "pnpm dev"`（worktree 内跑避免影响主仓库 dev）
  - 实测 1 (Phase A)：spawn 一个 team → SessionList 看 lead 显示 🛡 chip + 👑 lead badge + teammate 显示 ↳ teammate
  - 实测 2 (Phase B7)：跑 deep-code-review SKILL 一轮 → 验证 reviewer-* teammate 真能从 wire format 提 messageId 调 reply_message → lead wait_reply 在 timeout 前正常 resolve
  - 实测 3 (Phase B7 invariant)：messages 表查 placeholder body 是原始 promptToUse（不含 prefix），universal-message-watcher 投递 body / spawn createSession prompt 含 prefix
  - 实测 4 (Phase D)：让 teammate / lead 各触发 permission，验证 PendingTab header 🛡 + role badge；多 team 共享场景验证 +N badge + hover
  - 实测 5 (Phase C)：打开 team 看 6 sections 全貌；team 内成员触发 events / 创建 task / 互发 message 验证刷新；spawn 链路 lineage 树形是否正确
  - 实测 6 (Phase F D6)：close 一个 lead session → 看 0-lead 自动 archive team；close 一个 teammate → 看 leave + emit
  - 实测 7 (Phase F D7 scheduler)：构造一个全 closed team 等 30min 看 scheduler 自动 archive；或临时调 graceMs=10s 加速验证
  - 实测 8 (Phase F D7 manual)：TeamDetail Header 点「关闭 N 个 teammate」按钮 → 验证 lead 不动、teammate 全 close、team 自动 archive；点「归档」按钮 → 验证 archive 后按钮消失
  - **关键测试 v014 migration**：用户已有数据库（带 sessions.team_name 数据）能否 backfill 成功 + drop column 不挂

- **(2) 双对抗 review B7 + Phase C + Phase F 改动**（CLAUDE.md 强约束补做）：
  - 范围：所有本 plan 实施的代码（agent-deck-mcp/tools.ts spawn handler / universal-message-watcher.ts buildWireBody / agent-deck-message-repo.ts insert / event-repo.ts findTeamEvents / ipc/teams.ts AgentDeckTeamGetFull + ShutdownAllTeammates / session/manager.ts D6 helper / teams/team-lifecycle-scheduler.ts / TeamDetail/ 8 文件 + 4 doc）
  - focus：B7 wire format 跨 adapter 误解析 / spawn external caller 路径 / DB body invariant / reviewer regex false-match；Phase C lineage / pending 自拼算法在 multi-team / orphan / archived 各状态；Phase F D6 helper 在 close + markClosed + delete 三入口 idempotent / D7 scheduler 5min/30min 阈值 / shutdown-all-teammates 串行 race / 0-lead archive 边界
  - 实施路径：deep-code-review SKILL teammate 模式（reviewer-claude + reviewer-codex 同时起，跨轮持久化）

- **(3) plan 完成归档**（按 CLAUDE.md「Step 4 完成分支」）：worktree branch 合回 main → frontmatter 置 status: completed → plan 文件挪到 `<main-repo>/plans/` → 同步 `plans/INDEX.md` → 关联 `changelog/CHANGELOG_<X>.md` 引用 4 commit → ExitWorktree(action: keep) → git worktree remove + branch -D

**注意路径陷阱**：进 worktree 后所有指向**代码资产**的路径必须含 `.claude/worktrees/team-cohesion-fix-20260513/` 前缀（按 ~/.claude/CLAUDE.md「Step 1 worktree」节末段路径陷阱条款）。plan 文件本身路径不变（`/Users/apple/Repository/personal/agent-deck/.claude/plans/team-cohesion-fix-20260513.md`，主仓库 .claude/plans/ 下，**不**在 worktree 内）。

## 已知踩坑

### Step A1 grep 结果（2026-05-13 初次盘点）

> 范围 `src/**/*.ts*`（含测试），关键字 `team_name|teamName|setTeamName|recordCreatedTeamName|distinctTeamNames|findByTeamName|clearTeamName`。worktree 下跑命令、相对路径以仓库根为锚。

#### 写路径（必删 / 必改）

1. **`src/main/store/session-repo.ts`** — sessions.team_name 列的全部读写：
   - line 26: `Row.team_name: string | null` 类型字段（v012 drop column 后改 Row 接口）
   - line 48: `toSessionRecord.teamName: r.team_name ?? null` —— 改为 enrich-at-higher-level（不在 repo 层投影 teamName）
   - line 91-93, 103-104, 115, 135: upsert 的 INSERT / UPDATE SQL 均含 team_name 列 + `team_name: rec.teamName ?? null` —— v012 后 SQL 删该列、入参不再读 teamName
   - line 242-243: `setTeamName(id, teamName)` API —— 删
   - line 283-298: `clearTeamName(teamName): string[]` API —— 删
   - line 302-306: `distinctTeamNames(): string[]` API —— 删
   - line 310-313: `findByTeamName(teamName): SessionRecord[]` API —— 删
   - line 324-389: `renameRow` 内 team_name 列迁移 SQL（含 `fromRow.team_name`）—— v012 后删
   - line 348 注释 "v006 加 team_name 时多算占位" —— 历史教训保留作 v012 注释参考

2. **`src/main/session/manager.ts:440-447`** — `recordCreatedTeamName(sid, teamName)`：删 API；改成 IPC / MCP handler 内 `agentDeckTeamRepo.ensureByName + addMember(role: 'lead' or 'teammate')` 路径

3. **`src/main/store/event-repo.ts:62-71`** — `findTeamEvents(teamName)` 用 `s.team_name = ?` JOIN sessions：v012 后该 SQL 会挂；改成走 universal team backend `findActiveMembershipsByTeamId(teamId)` 拿 sessionIds 后 `s.id IN (...)` 查询；API 签名同步改 `findTeamEvents(teamId)` 或加重载

4. **`src/main/agent-deck-mcp/tools.ts`**:
   - line 159-172: `projectSession` fallback `s.teamName ?? null` —— D2.5 数据回填后无遗留，删 fallback 行；teamName 字段保留向后兼容（取 `teams[0]?.name`），新增 `teams: rec.teams` 完整数组字段
   - line 411-413 含 `// 兼容老 sessions.team_name 列` 注释 + `sessionManager.recordCreatedTeamName(sid, args.team_name)` 调用 —— 删（recordCreatedTeamName 已删）
   - line 56, 615, 664: tool description 字符串里 "teamName" —— 加 teams 字段后更新描述（list_sessions / get_session）
   - line 192, 386-388, 425, 469: `args.team_name`（spawn schema 入参）—— **不删**，是创建/加入 team 的入口

5. **`src/main/ipc/adapters.ts:131-187`**:
   - `parseTeamName(raw.teamName)` 仍接受（向后兼容 CLI 入参 `agent-deck new --team-name`）
   - `sessionManager.recordCreatedTeamName(sid, teamName)` 调用（line 187）—— 改成走 `agentDeckTeamRepo.ensureByName + addMember(sid, role: 'teammate')`（IPC 入口创建的 session 不能确定 lead，按 teammate 加入；如需 lead 走 spawn_session MCP tool）

6. **`src/main/ipc/_helpers.ts:171-180`** — `parseTeamName(value)` zod 校验：保留（仍接受 raw IPC 入参做 64-char + 字符集校验），返回值由调用方传给 universal team backend

7. **`src/main/store/migrations/`**:
   - `v006_sessions_team_name.sql` —— **保留**（migrations append-only，老 DB 升级路径需要）
   - 新增 `v012_drop_sessions_team_name.sql` —— 含 D2.5 backfill UPSERT + ALTER TABLE DROP COLUMN

8. **`src/shared/types/session.ts:46`** — `SessionRecord.teamName?: string | null`：删，改 `teams?: Array<{id, name, role: 'lead'|'teammate', joinedAt: number, leftAt: null}>`

#### 适配层（保留字段、行为切走）

9. **`src/main/adapters/types.ts:33-38`** + **`src/main/adapters/claude-code/index.ts:66`** + **`src/main/adapters/claude-code/sdk-bridge/index.ts:183-186, 303-310, 362-412`** + **`src/main/adapters/claude-code/sdk-bridge/recoverer.ts:49`**:
   - `CreateSessionOptions.teamName?: string` 字段 —— **保留**（spawn 入口接受 teamName 表示"创建/加入这个 team"）
   - 但 adapter 内部不再调 `recordCreatedTeamName` 写 sessions 列；改成在 sessionManager / IPC handler 层 addMember 到 universal team backend
   - sdk-bridge 内 `teamIdProvider` (line 309-310 注释指出 R3.E8 已迁移) —— 保持现状，task-manager 已走 tasks.team_id 路径不依赖 sessions.team_name

10. **`src/main/task-manager/server.ts:6-11, 35-39`** + **`src/main/task-manager/tools.ts`** + **`src/main/store/task-repo.ts`** + **`src/shared/types/task.ts`** + **`src/main/task-manager/__tests__/tools.test.ts`** + **`src/main/store/__tests__/task-repo.test.ts`**:
   - tasks.team_name 是 **task 表自己的列**，与 sessions.team_name 同名同义但**独立** —— 本 plan **不动 tasks.team_name**（task-repo 改造是另一工程）
   - 唯一关联：`task-manager/server.ts:9` 注释 "原 teamNameProvider 走 sessions.team_name (v006 deprecated)" —— 注释更新（删 deprecated 字眼说"已 v012 删除"），不动逻辑

#### 渲染层（必改）

11. **`src/renderer/components/SessionCard.tsx:95-100`** — 紫色 chip 渲染 `session.teamName`：改成读 `session.teams[0]?.name`，title hover 弹完整 team 列表 + 角色

12. **`src/renderer/components/SessionCard.tsx:19`** — `🛡 teamName chip` 注释 —— 与代码同步更新措辞

13. **`src/renderer/components/TeamHub.tsx:10`** — 注释提到 "老 SQL distinctTeamNames 全废" —— 实际仍未全废（mcp/tools.ts 还有 fallback，本 plan 删完后注释才完全成立）；TeamHub 主体逻辑走 `listAgentDeckTeams`（universal team backend），无需改

#### 不动（明确排除）

- **`src/renderer/components/activity-feed/describe.ts:91-92`** — Agent Teams CLI builtin tool 解析 args.team_name —— 是 CLI 入参字段，与 sessions.team_name 列无关
- **`src/main/adapters/claude-code/hook-routes.ts:55`** — 注释已说明 hook 不写 team_name —— 无需改
- **`src/main/store/__tests__/agent-deck-repos.test.ts:25`** — `import v006 from '../migrations/v006_sessions_team_name.sql?raw'` —— migrations append-only，v006 保留
- **`src/shared/types/settings.ts:154-155`** — closure 注入 team_name 注释，描述 task 不是 session —— 不动
- 一切 `src/main/task-manager/**` 与 `src/main/store/__tests__/task-repo.test.ts` / `src/main/task-manager/__tests__/tools.test.ts` 内的 `teamName` —— 都是 task 自己的字段，不在本 plan 范围

#### 测试（必改）

- **`src/main/agent-deck-mcp/__tests__/tools.test.ts`** — line 67, 69-73, 86, 98-100, 113, 176, 195, 288, 438-445, 657-672, 740-805 多处 mock SessionRecord `teamName` 字段 + `recordCreatedTeamName` mock + `falls back to sessions.team_name` 测试 —— 改成新 `teams: []` 数组 schema；删 `falls back to sessions.team_name` 测试（v012 后无 fallback）
- **`src/main/agent-deck-mcp/__tests__/spawn-guards.test.ts:67`** — mock `teamName: null` —— 改新 schema

## 关联

- 本 plan 起源：用户报"spawn_session 注入有问题，lead 还是没有团队标，团队页面内容很少（事件流 / task 都没），wait_reply 实现很怪 + 应该 send_message 直接拿 reply（用户原话）"
- 相关 changelog：CHANGELOG_76（spawn_session agent_name 注入 + projectSession 反查 D3 修一半）/ CHANGELOG_77（SessionList 树形折叠 + lead/teammate badge）
- 相关 plan：`/Users/apple/Repository/personal/agent-deck/plans/deep-review-flow-fix-20260512.md`（已 completed，本 plan 是其 Phase B/C 遗漏的下半场）
