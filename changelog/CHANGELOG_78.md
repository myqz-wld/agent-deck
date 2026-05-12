# CHANGELOG_78: 团队凝聚力修复 6 Phase 全（plan team-cohesion-fix-20260513）

## 概要

本 plan 把「团队」概念在数据 / UI / MCP / 生命周期清理 5 层贯通：消除 `sessions.team_name` 双源、把 TeamDetail 从「最小可用」补成「团队工作面板」、把 `wait_reply` 退役为按 `message_id` 查 reply 的简化模型 + Phase B7 wire format 注入 messageId 让 teammate 真能调 `reply_message`、PendingTab 显式带出 team + role 上下文、补齐团队级生命周期清理（D6 close 自动 leaveTeam + D7 TeamLifecycleScheduler 5min 周期 + 30min grace + 手动 ShutdownAllTeammates）。

详细设计与 6 Phase 实施过程见 plan：[`plans/team-cohesion-fix-20260513.md`](../plans/team-cohesion-fix-20260513.md)（status: completed，含 D1-D7 设计决策 / 5 类已知踩坑清单 / 当前进度 / 6 commit hash）。

## 变更内容

### Phase A — 数据层统一 (commit `b5ae047`)

`SessionRecord.teams[]` 数组替代单值 `teamName`；`sessions.team_name` 列 v014 migration drop（带 ensureByName + addMember backfill）；`sessionRepo.toSessionRecord` 不再产 teamName（纯 row 投影），`sessionManager.enrichWithTeams` + `enrichWithTeamsBatch` 在 IPC 桥点统一注入；MCP `projectSession` 消费 enriched teams[]；删 `setTeamName / recordCreatedTeamName / distinctTeamNames / findByTeamName / clearTeamName` 5 个老 API；SessionCard 紫色 chip 走 `teams[0]?.teamName` + 多 team `+N` badge + hover 完整列表。

### Phase B — send_message 内嵌 wait + 三 tool (commit `b5ae047` / `7b92e21` / `1e4de25`)

- B1 v015 migration: `messages.reply_to_message_id` + idx + `findRepliesByMessageId` + Insert/Enqueue 透传
- B2 `send_message` schema 加 `reply_to_message_id` 入参 + handler 透传
- B3 `reply_message` tool（语法糖：自动算 to_session_id / team_id from 原 msg + 安全校验 caller == 原 toSessionId）
- B4 `wait_reply` 重写为按 `message_id` query messages 表 + universal-message-watcher event listener + 可选 `nudge_text` 催（不再依赖 since_ts buffer）
- B5 方案 A: spawn handler enqueue placeholder message + markDelivered + 返回值 `spawnPromptMessageId` 让 lead 拿来 `wait_reply({message_id})` 等 teammate first reply
- B6 删 `wait-reply-coordinator.ts` + tests + 老 import 清理
- B7 wire format 注入 messageId（Phase B 真实链路 gap 修复）：
  - `messageRepo.insert` 加可选 `id` 参数
  - `universal-message-watcher.buildWireBody` 改 `[from <displayName> @ <adapterId>][msg <uuid>]\n<原始 body>` 让 teammate 能从 prompt 顶部 regex 提 messageId 调 `reply_message`
  - spawn handler 重排：`callerExists` 提前算 + `willCreatePlaceholder` → 先 gen `placeholderId` → 拼 `[msg <id>]\n` 到 `promptForSpawn` → `createSession` → `messageRepo.insert({id: placeholderId, body: 原始 promptToUse})`（DB body 不含 prefix invariant 保留）
  - mcp tests +2 case 覆盖 wire format / spawn prompt prefix（45 tests 全过）
  - doc 同步：SKILL.md 描述 7 tool 编排 + wait_reply 切 `message_id` + 「§对话锚点 messageId + wire format」节；reviewer-claude.md / reviewer-codex.md 加新 §核心纪律 「reply 必须用 reply_message + 顶部 regex 提 [msg <id>]」+ 反模式表 +2 条；resources/claude-config/CLAUDE.md「Agent Deck Universal Team Backend」节 since_ts buffer 段整段重写

### Phase C — TeamDetail 重写「团队工作面板」 (commit `5c93b7e`)

- Backend: `event-repo.findTeamEvents(teamId)` 重写改用 universal team backend listActiveMembers → `events.session_id IN (...)` 查询（v014 已 drop sessions.team_name 必修）；新 IPC `AgentDeckTeamGetFull` → 4 sections snapshot（team / members / recentEvents 50 / tasks / recentMessages 100）
- Renderer 拆 8 文件（`src/renderer/components/TeamDetail/` 目录，均 ≤200 行）：`index.tsx` 主组件 + `Header.tsx` 头/Section/EmptyState 容器 + `helpers.ts` 纯函数 + 6 sections（`Members` / `Lineage` / `Pending` / `Events` / `Tasks` / `Messages`）
- 6 sections 顺序：Members → Lineage → Pending → Events → Tasks → Messages（按用户「打开 team 想知道什么」次序排）
- lineage / pending 不入 IPC，由 renderer 从 `sessions Map.spawnedBy` / store `pendingXBySession` 自拼（避免重复 SQL + 与 PendingTab 一致）
- 增量刷新走 `onAgentDeckTeamChanged` + `onAgentDeckMessageChanged` 触发整 refetch（main 端 16ms debounce 已限频）

### Phase D — PendingTab teammate chip + role badge (commit `572f714`)

`PendingSection` header 加 🛡 teamName chip（紫色，与 SessionCard 同款）+ 👑 lead / ↳ teammate role badge（蓝色）。数据流走 `session.teams[0]`（Phase A 已 enrich），不需要新 IPC / 不需要 `onAgentDeckTeamChanged` listener（store 通过 session-upserted 桥点自动同步）。

### Phase F — 团队级生命周期清理 D6 + D7 (commit `bb13b32`)

**D6 被动**：`sessionManager.close + markClosed` 加 `_leaveAllActiveTeams` helper（与 delete 路径同款逻辑：`listActiveMemberships → leaveTeam + emit team-member-changed + 0-lead 自动 archive team + emit team-updated`；reactivate 路径**不**自动 rejoin team，让用户手工 spawn 新 team）。

**D7 主动**：
- 新 `TeamLifecycleScheduler`（`src/main/teams/team-lifecycle-scheduler.ts`）：5min 周期 + 30min grace。扫所有 active team → 检查每个 team 的 active member → 全 closed 且距最近 close ≥ grace → 自动 archive；0-active-member 立即 archive；与 LifecycleScheduler 独立运行（一个管 sessions，一个管 agent_deck_teams）
- 单例 facade（`setTeamLifecycleScheduler / getTeamLifecycleScheduler`）+ `main/index.ts` 启动 + before-quit stop
- 新 IPC `AgentDeckTeamShutdownAllTeammates`：批量 close 仅 teammate role（lead 不动），串行避免 race，失败 collect 到 `failed[]` 不一刀切失败；close 内部已 D6 leaveTeam
- preload `shutdownAllTeammates` API
- TeamDetail Header actions 槽加按钮：「关闭 N 个 teammate」+「归档」（confirmDialog 兜底，actionBusy 互斥防双击）

## 备注

- 关联 plan：[`plans/team-cohesion-fix-20260513.md`](../plans/team-cohesion-fix-20260513.md)（status: completed）
- 6 commits：`b5ae047` (A+B baseline) / `7b92e21` (B5) / `1e4de25` (B7+B5 doc) / `572f714` (D) / `5c93b7e` (C) / `bb13b32` (F)
- typecheck + 45 mcp tests 全过
- **未实测**（plan §未完成 / 已知尾巴）：v014 migration backfill / B7 wire format 真实 agent-deck-message-watcher 投递路径 race / reviewer-* 端到端 reply_message / Phase D PendingTab chip 多 team 状态 / Phase C TeamDetail 6 sections 真数据合理性 / Phase F D7 scheduler 5min/30min 阈值 + shutdown-all-teammates / archive 后 reactivate
- **未走对抗 review**（plan §未完成 / 已知尾巴）：D1-D7 设计决策 + B7 wire format（跨 adapter 接口 + DB invariant）+ Phase C TeamDetail snapshot+section 拆法 + Phase F D6/D7 团队清理边界。按 CLAUDE.md「决策对抗」强约束应走，本 plan 用户 round 1 选「先不做对抗」直推实施 — 建议下次专门做一轮双对抗 review