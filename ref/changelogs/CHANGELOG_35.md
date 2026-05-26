# CHANGELOG_35: Agent Teams 接入 M1（基础设施 + 创建入口）

## 概要

为 Claude Code 实验特性 [Agent Teams](https://code.claude.com/docs/en/agent-teams)（CLI ≥ v2.1.32）打底：sessions 表加 `team_name` 列、AdapterCapabilities 加 `canJoinTeam`、AppSettings 加 `agentTeamsEnabled` 总开关、sdk-bridge 在 spawn 时按需注入 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`、NewSessionDialog / SessionCard / SettingsDialog 三处 UI 收口。**默认 OFF**——与现有「孤岛聚合器」产品形态共存，开启后用户可在创建 SDK 会话时填 team 名启用 Claude 内部的 agent teams 实验特性。

M1 仅打通「启用 + 标记 + UI 入口」，team 内 fs 视图（M2）+ 新 hook 事件接入（M3）见后续 changelog；完整设计 plan 见 `plans/agent-deck-task-humming-gray.md`（用户本地）。

## 变更内容

### 数据层 (`src/main/store/`)

- `migrations/v006_sessions_team_name.sql`（新）：`ALTER TABLE sessions ADD COLUMN team_name TEXT` + 部分索引 `idx_sessions_team_name WHERE team_name IS NOT NULL`（不浪费空间，绝大多数会话 NULL）
- `migrations/index.ts`：注册 v006
- `session-repo.ts`：`Row` / `rowToRecord` / `upsert` / `rename` 全部带上 team_name 字段（注释强化「INSERT + UPDATE 都要带，否则 spread 会静默丢字段」原则）；新增 `setTeamName / distinctTeamNames / findByTeamName` 三个 helper（M2 Team Hub 会用）

### 共享类型 (`src/shared/types.ts`)

- `SessionRecord` 加 `teamName?: string | null`；CLI 通道恒为 NULL，SDK 通道按用户在 dialog 输入持久化
- `AppSettings` 加 `agentTeamsEnabled: boolean`，`DEFAULT_SETTINGS.agentTeamsEnabled = false`

### Adapter 层 (`src/main/adapters/`)

- `types.ts`：`AdapterCapabilities` 加 `canJoinTeam: boolean`；`CreateSessionOptions` 加 `teamName?: string`
- `claude-code/index.ts`：`canJoinTeam: true`，createSession 透传 teamName 到 sdk-bridge
- `codex-cli/index.ts` / `aider/index.ts` / `generic-pty/index.ts`：`canJoinTeam: false`，UI 选中时自动隐藏 team 入口
- `claude-code/sdk-bridge.ts`：
  - createSession opts 接 `teamName?: string`
  - resume 路径同传 teamName 直接 throw（Anthropic 官方明确「Agent Teams 不支持 session resumption」）
  - query env 拼装：`settingsStore.get('agentTeamsEnabled') && opts.teamName?.trim()` 时追加 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1'`，沿用既有 per-query env 透传模式（与 `AGENT_DECK_ORIGIN: 'sdk'` 同模式），summarizer 自己 query() 调用不读 teamName 天然不被污染

### IPC / Session 层

- `src/main/ipc.ts`：新增 `parseTeamName` helper（同 parsePermissionMode 模式：optional string、长度 ≤ 64、`/^[A-Za-z0-9._-]+$/`）；`AdapterCreateSession` handler 解析 + 透传 teamName + 创建后调 `sessionManager.recordCreatedTeamName`
- `src/main/session/manager.ts`：加 `recordCreatedTeamName(sid, teamName)`，与 `recordCreatedPermissionMode` 同模式（空白等价不写、写完 emit upsert）

### Renderer (`src/renderer/`)

- `components/NewSessionDialog.tsx`：
  - AdapterInfo 接口加 `canJoinTeam`
  - 新增 `teamName` state + `agentTeamsEnabled` 异步从 settings 拉
  - **双条件显示**：`agentTeamsEnabled === true && selectedAdapter.capabilities.canJoinTeam` 才暴露 team 输入框
  - 输入框下面带提示模板 `Create an agent team named X with roles A/B/C`，明确告诉用户必须在首条消息里告诉 Claude 用这个名字（teamName 不会作为 SDK options 直接传给 Claude）
  - 前端预校验团队名格式 + 长度，与 main 端 parseTeamName 同步
- `components/SessionCard.tsx`：title 行 sdk/cli chip 后加紫色 `🛡 <teamName>` chip（≤ 6rem 截断 + tooltip 显示全名）
- `components/SettingsDialog.tsx`：实验功能 Section 新增 agentTeamsEnabled toggle + 文案（说明限制、版本要求、关闭只影响下次新建）

## 备注

- **summarizer 不被污染**已验证：`summarizer.ts` 的 SDK oneshot 走自己的 query() 调用，env 只展开 `runtime.env`，不读 teamName / agentTeamsEnabled，team env 注入 100% 隔离在 sdk-bridge.createSession 的 query() options 里
- **toggle 关闭后已有 team 会话不受影响**：env 是 spawn 时一次性传入，CLI 子进程已按 team 模式启动，不会被撤销（与 `injectAgentDeckClaudeMd` 同模式）
- **resume 限制**双道防线：
  1. 主进程 sdk-bridge.createSession 入口直接 throw（IPC 路径短路）
  2. 渲染层后续可在 SessionDetail 加 `session.teamName != null && lifecycle ∈ {dormant, closed}` 时 disable Composer + tooltip（M3 范围内补完）
- **关联**：M2（fs 监听 + Team Hub 视图） + M3（接 TeammateIdle / TaskCreated / TaskCompleted hook）见后续 CHANGELOG

## 后续修复（事后追加）

- **session-repo.ts rename INSERT placeholder 多算 1 个**：本 changelog 加 team_name 列时，rename 的 `INSERT INTO sessions` 语句列名是 13 个但 VALUES 写了 14 个 `?`。typecheck / build / 普通新建会话 upsert 都不触发；**SDK fallback rename / CLI 隐式 fork（first realId !== opts.resume）**走到这条 INSERT 时 better-sqlite3 抛 `SqliteError: 14 values for 13 columns`，整个 query loop 挂掉，sessionId rename 失败 → 用户体感「会话莫名丢失 / 历史断层」。修法：删掉多余的 1 个 `?`。教训：改 INSERT 语句加列时**列名 / placeholder / .run() 参数三处必须 1:1 对齐**，加列前后数一遍可以避坑（typecheck 拦不到 SQL placeholder 数量错误）
