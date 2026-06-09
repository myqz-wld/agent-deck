--- Agent Deck 应用环境约定（随应用打包注入到每个 Codex SDK 会话）---

# 应用环境约定

## 优先级与加载

本文件给应用内 Codex SDK 会话补充 Agent Deck runtime 协议；安全约束、用户指令和项目约定按 Codex 优先级继续生效。

- Codex SDK 内置安全约束、sandbox、approval policy 和 system rules 始终最高，本文件不替代。
- developer message 和 per-turn user prompt 优先于本 baseline；冲突时遵守 caller 当下指令。
- `~/.codex/AGENTS.md` 中 Agent Deck marker 之外的用户自加段与本 baseline 同层级；冲突时按更具体、更近的 caller 指令执行。
- 本文件通过 Agent Deck installer 同步到 `~/.codex/AGENTS.md` 的 marker 段，Codex thread 启动时随 AGENTS 加载链进入 system prompt。

## Runtime 能力

### Teammate 协作

跨 adapter teammate 协作走 Agent Deck MCP tools。`send_message` 会经 universal-message-watcher 注入 receiver conversation；receiver 看到 user-role message 后直接处理，不主动轮询。

### Codex turn boundary

Codex SDK 是 turn-based。lead 调 `spawn_session` 或 `send_message` 后，如果下一步需要等待 teammate / reviewer reply，记录 `spawnPromptMessageId` 或 `messageId`，告诉 user 已派出任务，然后结束当前 turn。不要在同一 turn 内用 `sleep`、`get_session` 循环或忙等轮询。

下一条 wire-prefixed teammate reply 会作为 user-role message 注入本 thread；届时提取 `[msg <id>][sid <senderSid>]` 并继续裁决。只有 user 后续询问状态或 skill 给出明确卡住阈值时，才查 `get_session.lastEventAt` 并按 skill 执行 nudge、shutdown 或重 spawn。

### Task 进度

多步骤工作、plan、review 或跨会话协作必须用 Agent Deck MCP task tools 跟踪进度。Codex 没有原生 task tool；MCP task tools 不可用时，把进度写进 plan 文件、handoff prompt 或对话历史。

- 新建 personal task：`mcp__agent-deck__task_create({ subject, description?, status?, priority?, blocks?, blockedBy?, labels? })`。
- 新建 team-bound task：`mcp__agent-deck__task_create({ subject, teamId, ... })`；caller 必须是该 team 的 active member。
- 更新状态：`mcp__agent-deck__task_update({ taskId, status })`，状态只用 `pending` / `active` / `completed` / `blocked` / `abandoned`。
- 列表查询：`mcp__agent-deck__task_list()` 返回 caller 可见 task；`teamIdFilter` 限定某个 team；`teamIdFilter: 'null-personal'` 只看 caller personal task。
- 单个查询和删除走 `task_get` / `task_delete`，权限按 task 的 `teamId` 判定。

### Review teammate 失败

`simple-review` / `deep-review` 必须保留 Claude + Codex 异构 reviewer pair。若 reviewer-claude 失败，lead 先 `shutdown_session` 关闭失败 session，再重 spawn `adapter: 'claude-code'`、`agentName: 'reviewer-claude'`；不要用第二个 Codex reviewer 替代。

## Plan / Worktree / Handoff

复杂、跨会话、高风险或需要隔离的工作先写 durable plan，再进入 worktree 或 handoff。plan 路径必须是绝对路径，由 caller、项目约定或当前工作流指定；本 baseline 不假设仓库归档目录。

Plan 内容必须让 successor session 不读历史也能继续：

- 目标和不变量。
- 已确认的范围、排除项和设计决策。
- 当前 checklist 和进度。
- 下一会话第一步。
- 已知风险、验证要求和未解决问题。

Codex 没有 native EnterWorktree / ExitWorktree。需要隔离代码改动时，必须用 Agent Deck MCP 创建、标记和清理 worktree：

```ts
mcp__agent-deck__enter_worktree({ baseBranch, workBranch?, worktreePath?, worktreeRoot? })
```

`baseBranch` 必须是本地 branch 名，解析为 `refs/heads/<baseBranch>` 当前 commit；不要传 SHA、tag 或 rev 表达式。MCP 不改变 Codex SDK cwd，进入 worktree 后用绝对路径或 `git -C <worktreePath>`。

清理前确认改动已合并、迁出或明确放弃，再调用：

```ts
mcp__agent-deck__exit_worktree({ worktreePath?, discardChanges?, deleteBranch? })
```

`discardChanges: true` 只在用户明确放弃未提交改动时使用；`deleteBranch: true` 只在分支内容已合并、cherry-pick 或明确放弃后使用。

交接当前会话时，用 `hand_off_session` 启动 successor session。`prompt` 必须写明 plan 路径、临时上下文文件路径、当前进度和下一步；工具会转移 caller 的 task、active team membership 和 worktree marker，成功后关闭 caller。并行子任务用 `spawn_session`。

长上下文先写到 `/tmp/<name>.md`，再在 `spawn_session` 或 `hand_off_session` prompt 中要求 successor 运行 `shell: cat <abs-path>` 读取该文件。

## Agent Deck Universal Team Backend

Agent Deck MCP tools 编排 session、message、worktree、task 和 issue。teammate 调工具时使用自己的 Codex SDK approval policy、sandbox 和 MCP token；lead 不代批权限。

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

lead 等 teammate reply 时遵守 Codex turn boundary；发出任务后结束当前 turn，等 wire-prefixed reply 注入后再继续裁决。

### Cross-session rescue

lead context 重置后，用 `list_sessions({ spawnedByFilter: '<old-lead-session-id>', statusFilter: 'active' })` 找回旧 reviewer，再按 sessionId 发 `send_message`。如果 caller 与 target 不共享 active team 且未传 `teamId`，消息走 teamless DM：仍写入 messages 并注入 receiver conversation，但不进入 team 聚合面板。显式传入不共享的 `teamId` 会被拒绝。

需要保留 reviewer 跨轮 team 归属时，把新 caller 加回旧 team 或重新 spawn reviewer pair；只需单发补救消息时，teamless DM 可用。

### Wire fallback

reviewer agent 收到的 message 如果没有 `[msg <id>][sid <senderSid>]` 双锚点，仍要交付结果，但 reply 顶部必须提示 `⚠ NO MSG ANCHOR`。reviewer 先用 `list_sessions({ statusFilter: 'active' })` 反查 lead 和 shared team；无法唯一定位时，把结果留在当前 reviewer session 的 assistant output，lead 可在 SessionDetail 查看。

`messageId` 是 UUID；`senderSessionId` 是 SDK / CLI session id。解析 wire prefix 时只假设 lowercase hex + hyphen，不要收紧为 version-specific UUID regex。

### Dormant sessions

`dormant` 只停止 live query 和释放内存状态，不删除 Codex thread jsonl。下一次 `send_message` 会通过 `codex.resumeThread(threadId, options)` 复原对话历史。若 jsonl 缺失并触发 `⚠ FRESH SESSION`，关闭该 teammate 并重 spawn；不要继续依赖 fresh session 的旧上下文。

## Codex SDK defaults

Codex teammate spawn 使用应用层默认 SDK options；reviewer-codex 依赖这些默认值运行：

- `sandboxMode: 'workspace-write'`。
- `approvalPolicy: 'never'`，避免 SDK 会话等待不可见审批。
- `networkAccessEnabled: true`，供 reviewer-codex 调 OpenAI API。
- `additionalDirectories: ['~/.claude', '~/.codex', '/tmp']`，供 reviewer 读取必要上下文和临时文件。

MCP `spawn_session` 只暴露 `codexSandbox` 等白名单字段；不能覆盖任意 `additionalDirectories` 或 `networkAccessEnabled`。需要读取默认范围外文件时，把文件复制到 worktree、repo cwd、`~/.claude`、`~/.codex` 或 `/tmp` 后再传 scope。

Agent Deck 为每个 Codex SDK session 注入 `AGENT_DECK_MCP_TOKEN`。Codex MCP client 用该 token 连接 streamable HTTP MCP server；server 反查 caller session 后自动填入 tool handler。外部全局 token 只允许只读能力，spawn、send 和 archive 等写操作会被拒绝。

## Issue 上报

执行中发现应该记录、但不属于当前交付范围的问题，用 Agent Deck issue tools 上报；不要把当前任务应交付的内容改写成 issue。

- `report_issue`：记录 follow-up 或 Agent Deck app bug。
- `append_issue_context`：给本会话刚上报且未 resolved 的 issue 补上下文。
- `update_issue_status`：自己修好后标 `resolved`，或需要重开时标 `open` / `in-progress`。

当场能修且在当前 scope 内的问题直接修；一次性 trivial 观察不上报。
