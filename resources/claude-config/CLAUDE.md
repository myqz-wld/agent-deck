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

跨 adapter 协作通过 Agent Deck MCP 7 tool（`mcp__agent_deck__spawn_session` / `send_message` / `reply_message` / `wait_reply` / `list_sessions` / `get_session` / `shutdown_session`）编排。teammate 调工具时走自己 SDK 会话的 canUseTool，**lead 不插手 teammate 权限审批**（失败弹给真人走 teammate 自己 session 的 PendingTab）。

### 三个核心约定（lead 角度）

1. **spawn 首轮锚点**：`spawn_session` 返回 `spawnPromptMessageId: string | null`（仅当传 `team_name` 且 caller 在 sessions 表时非空），是首轮 prompt 在 messages 表的 placeholder id。lead 用它调 `wait_reply({message_id: spawnPromptMessageId})` 等首轮 reply
2. **后续轮次锚点**：`send_message` 返回 `{ sessionId, teamId, messageId, replyToMessageId, sentAt, queued: true }`。lead 用 `messageId` 调 `wait_reply({message_id})` 等后续 reply
3. **shutdown 不删数据**：`shutdown_session` 只标 lifecycle='closed' + abort SDK live query；events / file_changes / summaries / messages 子表保留，lead 在裁决报告里仍可引用

### wait_reply 按 messageId（非事件流轮询）

```ts
const reply = await mcp__agent_deck__wait_reply({
  message_id: <spawnPromptMessageId 或 send 返回的 messageId>,
  timeout_ms: 600_000,             // 默认 600_000ms（10 min），重 review 给足
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
