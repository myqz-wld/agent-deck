--- Agent Deck 应用环境约定（随应用打包注入到每个 Claude Code SDK 会话）---

# 应用环境约定

## 优先级与加载

本文件给应用内 SDK 会话补充 Agent Deck runtime 协议；安全约束、用户指令和项目约定按 SDK 优先级继续生效。

- Claude Code preset 内置安全约束始终最高，本文件不替代。
- `settingSources: ['user','project','local']` 会同时加载 user / project / local `CLAUDE.md`；这些文件里的用户约定优先于本 baseline。
- per-turn user message、开发者注入和 SDK API 指令按 SDK 原生优先级生效；与本 baseline 冲突时遵守更高优先级指令。
- `settingSources: []` 的内部 oneshot 只接收应用注入的 baseline，不加载 user / project / local `CLAUDE.md`。

## Runtime 能力

### Teammate 协作

跨 adapter teammate 协作走 Agent Deck MCP tools。`send_message` 会经 universal-message-watcher 注入 receiver conversation；receiver 看到 user-role message 后直接处理，不主动轮询。

### Task 进度

多步骤工作、plan、review 或跨会话协作必须用 Agent Deck MCP task tools 跟踪进度；不要同时维护一套 Claude Code 原生 task list。

- 新建 personal task：`mcp__agent-deck__task_create({ subject, description?, status?, priority?, blocks?, blockedBy?, labels? })`。
- 新建 team-bound task：`mcp__agent-deck__task_create({ subject, teamId, ... })`；caller 必须是该 team 的 active member。
- 更新状态：`mcp__agent-deck__task_update({ taskId, status })`，状态只用 `pending` / `active` / `completed` / `blocked` / `abandoned`。
- 列表查询：`mcp__agent-deck__task_list()` 返回 caller 可见 task；`teamIdFilter` 限定某个 team；`teamIdFilter: 'null-personal'` 只看 caller personal task。
- 单个查询和删除走 `task_get` / `task_delete`，权限按 task 的 `teamId` 判定。

如果 `enableAgentDeckMcp: false` 让 MCP task tools 不可用，Claude Code 原生 Task tools 只能记录当前 SDK session 的本地进度；跨会话状态必须写进 plan 文件或 handoff prompt。

### Review teammate 失败

`simple-review` / `deep-review` 必须保留 Claude + Codex 异构 reviewer pair。若 reviewer-codex 失败，lead 先 `shutdown_session` 关闭失败 session，再重 spawn `adapter: 'codex-cli'`、`agentName: 'reviewer-codex'`；不要用第二个 Claude reviewer 替代。

## Plan / Worktree / Handoff

复杂、跨会话、高风险或需要隔离的工作先写 durable plan，再进入 worktree 或 handoff。plan 路径必须是绝对路径，由 caller、项目约定或当前工作流指定；本 baseline 不假设仓库归档目录。

Plan 内容必须让 successor session 不读历史也能继续：

- 目标和不变量。
- 已确认的范围、排除项和设计决策。
- 当前 checklist 和进度。
- 下一会话第一步。
- 已知风险、验证要求和未解决问题。

需要隔离代码改动时，从明确的本地 `baseBranch` 创建 worktree。Claude Code 端可用 native worktree 能力；需要写入 Agent Deck worktree marker 或跨 adapter 对齐时，走 MCP：

```ts
mcp__agent-deck__enter_worktree({ baseBranch, workBranch?, worktreePath?, worktreeRoot? })
```

进入 worktree 后，读写命令指向返回的 `worktreePath`。清理前确认改动已合并、迁出或明确放弃，再调用：

```ts
mcp__agent-deck__exit_worktree({ worktreePath?, discardChanges?, deleteBranch? })
```

`discardChanges: true` 只在用户明确放弃未提交改动时使用；`deleteBranch: true` 只在分支内容已合并、cherry-pick 或明确放弃后使用。

交接当前会话时，用 `hand_off_session` 启动 successor session。`prompt` 必须写明 plan 路径、临时上下文文件路径、当前进度和下一步；工具会转移 caller 的 task、active team membership 和 worktree marker，成功后关闭 caller。并行子任务用 `spawn_session`。

长上下文先写到 `/tmp/<name>.md`，再在 `spawn_session` 或 `hand_off_session` prompt 中要求 successor 读取该绝对路径。

## Agent Deck Universal Team Backend

Agent Deck MCP tools 编排 session、message、worktree、task 和 issue。teammate 调工具时使用自己的 SDK session 权限和 sandbox；lead 不代批权限。

Session tools：

- `spawn_session`：启动并行 SDK session；传 `teamName` 时会创建 shared team 并返回 `spawnPromptMessageId`。
- `hand_off_session`：启动 successor session 并接管 caller 资源。
- `send_message`：发送普通消息或带 `replyToMessageId` 的 reply。
- `list_sessions` / `get_session`：只读查询 session。
- `shutdown_session`：标记 `closed` 并停止 live query；不删除 events、messages、file changes 或 summaries。

Worktree tools：`enter_worktree` / `exit_worktree`。Task tools：`task_create` / `task_list` / `task_get` / `task_update` / `task_delete`。Issue tools：`report_issue` / `append_issue_context` / `update_issue_status`。

### Message anchors

`spawn_session` 返回的 `spawnPromptMessageId` 是 teammate 首轮 reply 的链路锚点。teammate first turn 完成后用 `send_message({ replyToMessageId: spawnPromptMessageId, ... })` 回复；reply 自动注入 lead conversation。

后续轮次用 `send_message` 返回的 `messageId` 作为 reply chain 锚点。receiver 收到的 user message 顶部会带 `[msg <id>][sid <senderSid>]`，reply 时提取这两个值并传回 `replyToMessageId`。

lead 等 teammate reply 时不需要主动 poll；看到 wire-prefixed user-role message 即继续处理。

### Cross-session rescue

lead context 重置后，用 `list_sessions({ spawnedByFilter: '<old-lead-session-id>', statusFilter: 'active' })` 找回旧 reviewer，再按 sessionId 发 `send_message`。如果 caller 与 target 不共享 active team 且未传 `teamId`，消息走 teamless DM：仍写入 messages 并注入 receiver conversation，但不进入 team 聚合面板。显式传入不共享的 `teamId` 会被拒绝。

需要保留 reviewer 跨轮 team 归属时，把新 caller 加回旧 team 或重新 spawn reviewer pair；只需单发补救消息时，teamless DM 可用。

### Wire fallback

reviewer agent 收到的 message 如果没有 `[msg <id>][sid <senderSid>]` 双锚点，仍要交付结果，但 reply 顶部必须提示 `⚠ NO MSG ANCHOR`。reviewer 先用 `list_sessions({ statusFilter: 'active' })` 反查 lead 和 shared team；无法唯一定位时，把结果留在当前 reviewer session 的 assistant output，lead 可在 SessionDetail 查看。

`messageId` 是 UUID；`senderSessionId` 是 SDK / CLI session id。解析 wire prefix 时只假设 lowercase hex + hyphen，不要收紧为 version-specific UUID regex。

### Dormant sessions

`dormant` 只停止 live query 和释放内存状态，不删除 conversation jsonl。下一次 `send_message` 会 resume 原 session。若 jsonl 缺失并触发 `⚠ FRESH SESSION`，关闭该 teammate 并重 spawn；不要继续依赖 fresh session 的旧上下文。

## Issue 上报

执行中发现应该记录、但不属于当前交付范围的问题，用 Agent Deck issue tools 上报；不要把当前任务应交付的内容改写成 issue。

- `report_issue`：记录 follow-up 或 Agent Deck app bug。
- `append_issue_context`：给本会话刚上报且未 resolved 的 issue 补上下文。
- `update_issue_status`：自己修好后标 `resolved`，或需要重开时标 `open` / `in-progress`。

当场能修且在当前 scope 内的问题直接修；一次性 trivial 观察不上报。
