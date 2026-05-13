# CHANGELOG_80 — bug 修：lead 归档→team auto-archive 联动 + REVIEW_32 R1 fix 8 条

> **范围**：plan deep-review-and-split-20260513 Phase 1 全产出（H1）。包含原 bug 修复 + REVIEW_32 R1 异构对抗 reviewer 找出的 6 条 HIGH + 1 条双方一致 MED + 1 条用户加的 schema UX HIGH，共 9 条修复落地。
>
> 详细 review finding / 三态裁决推理 / 验证手段 → [`reviews/REVIEW_32.md`](../reviews/REVIEW_32.md)。

## 概要

用户主诉的 bug「lead 被归档后，团队依然存在可见」根源是**两层语义错位**：
- DB 层：`countActiveLeads(teamId)` 只查 `agent_deck_team_members.role='lead' AND left_at IS NULL`，**不联动 sessions.archived_at**
- service 层：`manager.archive(sessionId)` 只 `setArchived(archived_at=now)`，**不调用 _leaveAllActiveTeams**（archived 与 lifecycle 正交，lead session 仍在 team membership 里）

修后联动：lead session 归档 → countActiveLeads 自动返 0 → manager.archive 调 `_archiveTeamsIfOrphaned` 直接 archive team；反向 unarchive(sid) → 调 `_unarchiveTeamsForRevivedLead` 复活之前因 lead-archived 自动归档的 team（**只复活 archive_reason='last-lead-archived'**，不影响用户主动归档 / scheduler 归档）。

跑完 bug fix 后走 deep-code-review SKILL（一对 reviewer-claude + reviewer-codex teammate 异构对抗），R1 双方各自挖出 9+7=16 条独立 finding。本会话挑 6 条 HIGH + 1 条 MED + 1 条用户加 + 1 条用户加共 9 条修复落地，剩余 7 条（4 MED 单方独有 + 3 LOW/INFO + 1 future feature）写入 REVIEW_32 标 follow-up。

## 变更内容

### bug 修：lead 归档→team auto-archive 联动（plan 主线）
- `src/main/store/agent-deck-team-repo.ts:516-531` — `countActiveLeads` SQL 加 `INNER JOIN sessions s ON m.session_id = s.id WHERE s.archived_at IS NULL`
- `src/main/session/manager.ts:411-433` — `archive(sessionId)` / `unarchive(sessionId)` 由 sync 改 async
- `src/main/session/manager.ts:519-595` — 新增 `_archiveTeamsIfOrphaned` / `_unarchiveTeamsForRevivedLead` 两个 helper（lazy import 模式与 `_leaveAllActiveTeams` 一致）
- caller 同步改 await：`src/main/ipc/sessions.ts:34-41`、`src/main/adapters/claude-code/sdk-bridge/recoverer.ts:141`、`src/main/session/__tests__/manager-public-api.test.ts:43-89`

### REVIEW_32 R1 HIGH 1 — spawn placeholder markDelivered no-op SQL
- `src/main/store/agent-deck-message-repo.ts:335-353` — `markDelivered` SQL 由 `WHERE status='delivering'` 改为 `WHERE status IN ('pending','delivering')`，spawn 路径 placeholder（status='pending'）能正确 mark 为 delivered，universal-message-watcher 250ms poll 不再二次投递（teammate 跑完首条 prompt 后立刻又收到一份 wireBody 的生产 bug 闭环）
- `src/main/agent-deck-mcp/__tests__/tools.test.ts:304-313` — mock 同步加 status 校验对齐生产 SQL（避免 REVIEW_31 Bug 1+2 同款 mock 漂移盲区）

### REVIEW_32 R1 HIGH 2 — findSharedActiveTeams 不 JOIN archived → archived team 仍可发消息
- `src/main/store/agent-deck-team-repo.ts:502-523` — JOIN `agent_deck_teams t` + `sessions sa/sb` 三表，过滤 `t.archived_at IS NULL AND sa/sb.archived_at IS NULL`。修后 `last-lead-archived` / 用户主动归档的 team 不再让 send_message 误判 "common active team" → universal-message-watcher 不再 dispatch 给隐藏 teammate

### REVIEW_32 R1 HIGH 3 — wait_reply nudge 自循环匹配
- `src/main/agent-deck-mcp/tools.ts:794-814, 836-848` — wait_reply 加 `isLegitReply` 方向校验：`reply.fromSessionId === original.toSessionId && reply.toSessionId === original.fromSessionId` 才算合法 reply。修后 nudge enqueue（fromSessionId=caller, replyToMessageId=args.message_id）不会被 caller 自己的 wait_reply 当成 reply 假成功

### REVIEW_32 R1 HIGH 4 — spawn_session 返回缺 agentName / displayName（用户加）
- `src/main/agent-deck-mcp/tools.ts:582-587` — return shape 加 `agentName: args.agent_name ?? null`、`displayName: teammateDisplayName`。caller 不再需要 `list_sessions` / `get_session` 反查多组并发 review 时哪个 teammate 是哪个 agent 名

### REVIEW_32 R1 HIGH 5 — spawn_session 不继承 lead 的 permission/sandbox（用户加 + reviewer-codex 旁证）
- `src/main/agent-deck-mcp/tools.ts:230-247` — schema 加 `claude_code_sandbox` 字段；3 字段统一描述「不传时从 lead 继承」语义
- `src/main/agent-deck-mcp/tools.ts:441-455, 463-481` — `effectivePermissionMode` / `effectiveCodexSandbox` / `effectiveClaudeCodeSandbox` = caller 显式 > lead 继承 > undefined。`createSession` 用 effective 字段，`recordCreatedPermissionMode` 也用 effective
- 解决 R1 reviewer-codex 自承「外层 Claude Code sandbox 拦了 codex in-process app-server 初始化（Operation not permitted），首轮 codex 退出 0 但 OUT 为空」根因（spawn 出的 codex teammate 没继承 lead 的 sandbox 设置）

### REVIEW_32 R1 HIGH 6 — setRole otherLeads 不 JOIN sessions 与 countActiveLeads 不一致（双方一致 MED）
- `src/main/store/agent-deck-team-repo.ts:557-571` — `setRole` 内的 demote-last-lead invariant 校验 SQL 与 `countActiveLeads` 同款 INNER JOIN sessions + archived_at IS NULL。修前 archived lead 被算作有效 lead 兜底 → 把唯一 active lead 降级 → team 进入 0 active lead 死状态（demote 走 setRole 不调 archive 联动 + scheduler D7 不识别 archived_at）

### REVIEW_32 R1 MED 7 — _unarchiveTeamsForRevivedLead 不区分 archive 来源（双方一致）
- 新增 `src/main/store/migrations/v016_agent_deck_teams_archive_reason.sql` —— `agent_deck_teams` 加 `archive_reason TEXT` 列
- `src/main/store/migrations/index.ts` —— 注册 v016
- `src/shared/types/agent-deck-team.ts` — 新增 `AgentDeckTeamArchiveReason` union 类型（5 值）+ `AgentDeckTeam.archiveReason` 字段
- `src/main/store/agent-deck-team-repo.ts:55-104, 320-353` — `archive(teamId, opts)` 持久化 reason（默认 `'user-action'`），`unarchive` 同时清 `archive_reason`，`teamRowToRecord` 投影 archiveReason
- `src/main/session/manager.ts:561-595` — `_unarchiveTeamsForRevivedLead` 加 `if (team.archiveReason !== 'last-lead-archived') continue` 过滤，只复活本会话 archive 联动写下的 team
- `src/main/ipc/teams.ts:138, 208` — 旧 reason 字符串 `'user-archive'` / `'last-lead-removed'` 改对齐新 union（`'user-action'` / `'last-lead-deleted'`）
- `src/main/teams/team-lifecycle-scheduler.ts:109-114` — `_archiveTeam` 统一记 `'scheduler'`，原 detail 改走 console.log

### REVIEW_32 R1 HIGH 9 — caller_session_id 改 optional（用户加）
- `src/main/agent-deck-mcp/tools.ts:48-63` — `makeCallerContext` 接受 `string | null | undefined`，缺省视为 `'__external__'`
- `src/main/agent-deck-mcp/tools.ts:373-381` — `deriveCaller` 签名改 `caller_session_id?: string`
- `src/main/agent-deck-mcp/tools.ts` 7 处 schema — `caller_session_id` 全改 `.optional()` + 加 describe 说明 in-process / external transport 语义差异
- in-process transport 不再要求 caller 传任意 string，HTTP / stdio external 必须显式传（不传 → 拒需要真实 session 上下文的 tool）

## 验证

- `pnpm typecheck`（双端）✅
- 未跑 dev 完整冒烟（worktree 缺 better-sqlite3 ABI 与 Electron 版本兼容，仅 typecheck 验证；待 H5 完整 smoke 验证 archive→archive_reason→unarchive 反向链路）
- 9 条 fix 全程跑过中间 typecheck，未引入 regression

## 后续

REVIEW_32 还剩 7 条 follow-up（4 MED 单方独有 + 3 LOW/INFO + 1 future feature add），详见 `reviews/REVIEW_32.md` §Follow-up 节。优先级最高的是：
- MED 单方：fan-out slot release 早 / D7 scheduler 不识别 archived_at / spawn placeholder enqueue 失败 / send_message reply_to_message_id 跨 team 污染 / 首次 archive 事件吞 — 留 H1.5 / Phase 2 拆 tools.ts 时一起改
- HIGH 10（用户加 future feature）：reply/send message 在对应会话 SessionDetail 特殊渲染区分（UI 层改动，需调研 renderer 端 wire format prefix 是否已展示）
- 反复踩坑候选：「调 SKILL / 工具前先做不必要的 SSOT discovery」（Claude reasoning 浪费模式）写 `conventions/tally.md`
