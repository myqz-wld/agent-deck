---
plan_id: cursor-cli-acp-investigation-20260617
created_at: 2026-06-17T00:00:00+08:00
status: completed
base_commit: ec495b1
base_branch: main
worktree_path: /Users/wanglidong/Repository/agent-deck
motivation_source: user requested Cursor CLI ACP investigation before implementation
---

# Cursor CLI ACP Investigation

## Goal

调研 Cursor 是否有可接入的 SDK / 协议入口，并优先评估 `agent acp`
对 Agent Deck 的可接入性。目标不是本轮实现代码，而是给后续实现一个可执行的
adapter 设计边界、风险清单和验证计划。

## Executive Summary

推荐优先接入 **Cursor CLI ACP**，adapter id 建议为 `cursor-cli`。

原因：

- Cursor 官方文档确认 `agent acp` 是给 custom ACP clients / advanced integrations
  使用的隐藏命令，底层是 stdio + JSON-RPC 2.0 + newline-delimited JSON。
- ACP 的交互模型与 Agent Deck adapter 抽象匹配：初始化、鉴权、创建/加载会话、
  prompt turn、流式 `session/update`、权限请求、取消、关闭。
- Cursor ACP 还提供 Cursor 专属 blocking extension methods：
  `cursor/ask_question` 和 `cursor/create_plan`，可以映射到 Agent Deck 已有的
  AskUserQuestion / ExitPlanMode UI。
- 与直接接 `@cursor/sdk` 相比，ACP 更接近现有 `codex-cli` 的 subprocess bridge
  架构，不需要把 Cursor API key 纳入 Agent Deck 的配置存储，也更符合现有
  “应用不读不写 provider API key” 的项目约定。

不建议把 `@cursor/sdk` 作为第一步：

- SDK 明确要求 `CURSOR_API_KEY` 或 `apiKey`，会碰到 Agent Deck 当前不管理 API key
  的边界。
- TypeScript SDK 本地 agent quickstart 默认 headless 自动执行 tool calls；要安全 gate
  需要 hooks / sandbox / auto-review 组合，而这些不是 Agent Deck 当前统一 pending UI 的
  协议面。
- SDK 是 Node-first native dependency stack，包含 local checkpoint store、platform
  sandbox helper、ripgrep 等，打包和平台矩阵更重。

当前本机未安装 Cursor CLI：`command -v agent` 和 `command -v cursor-agent` 均无输出。
所以本报告包含静态调研和设计推断，但没有 live ACP transcript。下一步实现前必须先
安装 `agent` 并保存 raw JSON-RPC transcript。

## Confirmed Sources

官方资料：

- Cursor CLI overview: https://cursor.com/docs/cli/overview.md
- Cursor CLI parameters: https://cursor.com/docs/cli/reference/parameters.md
- Cursor CLI ACP: https://cursor.com/docs/cli/acp.md
- Cursor TypeScript SDK: https://cursor.com/docs/sdk/typescript.md
- Cursor Python SDK: https://cursor.com/docs/sdk/python.md
- Cursor MCP: https://cursor.com/docs/mcp.md
- ACP v1 overview: https://agentclientprotocol.com/protocol/v1/overview
- ACP initialization: https://agentclientprotocol.com/protocol/v1/initialization
- ACP session setup: https://agentclientprotocol.com/protocol/v1/session-setup
- ACP prompt turn: https://agentclientprotocol.com/protocol/v1/prompt-turn
- ACP tool calls: https://agentclientprotocol.com/protocol/v1/tool-calls
- ACP content: https://agentclientprotocol.com/protocol/v1/content
- ACP session modes: https://agentclientprotocol.com/protocol/v1/session-modes
- ACP transports: https://agentclientprotocol.com/protocol/v1/transports

本仓库对照资料：

- `src/main/adapters/types/agent-adapter.ts`
- `src/main/adapters/types/capabilities.ts`
- `src/main/adapters/options-builder.ts`
- `src/main/adapters/registry.ts`
- `src/main/adapters/codex-cli/app-server/client.ts`
- `src/main/adapters/codex-cli/app-server/translate.ts`
- `src/main/adapters/claude-code/sdk-bridge/can-use-tool.ts`
- `src/shared/types/permission.ts`

## Cursor Integration Surfaces

### 1. Cursor CLI ACP

官方 Cursor ACP 文档确认：

- 启动命令：`agent acp`
- transport：stdio
- envelope：JSON-RPC 2.0
- framing：newline-delimited JSON，每行一个 JSON-RPC message
- client 写 stdin，Cursor CLI 写 stdout，stderr 用于 logs
- 典型流程：
  1. `initialize`
  2. `authenticate` with `methodId: "cursor_login"`
  3. `session/new` or `session/load`
  4. `session/prompt`
  5. handle `session/update`
  6. handle `session/request_permission`
  7. optionally `session/cancel`

认证方式：

- ACP auth method：`cursor_login`
- 可先通过 `agent login` 登录
- 也可用 `--api-key` / `CURSOR_API_KEY`
- 也可用 `--auth-token` / `CURSOR_AUTH_TOKEN`

Cursor ACP 支持的 session modes：

- `agent`
- `plan`
- `ask`

权限响应选项：

- `allow-once`
- `allow-always`
- `reject-once`

Cursor ACP 专属扩展：

| Method | 类型 | Agent Deck 映射 |
|---|---|---|
| `cursor/ask_question` | blocking request | `AskUserQuestionRequest` + `respondAskUserQuestion` |
| `cursor/create_plan` | blocking request | `ExitPlanModeRequest` + `respondExitPlanMode` |
| `cursor/update_todos` | notification | activity / task event |
| `cursor/task` | notification | activity / subagent event |
| `cursor/generate_image` | notification | activity / generated image event, MVP 可先展示文本 |

### 2. Cursor TypeScript SDK

官方 `@cursor/sdk` 提供 programmatic agent API：

- `Agent.create({ local: { cwd }, model, apiKey })`
- `agent.send(...)`
- `run.stream()`
- `run.wait()`
- `run.cancel()`
- `run.conversation()`
- `Agent.resume(agentId, ...)`

支持 local / Cursor-hosted cloud / self-hosted cloud runtimes。local 意味着 agent loop
和 filesystem access 在本机，model inference 仍走 Cursor hosted models。

关键边界：

- SDK 需要 `CURSOR_API_KEY` 或显式 `apiKey`。
- local quickstart 默认 tool calls 不走 human-in-the-loop approval；文档建议用 hooks、
  `local.sandboxOptions.enabled: true` 或 `local.autoReview` 兜底。
- hooks 是 file-based only，没有 programmatic hook callback。
- 本地 SDK 有 native dependency 和 checkpoint store，打包复杂度比 ACP 子进程高。
- SDK 的 `mcpServers` inline / file-based / dashboard 配置模型与 Agent Deck 当前
  MCP 注入方式不同。

结论：SDK 适合作为未来可选 provider surface，或用于 cloud agents / automation；
不适合作为第一版 Agent Deck interactive adapter。

### 3. Cursor Python SDK

`cursor-sdk` 与 TypeScript SDK 语义类似，提供 sync / async clients、local / cloud agents、
streaming 和 resume。由于 Agent Deck main process 是 TypeScript/Electron，Python SDK
不适合作为主接入路径，只作为“Cursor 确实提供 SDK surface”的旁证。

## ACP Protocol Findings

### Transport

ACP stdio 约束：

- client launches agent as subprocess
- agent stdin/stdout 交换 JSON-RPC messages
- messages are newline-delimited
- stdout 只能写 ACP messages
- stderr 可写 UTF-8 logs

这与现有 `CodexAppServerClient` 的 transport 形态高度接近。

### Initialization

client 必须先发：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientCapabilities": {
      "fs": { "readTextFile": false, "writeTextFile": false },
      "terminal": false
    },
    "clientInfo": {
      "name": "agent-deck",
      "title": "Agent Deck",
      "version": "0.1.0"
    }
  }
}
```

MVP 建议声明最小 client capabilities：

- `fs.readTextFile: false`
- `fs.writeTextFile: false`
- `terminal: false`

理由：Agent Deck 现在不想让 Cursor agent 反向调用 Agent Deck host 的 fs/terminal
能力；Cursor 自己的 agent 工具可在它的 sandbox / permission boundary 内执行。

需要记录 initialize response：

- `protocolVersion`
- `agentCapabilities.loadSession`
- `agentCapabilities.promptCapabilities.image`
- `agentCapabilities.promptCapabilities.embeddedContext`
- `agentCapabilities.mcpCapabilities.http/sse`
- `agentCapabilities.sessionCapabilities.close`
- `agentCapabilities.sessionCapabilities.resume`
- `agentCapabilities.sessionCapabilities.additionalDirectories`
- `authMethods`

### Session Lifecycle

`session/new` 必须包含 absolute `cwd` 和 `mcpServers`。ACP spec 要求 `cwd` 为绝对路径。

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/new",
  "params": {
    "cwd": "/Users/wanglidong/Repository/agent-deck",
    "mcpServers": []
  }
}
```

如果 `loadSession` capability 为 true，可用 `session/load` 恢复旧 session。加载时 agent
会通过 `session/update` replay conversation。Agent Deck 需要避免把 replay 当成新消息重复
持久化；这点必须用 live transcript 验证 Cursor 行为。

如果 `sessionCapabilities.close` 存在，可用 `session/close`。否则关闭只能：

- 若有 active prompt，先发 `session/cancel`
- 再 kill 子进程 / dispose transport

如果 `sessionCapabilities.additionalDirectories` 存在，才能发送
`additionalDirectories`。否则不能发送。这里可以承接 Agent Deck 的 `extraAllowWrite`
语义，但 MVP 不建议先做。

### Prompt Turn

`session/prompt` 是一个完整 turn。agent 在 turn 内通过 `session/update` 推送：

- `agent_message_chunk`
- `tool_call`
- `tool_call_update`
- `usage_update`
- plan / mode updates 等

turn 最后通过原 `session/prompt` request 的 response 返回 stop reason：

- `end_turn`
- `max_tokens`
- `max_turn_requests`
- `refusal`
- `cancelled`

取消使用 `session/cancel` notification。Agent Deck 的 `interruptSession` 应映射到它。

### Tool Calls And Permission

ACP tool event 形态：

- `tool_call` 创建工具调用，包含 `toolCallId`、`title`、`kind`、`status`、
  `rawInput`、`locations` 等。
- `tool_call_update` 更新工具状态，包含 `status`、`content`、`rawOutput` 等。
- tool content 支持普通 content、diff、terminal reference。
- `locations` 可携带正在读写的文件路径和行号。

权限请求是 agent -> client 的 JSON-RPC request：

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "session/request_permission",
  "params": {
    "sessionId": "sess_abc123",
    "toolCall": { "toolCallId": "call_001" },
    "options": [
      { "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" },
      { "optionId": "reject-once", "name": "Reject", "kind": "reject_once" }
    ]
  }
}
```

client response：

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "outcome": {
      "outcome": "selected",
      "optionId": "allow-once"
    }
  }
}
```

如果 turn 被取消，client 必须返回：

```json
{
  "outcome": { "outcome": "cancelled" }
}
```

Agent Deck mapping：

- `PermissionRequest.requestId` = server-originated JSON-RPC `id`
- `PermissionRequest.toolName` = `toolCall.title` 或 `toolCall.kind`
- `PermissionRequest.toolInput` = `toolCall.rawInput` 或完整 toolCall fallback
- `PermissionResponse.decision = allow`:
  - 若用户触发 always allow 且 Cursor options 有 `allow-always`，回 `allow-always`
  - 否则回 `allow-once`
- `PermissionResponse.decision = deny`: 回 `reject-once`
- 不支持 `updatedInput`，除非 live transcript 证明 Cursor tool permission 接受 input rewrite。

### Session Modes

ACP 标准支持 mode state：

- `session/new` result 可返回 `modes.currentModeId` 与 `modes.availableModes`
- client 可发 `session/set_mode`
- agent 可通过 `current_mode_update` 通知 mode change

Cursor ACP 文档确认 mode 名称是 `agent` / `plan` / `ask`。

Agent Deck mapping 建议：

- MVP 不声明 `canSetPermissionMode`，不做 runtime mode switch。
- `createSession` 可接收后续新增的 `cursorMode?: 'agent' | 'plan' | 'ask'`，但要先用
  live transcript 验证 Cursor ACP 的 mode 是在 `session/new` params、`session/prompt`
  params，还是需要 `session/set_mode`。
- `plan` 不等于 Claude `PermissionMode.plan` 的完整语义；二者只可做 UX 近似，不应复用
  Claude permission mode 存储字段。

### MCP

Cursor ACP 文档说明：

- ACP 支持 project-level / user-level `.cursor/mcp.json`
- 从项目目录 launch `agent` 并 approve servers
- dashboard team-level MCP servers 不支持 ACP mode

ACP 标准也允许 `session/new` 传 `mcpServers`，且所有 agents 必须支持 stdio MCP，
HTTP/SSE 要看 capabilities。

MVP 建议：

- `session/new` 先传 `mcpServers: []`
- Cursor 自己通过 `.cursor/mcp.json` 和 `~/.cursor/mcp.json` 加载 MCP
- 不在第一版把 Agent Deck MCP server inline 注入 Cursor ACP

理由：

- Cursor 官方 ACP 文档把 MCP 支持落在 `.cursor/mcp.json`，不是 dashboard team MCP。
- inline `mcpServers` 可能涉及 secret/env/auth 和 approval 行为，需要 live transcript 验证。
- Agent Deck 的 universal team backend 不依赖把 Agent Deck MCP 强行注入每个 Cursor session；
  teammate 消息可由应用层 `receiveTeammateMessage` 注入普通 prompt。

### Attachments And Content Blocks

ACP content 支持：

- text
- image
- audio
- embedded resource
- resource link

是否可在 prompt 传 image 要看 `agentCapabilities.promptCapabilities.image`。

MVP 建议：

- `canAcceptAttachments: false`
- 初始化后如果 Cursor advertise `image: true`，再做第二阶段支持图片附件
- 支持时把 Agent Deck `UploadedAttachmentRef` 读成 base64 `ContentBlock::Image`

## Agent Deck Architecture Fit

### Existing Adapter Contract

`AgentAdapter` 现有核心方法：

- `createSession`
- `sendMessage`
- `interruptSession`
- `closeSession`
- `respondPermission`
- `respondAskUserQuestion`
- `respondExitPlanMode`
- `setPermissionMode`
- `restartWithPermissionMode`
- `restartWithCodexSandbox`
- `restartWithClaudeCodeSandbox`
- `listPending`
- `listAllPending`
- `receiveTeammateMessage`
- `summariseEvents`

Cursor ACP 能覆盖：

- create / send / interrupt / close
- pending permission / ask question / plan approval
- collaboration receive message
- token usage update 的部分采集

Cursor ACP 暂不明确覆盖：

- mid-turn steering
- Claude-style permission mode hot switch / cold switch
- Codex sandbox cold switch
- hook install
- provider usage dashboard snapshot
- summariseEvents oneshot

### Adapter Capability Recommendation

第一版 `cursor-cli` capabilities：

```ts
{
  canCreateSession: true,
  canInterrupt: true,
  canSendMessage: true,
  canSteerTurn: false,
  canInstallHooks: false,
  canRespondPermission: true,
  canSetPermissionMode: false,
  canRestartWithPermissionMode: false,
  canRestartWithCodexSandbox: false,
  canRestartWithClaudeCodeSandbox: false,
  canCloseSession: true,
  canCollaborate: true,
  canAcceptAttachments: false,
}
```

`canCloseSession: true` 的含义：

- 如果 ACP `sessionCapabilities.close` 为 true，调用 `session/close`
- 否则 adapter 自己 dispose child process，也满足 Agent Deck “delete session 时释放
  adapter internal state” 的 contract

### Transport Implementation

新建 `src/main/adapters/cursor-cli/acp-client.ts`。

可复用 `CodexAppServerClient` 的设计：

- spawn child process
- capture stderr ring buffer
- readline stdout per line
- pending request map
- request timeout / dispose
- notification listener

必须区别：

- ACP messages 必须带 `jsonrpc: "2.0"`
- Cursor 会发 server-originated JSON-RPC request：
  - `session/request_permission`
  - `cursor/ask_question`
  - `cursor/create_plan`
  - 未来可能还有标准 fs/terminal request
- 不能像 `CodexAppServerClient.respondUnsupportedServerRequest` 那样全部 unsupported。
- 对未知 server request：
  - 若是我们未声明 capability 的 request，如 `fs/read_text_file`，回 JSON-RPC method not found /
    unsupported error
  - 若是 Cursor extension 且未知，记录 error 并回 cancelled/rejected，避免 agent 永久等待

建议 process model：

- MVP：每个 Agent Deck session 一个 `agent acp` child process
- 优点：隔离 cwd、mode、pending、stderr、crash recovery 简单
- 缺点：多会话时进程多，但与现有 Claude/Codex bridge 成本模型一致
- 不建议第一版做一个 ACP process multiplex 多 session

### Event Translation

ACP -> Agent Deck 初步映射：

| ACP update / method | Agent Deck event |
|---|---|
| `agent_message_chunk` | `message` role assistant；按 messageId 聚合更佳 |
| `user_message_chunk` from `session/load` | resume replay 专用；默认不持久化为新事件 |
| `tool_call` | `tool-use-start` |
| `tool_call_update status=in_progress` | update existing tool card / append aggregated output |
| `tool_call_update status=completed` | `tool-use-end` |
| `tool_call_update content.type=diff` | potential `file-changed` |
| `tool_call.locations` | activity metadata / follow file |
| `usage_update` | `token-usage` 或 session context usage event |
| `session/request_permission` | `waiting-for-user` payload `permission-request` |
| `cursor/ask_question` | `waiting-for-user` payload `ask-user-question` |
| `cursor/create_plan` | `waiting-for-user` payload `exit-plan-mode` |
| `cursor/update_todos` | activity/task event；MVP 可先 assistant/system message |
| `cursor/task` | activity/tool event；MVP 可先 assistant/system message |
| `cursor/generate_image` | activity message；后续接 image asset flow |
| prompt response `stopReason=end_turn` | `finished` ok true |
| prompt response `stopReason=cancelled` | `finished` ok false subtype interrupted |
| prompt response `stopReason=refusal/max_tokens/max_turn_requests` | `message` warning + `finished` false |

文件变化：

- ACP tool content 支持 `diff`，包含 absolute `path`、`oldText`、`newText`。
- 可直接映射 Agent Deck `file-changed` 的 text diff before/after。
- 但需要检查 Agent Deck file change payload 当前要求的是 path snapshot 还是 inline text；
  第一版可以先只显示 tool output，不落 file_changes，直到 live transcript 确认 Cursor
  对 edits 会稳定发 diff。

### Pending UI Mapping

Cursor permission：

- pending key = `${sessionId}:${rpcId}`
- emit `waiting-for-user` with `PermissionRequest`
- `respondPermission` 写 JSON-RPC response
- timeout / cancel 时回 `{ outcome: { outcome: "cancelled" } }`

Cursor `cursor/ask_question`：

request shape：

```ts
interface CursorAskQuestionRequest {
  toolCallId: string;
  title?: string;
  questions: Array<{
    id: string;
    prompt: string;
    options: Array<{ id: string; label: string }>;
    allowMultiple?: boolean;
  }>;
}
```

映射：

- `requestId` = rpc id
- `toolUseId` = `toolCallId`
- `header` = `title`
- `question` = `prompt`
- `options[].label` = Cursor option label
- 记录 label -> option id map
- `respondAskUserQuestion` 时把用户选中的 labels 转回 option ids
- Agent Deck 的 `other` / `note` 字段 Cursor 协议没有直接承载位置；MVP 忽略或作为 skipped
  reason 之外的 no-op

Cursor `cursor/create_plan`：

request shape 包含：

- `toolCallId`
- `name`
- `overview`
- `plan`
- `todos`
- optional `phases`

映射：

- `ExitPlanModeRequest.title` = `name` or `overview`
- `ExitPlanModeRequest.plan` = markdown plan + todos/phases append
- `reviewSource: 'adapter'`
- `approve` / `approve-bypass` 均回 `accepted`
- `keep-planning` 回 `rejected`，feedback 填 reason
- timeout / interrupt 回 `cancelled`

注意：Cursor `create_plan` approval 不等于 Claude `ExitPlanMode` 的 permission mode 切换。
Agent Deck UI 当前 approval response 要求 `targetMode`；Cursor adapter 应忽略 targetMode，只把
accepted/rejected/cancelled 回给 Cursor。

## Proposed File Touchpoints

最小实现文件：

- `src/main/adapters/cursor-cli/index.ts`
- `src/main/adapters/cursor-cli/acp-client.ts`
- `src/main/adapters/cursor-cli/acp-types.ts`
- `src/main/adapters/cursor-cli/acp-translate.ts`
- `src/main/adapters/cursor-cli/pending-responder.ts`
- `src/main/adapters/cursor-cli/cursor-binary.ts`

类型/注册：

- `src/main/adapters/types/create-session-opts.ts`
- `src/main/adapters/options-builder.ts`
- `src/main/adapters/registry.ts`

可能需要 UI / settings：

- `src/main/store/settings-store.ts`：可选 `cursorCliPath`
- `src/main/ipc/settings.ts`：path setting 即改即生效
- settings UI：可选 Cursor CLI path override

不建议 MVP 改动：

- README
- packaging
- MCP injection
- attachment UI gate
- provider usage dashboard

## MVP Runtime Design

### Create Session

Pseudo flow：

```ts
const client = new CursorAcpClient({ command: resolveCursorAgent(), cwd: opts.cwd, env });
const init = await client.initialize({
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  },
  clientInfo: { name: 'agent-deck', title: 'Agent Deck', version },
});

await client.authenticate({ methodId: 'cursor_login' });

const session = opts.resume
  ? await client.loadSession({ sessionId: opts.resume, cwd: absCwd, mcpServers: [] })
  : await client.newSession({ cwd: absCwd, mcpServers: [] });

if (opts.prompt) await runPrompt(session.sessionId, [{ type: 'text', text: opts.prompt }]);
return session.sessionId;
```

需要确认：

- `authenticate` 在已经 `agent login` 的情况下返回什么。
- 如果 `authMethods` 为空，是否仍需调用 `authenticate`。
- `session/load` replay 是否必须等到 request response 后才可继续 prompt。

### Send Message

- 若 session idle，直接 `session/prompt`
- 若 active prompt running：
  - MVP：拒绝并提示 session busy，或进入 per-session queue
  - 更符合现有 Codex behavior：加 bounded queue，turn 结束后顺序发送

ACP 标准没有 mid-turn steering；不要把普通 `sendMessage` 塞到 active turn 中。

### Interrupt

- 若 active prompt，发 `session/cancel` notification
- pending permission / ask / plan 均回 cancelled，避免 Cursor agent 等待
- 等待 prompt response `stopReason=cancelled`，超时后 kill child

### Close

- 清 pending maps
- 若支持 `session/close`，调用
- 否则 cancel active prompt + dispose child
- 不因 close 失败阻塞 SessionManager delete

## Authentication And Secrets

项目约定：Agent Deck 不读不写任何 provider API key。

Cursor ACP MVP 应遵循：

- 不在 Agent Deck settings 存 Cursor API key
- 依赖用户本机先执行 `agent login`
- 如用户自行在外部环境设置 `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`，adapter 只继承
  main process env，不提供 UI 存储
- `integrationStatus` 可选实现：
  - binary exists
  - `agent status` / `agent whoami` 成功
  - `agent --version`

## Sandbox And Permission Semantics

Cursor CLI 有 `--sandbox enabled|disabled`，interactive `/sandbox` 还可配置 network access。
Cursor SDK 有 `local.sandboxOptions.enabled`，默认 false。

但 ACP 文档没有明确 per-session sandbox params。MVP 不做 Agent Deck sandbox UI 映射。

建议：

- 不复用 `codexSandbox`
- 不复用 `claudeCodeSandbox`
- 后续如果需要，新增 adapter-scoped `cursorSandbox?: 'enabled' | 'disabled'`
- 只能在 spawn `agent acp` 时通过 CLI flag 传入，不能假设可 runtime 切换

权限方面：

- Cursor ACP 的 `session/request_permission` 是标准 client-side gate，应该接 Agent Deck
  PendingTab。
- 不要把 Claude `bypassPermissions`、`acceptEdits` 等概念硬套给 Cursor。

## Comparison: ACP vs Cursor SDK

| 维度 | Cursor ACP | Cursor SDK |
|---|---|---|
| Agent Deck 架构匹配 | 高，stdio subprocess bridge | 中，Node SDK in-process |
| 鉴权 | 可复用 `agent login` | 需要 `CURSOR_API_KEY` / `apiKey` |
| Pending UI | 原生 `session/request_permission` + Cursor blocking methods | 默认 headless 自动执行，需 hooks/sandbox/auto-review |
| 会话恢复 | `session/load` / possibly `session/resume` | `Agent.resume(agentId)` |
| 流式事件 | ACP 标准 `session/update` | SDK `SDKMessage` |
| MCP | `.cursor/mcp.json`；ACP inline 待测 | inline / project / user / dashboard 多来源 |
| 打包复杂度 | 依赖外部 `agent` binary | 引入 native dependency 和 Cursor SDK stack |
| 适合作为第一版 adapter | 是 | 否 |

## Required Live Spike Before Implementation

由于本机当前没有 Cursor CLI，必须先完成以下 spike。

安装与登录：

```bash
curl https://cursor.com/install -fsS | bash
agent --version
agent status
agent login
```

最小 handshake：

1. spawn `agent acp`
2. send `initialize`
3. inspect `agentCapabilities` and `authMethods`
4. send `authenticate { methodId: "cursor_login" }`
5. send `session/new { cwd, mcpServers: [] }`
6. send `session/prompt` with text
7. save raw NDJSON transcript

测试用例：

| 用例 | 目的 |
|---|---|
| hello prompt | 基础 init/auth/new/prompt/update/stopReason |
| ask mode / plan mode | mode params 或 `session/set_mode` 行为 |
| run `pwd` | `session/request_permission` payload / options / response |
| create temp file | tool diff / locations / file change event shape |
| long prompt + cancel | `session/cancel` 和 late updates |
| close support | initialize 是否 advertise `sessionCapabilities.close` |
| process restart + `session/load` | replay semantics / duplicate event guard |
| `.cursor/mcp.json` simple stdio server | Cursor ACP MCP loading和 approval |
| inline `mcpServers` | 是否实际可用；若不可用，保持禁用 |
| image prompt | `promptCapabilities.image` 和 content block shape |
| `cursor/ask_question` | blocking extension response shape |
| `cursor/create_plan` | blocking plan approval response shape |

transcript 保存建议：

- `ref/plans/cursor-cli-acp-investigation-20260617/spike-reports/`
- 每个 case 一个 `.jsonl` raw transcript + 一个 `.md` conclusion

## Open Questions

必须靠 live transcript 回答：

1. `agent acp` initialize response 的实际 `agentCapabilities`。
2. `authenticate cursor_login` 在已登录 / 未登录 / API key 三种状态下的结果。
3. Cursor ACP mode 是通过 `session/new` params、`session/prompt` params、还是
   `session/set_mode` 控制。
4. `session/request_permission.toolCall` 是否包含完整 `title/kind/rawInput`，还是只有
   `toolCallId`。
5. `allow-always` 是否总会出现在 options 中；若没有，Agent Deck “always allow” 要禁用。
6. `cursor/ask_question` 是否会在真实任务中触发，还是需要特定 prompt。
7. `cursor/create_plan` 是否总在 plan mode 触发，是否与标准 `session/request_permission`
   的 switch-mode tool 并存。
8. `session/load` replay 是否会返回 old message chunks；Agent Deck 是否应忽略 replay。
9. Cursor ACP 是否 advertise `sessionCapabilities.close/resume/additionalDirectories`。
10. `.cursor/mcp.json` 与 inline `mcpServers` 在 ACP 下的真实优先级和 approval 体验。
11. tool edit 是否稳定发 `diff` content，能否可靠生成 Agent Deck file-changed。
12. `usage_update` 的 token counts 是否是 context used/size，还是可作为 provider usage。

## Implementation Phasing

### Phase 0: Live Protocol Spike

- 安装 Cursor CLI
- 保存 handshake / prompt / permission / cancel / resume raw transcript
- 根据 transcript 修正文档中的推断

### Phase 1: Transport + Basic Session

- `CursorAcpClient`
- `CursorCliAdapter`
- create / prompt / stream assistant messages / finish
- basic tests with fake ACP server

### Phase 2: Pending UI

- `session/request_permission`
- `cursor/ask_question`
- `cursor/create_plan`
- pending list / cancel / timeout behavior
- renderer existing PendingTab 应无需新增 UI 类型

### Phase 3: Resume / Close / Team

- `session/load`
- `session/close` capability fallback
- `receiveTeammateMessage`
- bounded pending message queue

### Phase 4: Rich Events

- tool cards
- diffs / file changes
- usage updates
- todos/tasks/generate_image notification rendering

### Phase 5: Optional Enhancements

- Cursor CLI path setting
- Cursor sandbox setting
- attachments via image prompt capability
- inline MCP server injection if live spike proves stable
- summariseEvents oneshot or ACP one-shot helper

## Risks

- Cursor ACP command is documented as advanced / hidden; surface may change faster than normal CLI.
- Cursor ACP docs provide extension method shapes, but actual payloads need transcript fixtures.
- Agent Deck current `ExitPlanModeResponse` is Claude-shaped and includes `targetMode`; Cursor adapter
  must deliberately ignore that field.
- If Cursor only works well with `.cursor/mcp.json`, Agent Deck MCP auto-injection parity with Codex
  will not exist in MVP.
- Without `agent` binary bundled, adapter availability depends on user-installed Cursor CLI.
- Cursor SDK / CLI auth and plan availability may depend on Cursor plan tier; integration status should
  surface actionable errors instead of failing at first prompt.
- `session/load` replay can duplicate messages unless adapter tracks replay phase.
- `session/request_permission` can block the agent indefinitely if UI responder is lost; timeout/cancel
  handling is required from day one.

## Final Recommendation

Proceed with Cursor CLI ACP as the first Cursor integration path, but gate implementation on a live
protocol spike. The MVP should be conservative:

- external `agent` binary only
- user pre-auth via `agent login`
- one ACP child process per Agent Deck session
- text prompts only
- no inline MCP injection
- no runtime mode/sandbox switch
- full pending support for permission, ask question, and plan approval

After transcript-backed tests exist, Cursor ACP can become a first-class Agent Deck adapter with
behavior closer to Claude adapter on UI approvals and closer to Codex adapter on subprocess transport.
