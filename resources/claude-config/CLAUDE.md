<!--
此文件由仓库 `resources/claude-config/CLAUDE.md` 打包注入到每个 SDK 会话的 system prompt 末尾。
不要手动改打包后版本；改 `resources/claude-config/CLAUDE.md` + 应用 build。
本文件**只放 agent-deck 应用专属差异**；通用约定全部由 `~/.claude/CLAUDE.md` 提供（CLI 已按 user → project → 这份顺序加载，user 内容已先入 system prompt，不再复制）。
维护说明详 `resources/claude-config/README.md`。
-->

--- Agent Deck 应用环境约定（随应用打包注入到每个 SDK 会话）---

# 应用环境约定

> **通用约定**（输出 / 运行时 / 决策对抗 / 复杂 plan / 工程地基 / 模板）见 `~/.claude/CLAUDE.md` —— CLI 加载顺序（user → project → app）保证已先入本会话 system prompt。本文件只补 agent-deck 应用专属差异，不再复制 user CLAUDE.md 任何内容。
>
> **保证范围**：仅对 `settingSources: ['user','project','local']` 的交互式应用 SDK 会话保证 user CLAUDE.md 已加载（如应用内 ComposerSdk 起的会话）。`settingSources: []` 的内部 oneshot（如间歇总结 SDK 调用）**不**依赖 user CLAUDE.md 通用约定，需要时由调用方自行注入最小规则。

## 应用环境差异（Δ user CLAUDE.md）

### 协议覆盖：teammate 协作走 mcp tool

本应用环境（agent-deck）teammate 协作走 mcp tool（详 §Agent Deck Universal Team Backend 节）。user CLAUDE.md 历史的 §Agent Teams 节描述的 in-process inbox 协议**不适用**本环境。

### reviewer-codex 失败 → 应用环境额外有「合规兜底」分支

应用环境跑 `deep-code-review` SKILL 时若 reviewer-codex teammate 失败（CLI 不可用 / OAuth 过期 / Bash 卡审批被拒 / timeout），可走「合规兜底（仍异构）」：lead 自己 Bash `run_in_background: true` 起外部 codex CLI（按 reviewer-codex.md §codex CLI 调用模板填模板，lead 自己执行而非 wrapper teammate），与 reviewer-claude teammate 仍构成 gpt-5.5 vs Opus 4.7 异构对。

> 通用 CLAUDE.md `§reviewer-codex 失败兜底` 只走「严禁同源化降级 / 提示用户决策」一条；本应用环境额外有上述 SKILL 内合规兜底分支。详 SKILL.md `§失败兜底` 表第 1 行。

---

## Agent Deck Universal Team Backend

跨 adapter 协作通过 Agent Deck MCP 10 tool（`mcp__agent_deck__spawn_session` / `send_message` / `reply_message` / `wait_reply` / `check_reply` / `list_sessions` / `get_session` / `shutdown_session` / `archive_plan` / `start_next_session`）编排。teammate 调工具时走自己 SDK 会话的 canUseTool，**lead 不插手 teammate 权限审批**（失败弹给真人走 teammate 自己 session 的 PendingTab）。

### 三个核心约定（lead 角度）

1. **spawn 首轮锚点**：`spawn_session` 返回 `spawnPromptMessageId: string | null`（仅当传 `team_name` 且 caller 在 sessions 表时非空），是首轮 prompt 在 messages 表的 placeholder id。lead 用它调 `wait_reply({message_id: spawnPromptMessageId})` 等首轮 reply
2. **后续轮次锚点**：`send_message` 返回 `{ sessionId, teamId, messageId, replyToMessageId, sentAt, queued: true }`。lead 用 `messageId` 调 `wait_reply({message_id})` 等后续 reply
3. **shutdown 不删数据**：`shutdown_session` 只标 lifecycle='closed' + abort SDK live query；events / file_changes / summaries / messages 子表保留，lead 在裁决报告里仍可引用

### wait_reply 按 messageId（非事件流轮询）

```ts
const reply = await mcp__agent_deck__wait_reply({
  message_id: <spawnPromptMessageId 或 send 返回的 messageId>,
  timeout_ms: 600_000,             // 默认 600_000ms (10min)，hard cap 1_800_000ms (30min)；重 review 给足
  // 可选：nudge_text + nudge_after_ms 让 mcp 自动催 reply
  caller_session_id: callerSid,
});
// reply = { reply: { messageId, text, sentAt, fromSessionId } | null, nudgesSent, timedOut }
```

按 messageId 反查 `messages` 表的 `reply_to_message_id`（DB query + universal-message-watcher event listener，listener 注册前先查一次防 race）。

### Wire format / regex / DB invariant

teammate 端协议约束（regex 提 messageId / 用 reply_message 回 / DB messages.body 不含 wire prefix 的 invariant）已强约束在 reviewer-{claude,codex}.md「核心纪律」节，**lead 不需关心**这些细节。完整 wire format 协议规范见仓库 `docs/agent-deck-mcp-protocol.md`（应用 backend 开发者文档）。

### 跨会话救火：list_sessions(spawned_by_filter)

lead context 重置 / 重启后捡 stranded reviewer：`list_sessions(spawned_by_filter:'<old_lead_sid>', status_filter:'active')` 拉自己以前 spawn 的 active reviewer；按 sessionId 调 `send_message` 发新 prompt → 用返回的 `messageId` 调 `wait_reply` 等本轮 reply（旧 spawn 的 `spawnPromptMessageId` 已不在 lead context，用本轮 send 的 messageId 起新对话锚点）；收尾走 `shutdown_session`。

### check_reply 非阻塞 poll

`wait_reply` 阻塞 lead 等期间不能从 user 收新 message；想保留处理其他 user input 能力时改用 `check_reply({message_id})`：立即返回 `{ reply: ... | null, timedOut: false }`（`timedOut` 永远 false，字段保留是为与 wait_reply 同形）。lead 自己控 poll 节奏。

### plan hand-off 自动化：archive_plan

完成 `~/.claude/CLAUDE.md` 的「复杂 plan：worktree 隔离 + 跨会话 hand off」流程的 §Step 4 cleanup 一次调用代替 5 步 Bash：

```ts
const result = await mcp__agent_deck__archive_plan({
  plan_id: '<plan-id>',                      // 与 worktree 目录名 / plan 文件 stem 一致
  worktree_path: '<absolute-worktree-path>', // /Users/.../repo/.claude/worktrees/<plan-id>
  base_branch: 'main',                       // 默认 'main'
  // plan_file_path: '<override>'            // 默认按 <main-repo>/.claude/plans/<id>.md → ~/.claude/plans/<id>.md fallback
});
// result = { archived_path, commit_hash, branch_deleted, worktree_removed, plans_index_appended, final_status: 'completed' }
```

tool 自动跑 14 步：rev-parse main repo / 解 worktree branch / 预检 (worktree clean / cwd 不在 worktree 内 / plan status ≠ completed / 非 detached HEAD) / ff merge worktree branch → base_branch / 更新 plan frontmatter (status=completed + final_commit + completed_at) / mv plan 到 `<main-repo>/plans/<plan-id>.md` / 同步 `plans/INDEX.md` (不存在创建 / 已存在 append 防重复) / 删原 plan / git add + commit / git worktree remove + branch -D。

任一预检失败立即返回 error 短路。**lead agent 必须先 ExitWorktree** 让 cwd 出 worktree 再调本 tool（mcp 不能调 ExitWorktree CLI 内部 tool；cwd 在 worktree 内时 tool 直接 reject 提示 ExitWorktree）。

### plan hand-off 自动化：start_next_session

完成 `~/.claude/CLAUDE.md` 的「复杂 plan：worktree 隔离 + 跨会话 hand off」流程的 §Step 3 接力姿势 §选项 B（K2 自动起新 SDK session 接力下一 phase，免去用户手动新开会话 + 复制 cold start prompt）：

```ts
const result = await mcp__agent_deck__start_next_session({
  plan_id: '<plan-id>',                      // 必填，与 plan 文件 stem / worktree 目录名一致
  phase_label: 'H3 Phase 4b',                // 可选，附加到 cold start prompt 后缀「（Phase: <label>）」
  // 其他字段 cwd / adapter / team_name / permission_mode / plan_file_path 默认即可
  // CHANGELOG_97: team_name 默认不传（baton 单向交接不强加 lead/teammate 关系）
});
// result = {
//   planId, planFilePath, worktreePath, baseBranch, phaseLabel, initialPrompt,
//   sessionId, adapter, cwd, teamId (默认 null), teamName (默认 null),
//   spawnDepth, sentAt, spawnPromptMessageId (默认 null)
// }
```

tool 自动跑：解析 plan 文件路径（caller cwd 反查 main-repo → `<main-repo>/.claude/plans/<plan-id>.md` / fallback `~/.claude/plans/<plan-id>.md`） / 读 plan frontmatter 拿 `worktree_path` + `base_branch` / 校验 status === `in_progress` / 构造 cold start prompt = `按 <plan-abs-path> 接力`（含 phase_label 时附 `（Phase: <label>）` 后缀） / 调 `spawn_session` 起新 SDK session（cwd = worktree_path 默认 / 默认 adapter `claude-code`） / **CHANGELOG_97 baton 语义**：default 不加任何 team（caller 不被打 lead 标签 / 新 session 不被打 teammate 标签；显式传 `team_name` 才启用通信关系）+ default 自动归档 caller session（baton 完整交出原会话退出，归档失败仅 warn 不阻塞 ok return）。

任一预检失败（plan 文件不存在 / status ≠ in_progress / frontmatter 缺 worktree_path / spawn 失败）立即返回 error 短路。**新 session system prompt 必须含 user CLAUDE.md「复杂 plan」节**（settingSources 包含 `'user'` 即可，应用内 SDK 会话默认满足）—— 否则新 session 看 cold start prompt 不知道是什么意思。
