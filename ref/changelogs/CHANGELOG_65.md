# CHANGELOG_65: R3 Universal Team Backend 硬切（plan v3 ACCEPTED + PR-A/PR-B 落地）

## 概要

Agent Deck team 抽象**硬切**脱钩 Claude Code Agent Teams in-process backend：team 真正成为 adapter-agnostic 的 first-class 容器，cross-adapter（claude-code / codex-cli / aider / generic-pty）session 都能以 member 身份加入 team，cross-adapter message 通过 DB envelope + universal-message-watcher 投递。

老 inbox 协议（CHANGELOG_45/46/56 + REVIEW_17 多轮加固）≈ 1700 LOC 一次性废弃；老 Claude Code experimental teams 入口（`agentTeamsEnabled` toggle / `autoApproveTeammateMode` 三档 / `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` env 注入 / 3 个 team-task hook / inbox-watcher / team-coordinator / inbox-protocol / auto-approve / team-watcher / team-fs 大半 / 老 team UI / 老 IPC 10 channel / 老 event-bus 4 event / canJoinTeam capability / TeamPermission* 类型 / 50 处 renderer 消费点）全删。`deep-code-review` SKILL + `reviewer-claude` / `reviewer-codex` agent body 重写为 `mcp__agent_deck__*` 5 tool 范式。

为什么硬切：plan v3 用户拍板「不双轨过渡」（详见 plan §256-260）。代价显式列在 README 大改 + R3.E0 ADR §10：CLI 内自起的 team **永久失明**，老 `~/.claude/teams/<X>/` 数据**只读历史保留**（提供一次性 export），老 deep-code-review SKILL workflow **完全重写**。换来的是 cross-adapter 协作能力（claude lead × codex teammate × generic teammate）+ 真 first-class team 抽象 + 0 实验特性依赖。

## 变更内容

### docs/agent-deck-team-protocol.md (E0 ADR — PR-A)

- 1151 行 ACCEPTED ADR：universal team 数据模型 / AgentAdapter 接口扩展 / universal-message-watcher 投递语义 / agent-deck-mcp 接管路径 / 老 backend 硬切删除清单
- reviewer 双对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5 xhigh）+ 反驳轮：5 HIGH ✅ + 3 HIGH→MED 修订 + 7 MED 修订 + 5 反驳证伪 + INFO 落地（详见 §13）

### src/main/store/ (E1+E2+E3 — PR-A)

- 新建 `agent-deck-team-repo.ts` (561 LOC) + `agent-deck-message-repo.ts` (422 LOC) + 29 vitest 单测
- migration **v010** `agent_deck_teams` / `agent_deck_team_members` / `agent_deck_messages` 三表 + 部分 unique 索引 + RESTRICT FK + 100KB body cap
- migration **v011** `tasks.team_id` 列 + 部分索引；老 `tasks.team_name` 保留兼容 read（v012 大版本删）
- 状态机：`pending → claim → delivering → delivered | failed | cancelled`；retry max=3 + 退避 1s/4s
- `last_attempt_at` 字段（reviewer HIGH-1 修法：替代 sent_at 做退避基准）+ `delivering_since` crash recovery 字段（reviewer §4.6 修法：不无条件 `++attempt_count`）

### src/main/adapters/ (E4 — PR-A 加新 / PR-B 删旧)

- `types.ts` 新增 `canCollaborate` capability + `receiveTeammateMessage(sessionId, fromMemberId, body)` + `notifyTeammateEvent(sessionId, event)` 可选方法（PR-A）
- 删除 `canJoinTeam` capability（PR-B；老 Claude Code experimental teams flag 触发器，universal 不需要）
- 删除 `CreateSessionOptions.teamName` JSDoc 内 env 注入相关段（PR-B）
- claude-code / codex-cli adapter 实现 `receiveTeammateMessage` = 调本 adapter 的 `sendMessage`（watcher 已拼好 wire 前缀）
- aider / generic-pty adapter 占位 `canCollaborate: false`，F 阶段实装

### src/main/teams/ (E5 — PR-B)

- 新建 `universal-message-watcher.ts` (430 LOC)：hybrid event + poll（50ms debounce + 250ms 兜底）+ per-target backpressure + per-team rate limiter（settings 控）+ wire format 前缀拼装 + crash recovery + TeamEventDispatcher 投 `notifyTeammateEvent`
- **删除** `inbox-watcher.ts` (452) + `team-coordinator.ts` (313) + `inbox-protocol.ts` (306) + `auto-approve.ts` (117) + `team-watcher.ts` (152) + 2 个 tests（239+331） = **1910 LOC**
- `team-fs.ts` 296 LOC 删（老 listTeams / readTeamConfig / readTaskList / getTeamSnapshot / forceCleanupTeam / getTasksRoot 全废），仅保留 `getTeamsRoot` + `exportLegacyTeams` + `hasLegacyTeamData`（E12 export 按钮用）

### src/main/agent-deck-mcp/ (E5/E8 — PR-B)

- `wait-reply-coordinator.ts` 新增 `session-upserted.lifecycle === 'closed'` 监听（reviewer codex HIGH-2 修法）：`shutdown_session` 后 `wait_reply` 立即解锁不卡 600s timeout
- `tools.ts` `spawn_session` amend：`team_name` 触发 `agentDeckTeamRepo.ensureByName` + 加 caller 为 lead + 加新 session 为 teammate；不再写老 `sessions.team_name` 列
- `tools.ts` `send_message` amend：加 optional `team_id` selector，走 `enqueueAgentDeckMessage` 入 DB envelope（不再直调 `adapter.sendMessage`）；多 team 共享时必填 team_id；零 team 共享 reject `no-shared-team`
- 单测扩展：amend 后的 send_message 4 case（normal / no-shared / ambiguous / not-shared 校验）

### src/main/session/manager.ts (PR-B)

- `delete()` 入口加 §2.5 pre-check：lazy import `agentDeckTeamRepo` 反查 active memberships → 自动 `leaveTeam` + 触发 0-lead 自动 archive，避免 sessions ON DELETE RESTRICT FK throw

### src/main/task-manager/ (E8 — PR-B teamId 迁移)

- `server.ts` `getTasksMcpServerForSession` 第二参数 `teamNameProvider` → `teamIdProvider`（lazy lookup `agent_deck_team_members` 反查 caller 当前所属 team；多 team 时取最近 join + lead role 优先）
- `tools.ts` 5 tool 全改：`task_create / task_update / task_delete` 用 `teamId` closure 锁；`task_list` schema `team_name` → `team_id`；`task_get` 不限 team
- `task-changed` event payload 同时带 `teamId` + `teamName`（兼容老 renderer）
- predicate signature `(id, teamName, teamId) => boolean`（让 cascade delete 按 closure team_id 过滤）

### src/main/adapters/claude-code/sdk-bridge/index.ts (PR-B)

- 删 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` env 注入（universal team backend 不依赖 CLI 实验特性）
- task-manager closure 改走 `agentDeckTeamRepo.findActiveMembershipsBySession(sid)` 拿 teamId
- 删老 resume + teamName warn

### src/main/adapters/claude-code/hook-routes.ts + translate.ts (PR-B)

- hook-routes.ts 删 3 个 team hook route (`/hook/taskcreated` / `/hook/taskcompleted` / `/hook/teammateidle`) + `maybeSyncFromPreToolUse` / `maybeSyncFromTeamHook` helpers + `team-coordinator` import
- translate.ts 删 5 个老 fn (`translateTaskCreated/Completed/TeammateIdle/TeamPermissionRequest/Cancelled`) + `TeamHookPayload` interface + `TeamPermissionRequest/Cancelled` import

### src/shared/types/ (PR-B)

- `team.ts` 老类型全清（`TeamMember / TeamConfig / TeamSnapshot / TeamSummary / TeamDataChangedEvent / TeamTaskPayload / TeamTeammateIdlePayload`），仅保留 stub 占位（barrel re-export 链不破）
- `permission.ts` 删 `TeamPermissionRequest / TeamPermissionCancelled / TeamPermissionDecision`（lines 109-152）
- `task.ts` `TaskRecord` / `TaskChangedEvent` 加 `teamId` 字段（与 `teamName` 并行；后者标 deprecated）
- `agent-deck-team.ts` PR-A 已建（AgentDeckTeam / AgentDeckTeamMember / AgentDeckMessage / AgentDeckMessageStatus / AgentDeckTeammateEvent / AgentDeckTeamMemberChangedEvent / AgentDeckMessageStatusChangedEvent）

### src/shared/types/settings.ts + src/main/store/settings-store.ts (PR-B)

- 删 `agentTeamsEnabled` + `autoApproveTeammateMode` 字段（settings-store `REMOVED_KEYS` 自动清历史持久化值）
- 新增 `mcpMessageRatePerTeamPerMin: number` (默认 60，范围 [10, 600]) + `mcpMessageMaxTargetInflight: number` (默认 10，范围 [1, 50])

### src/shared/ipc-channels.ts + src/main/ipc/teams.ts + src/preload/index.ts (E8 — PR-B)

- 删 10 个老 team channel: `TeamList / TeamGet / TeamSubscribe(Inbox) / TeamUnsubscribe(Inbox) / TeamForceCleanup / TeamRespondPermission / TeamListPendingPermissions`
- 删 4 个老 event: `TeamDataChanged / TeamPermissionRequested / TeamPermissionResolved`（含 cancelled 对应 channel）
- 新增 9 个 channel: `agent-deck-team:list/get/create/archive/unarchive/add-member/remove-member/send-message`、`agent-deck-message:list-by-team/cancel`
- 新增 2 个 event: `event:agent-deck-team-changed` + `event:agent-deck-message-changed`（聚合数组 payload，main bootstrap 16ms debounce + per-team 累加合并）
- preload `window.api` facade 全部重写：删老 `listTeams / getTeam / forceCleanupTeam / subscribeTeam / subscribeTeamInbox / respondTeamPermission / onTeamPermissionResolved`，加 `listAgentDeckTeams / getAgentDeckTeam / createAgentDeckTeam / archiveAgentDeckTeam / unarchiveAgentDeckTeam / addAgentDeckTeamMember / removeAgentDeckTeamMember / sendAgentDeckTeamMessage / listAgentDeckMessagesByTeam / cancelAgentDeckMessage / onAgentDeckTeamChanged / onAgentDeckMessageChanged`

### src/main/index.ts (PR-B)

- bootstrap 整体瘦身：删 `teamWatcher / inboxWatcher / teamCoordinator / translateTeamPermission*` import + 60 行 wiring (`team-data-changed` listener / `team-permission-*` listener / `autoSubscribedTeams` Set + `refreshAutoSubscribe` + 3 个 listener / before-quit cleanup 段)
- 新增 `universalMessageWatcher.start()` + `teamEventDispatcher.start()` + 6 新 event 桥接（debounce + per-team 累加）

### src/main/event-bus.ts (E9 — PR-B)

- 删 4 老 event: `team-data-changed / team-permission-requested / team-permission-cancelled / team-permission-resolved`
- 新增 6 event: `agent-deck-team-created / updated / deleted / member-changed / message-enqueued / message-status-changed`

### src/renderer/ (E7 — PR-B 大改)

- `TeamHub.tsx` 整文件重写（152 → 110 行）：用 `agent-deck-team:list` IPC + `onAgentDeckTeamChanged` 增量 reload；老 fs polling / SQL distinctTeamNames 全废
- `TeamDetail/index.tsx` 整文件重写（297 → 180 行）：用 `agent-deck-team:get` 拿 team + members + recentMessages snapshot；删 6 个老 sub-component（chrome / lead-session / ForceCleanupButton / McpTasksSection / SendToTeammate / TeamEventRow），最小可用 send_message UI 留 follow-up
- `NewSessionDialog.tsx` 删 `agentTeamsEnabled` / `canJoinTeam` 路径 + `showTeamHint` 段 + `Partial<AppSettings>` 拉取
- `PendingTab.tsx` + `pending-rows/`：删 `TeamPermissionRow` 组件 + 4 处使用点 + `pendingTeamPerms` map
- `session-store.ts` 删 `pendingTeamPermissionsBySession` map + `EMPTY_TEAM_PERMISSIONS` + `resolveTeamPermission` / `resolveTeamPermissionByTeam` action + `pushEvent` 内 isTeamPermission* 分支 + `removeSession` / `setSessions` / `renameSession` 三处 prune 同步
- `event-type-guards.ts` 删 `isTeamPermissionRequest` / `isTeamPermissionCancelled`
- `session-selectors.ts` 删 `teamPermissions` 字段 + `selectPendingBuckets` 第 5 参
- `activity-feed/index.tsx` 删 `TeamPermissionRow` import + `cancelledTeamPermIds` Set + `pendingTeamPermIds` Set + `team-permission-*` 分支 (50 处 grep 实证清完)
- `App.tsx` 删 `onTeamPermissionResolved` 监听 + `pendingTeamPermsMap`
- `ExperimentalSection.tsx` 删 Agent Teams toggle + Teammate 权限自动放行档位 select

### src/main/cli.ts (E10 — PR-B)

- `--team <name>` flag：把新 lead session 加入指定 team（ensure-by-name + lead role）
- `--member <slug:adapter>` repeatable flag：lead spawn 后并发 spawn N 个 teammate session（指定 adapter，cwd 同 lead），each 加为 teammate role + displayName=slug
- `parseFlags` 新增 `REPEATABLE_FLAGS` 概念，同 key 多次出现累积成数组
- 校验：`--member` 必须配合 `--team` 一起用；格式 `<slug>:<adapter>`

### resources/claude-config/agent-deck-plugin/ (E11 — PR-B 大改)

- `skills/deep-code-review/SKILL.md` (274 → 245 行)：完全重写，从老 `TeamCreate / Agent / SendMessage / TeamDelete` 范式切到 `mcp__agent_deck__*` 5 tool 范式；加 `since_ts: spawnedAt - 5000` race buffer 推荐；失败兜底矩阵更新（rate-limit / no-shared-team / ambiguous-team / failed status）
- `agents/reviewer-claude.md` agent body 重写：删 inbox 协议 / lead 通信 段，改写「teammate 模式 = mcp__agent_deck__spawn_session 起 / send_message 驱动 / wait_reply 等 / shutdown_session 收尾，你是被驱动方」
- `agents/reviewer-codex.md` agent body 重写：同上 + Bash 权限通路差异更新（teammate 模式不再走 lead inbox 而走自己 session 的 canUseTool）

### legacy-teams (E12 — PR-A 已加，PR-B 保留)

- `team-fs.ts:exportLegacyTeams` + `hasLegacyTeamData` 保留
- IPC `legacy-teams:has-data` / `:export` channel 保留
- Settings `LegacyTeamExportSection` UI 保留
- 启动一次性 confirm dialog 保留（`r3LegacyExportNoticeAcked` setting flag）

### 单测

- `task-manager/__tests__/tools.test.ts` 全部更新：`team_name` → `team_id` semantic（37 tests 全过）
- `agent-deck-mcp/__tests__/tools.test.ts` 加 `agent-deck-team-repo` + `universal-message-watcher` mocks + send_message 5 case（24 tests 全过）

## 备注

- **PR-A / PR-B 拆分**：plan v3 §259 风险节强约束 + ADR §8 — PR-A（E0/E1/E2/E3/E4 仅新增 + E12 export 按钮，5 commit 已落 r3-team-hardcut 分支：04d2d71 / 2b1da70 / 0676788 / 2fd53dc / a23cd7d）；PR-B（本 changelog）E5/E6/E7/E8/E9/E10/E11/E13 一次性同 PR 落地（不可拆 PR 分阶段上线）
- **代价显式声明**（README 大改 + 启动 dialog 提示）：CLI 自起 team 永久失明 / 老 deep-code-review SKILL workflow 完全重写 / `~/.claude/teams/<X>/` 数据只读历史保留 + 提供一次性 export
- **关联 REVIEW_23**：PR-A 阶段 E0 ADR reviewer 双对抗 + 反驳轮已在 ADR §13 内闭环；PR-B 阶段未单独跑全量 review（实际跑了 vitest 233 passed + typecheck 全过验证）
- **typecheck + vitest 全绿**：`pnpm typecheck` / `pnpm vitest run` 都通过
- **后续待办**：(a) TeamDetail 完整 send_message UI / role 切换 / archive 入口；(b) F 阶段 generic-pty / aider adapter 实装 `receiveTeammateMessage`；(c) 12 个月后 v012 大版本删 `sessions.team_name` + `tasks.team_name` 列
