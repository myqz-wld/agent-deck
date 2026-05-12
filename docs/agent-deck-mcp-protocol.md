# ADR — Agent Deck MCP Server (B'0)

> R2 阶段架构决策记录。本文件先于 B'1-B'7 任何代码落地，定义 wire protocol、tool 集、
> 鉴权、防递归 4 条规则、用户语义映射文档。所有后续 R2 任务以本文件为单一信源。

**状态**：ACCEPTED（2026-05-11；reviewer 双对抗 4 HIGH ✅ + MED/LOW 全部合并）
**关联**：plan v3 R2 节 / `experiments/spikes/SPIKE_REPORT.md`（B'-wire / B'-caller-id）

---

## 1. 目标 & 非目标

### 1.1 目标

让 Claude / Codex / 任何支持 MCP 的 coding agent 通过 MCP 协议**编排其它 adapter session**：

```
[Claude session #lead] --mcp__agent_deck__spawn_session(adapter:'codex-cli', cwd:..., prompt:...)
                                          ↓
[Agent Deck 主进程 SessionManager + adapterRegistry]
                                          ↓
[Codex session #teammate spawned]
```

6 个 tool 满足跨 runtime 协作的最小完备集（详 §3）：
1. `spawn_session` —— 起新 session（任意 adapter）
2. `send_message` —— 给已存在 session 推 user message
3. `wait_reply` —— 阻塞等 session 出新消息 / 进入 idle / 完成回合（详 §4）
4. `list_sessions` —— 查当前可见 sessions 集合（支持 status_filter / adapter_filter / spawned_by_filter）
5. `get_session` —— 按 id 查单个 session 元数据（投影同 list_sessions，REVIEW_28 新增）
6. `shutdown_session` —— 关闭 session（abort SDK live query + 清 Map + DB lifecycle 推到 closed）

### 1.2 非目标

- **不是 SDK Agent Teams 的替代品**（那是 R3.E 阶段的工作）。本文件聚焦「跨 runtime spawn / 通讯 / 关闭」原始能力，**不**定义 team 抽象、不定义 cross-session message 路由的 SQL schema、不接管 inbox 协议。
- **不暴露内部 sessionId 之外的 caller 信息**给被调 tool（如 caller process pid、执行文件路径等）。
- **不实现 streaming MCP tool result**（MCP spec 未稳定）；wait_reply 仍是单次 request → 单次 response 阻塞模型。
- **不做 cross-tenant / multi-user 隔离**。Agent Deck 是单用户桌面应用，所有 MCP 调用都视为同一信任域。

---

## 2. Transport 选型（三协议并存）

按 plan v3 用户决策落地：**三协议并存**，单一 tool 集（同一份 `buildAgentDeckTools()` handler 注册到 3 个 transport）。

| Transport | 用途 | 入口 | 鉴权 | caller_session_id 来源 |
|---|---|---|---|---|
| **in-process** | Claude SDK 会话内自动挂（B'3） | `createSdkMcpServer` | 无（同进程闭包） | closure 强制覆盖（用当前 SDK session id） |
| **HTTP** | Codex / 第三方 MCP client（B'4） | `POST/GET/DELETE /mcp` 挂在 HookServer fastify 上 | Bearer token（独立于 hook token） | 强制 input schema 必填 + Authorization header 反查兜底 |
| **stdio** | 本机 CLI / Cursor / Continue 等 stdio MCP client（B'1 同时落） | `agent-deck mcp` 子命令（cli.ts 加） + Stdio transport | 父进程身份隐式信任（仅限当前用户启动的子进程） | 强制 input schema 必填 + 进程层无法反查 → handler 拿不到时整体 deny |

### 2.1 transport 实现选型（spike-B'-wire 已确认）

- `@modelcontextprotocol/sdk@1.29.0`（claude-agent-sdk 0.2.118 传递依赖，已 hoist 到 `node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk`）提供：
  - `Server` / `McpServer`（高层 API）
  - `StreamableHTTPServerTransport`（HTTP）
  - `StdioServerTransport`（stdio）
- `createSdkMcpServer` 来自 `@anthropic-ai/claude-agent-sdk`（in-process，复用 SDK 内部 server instance）
- HTTP transport 集成 fastify ~50-100 LOC（spike 实测 import 形态成熟，无需 from-scratch wire protocol）

### 2.2 三 transport 共享 handler 的封装

```ts
// src/main/agent-deck-mcp/tools.ts
export interface CallerContext {
  callerSessionId: string;           // 必填，来源由 transport 决定
  parentSessionId?: string;          // 可选，spawn 链路上一级
  transport: 'in-process' | 'http' | 'stdio';
  // 注：depth 字段从 caller context 中移除 —— spawn-time 的真值通过
  // sessionRepo.getSpawnDepth(callerSessionId) 反查 DB（详 §6.5），
  // caller-side 无可信 depth 来源。
}

export type AgentDeckToolHandler<Args> = (
  args: Args,
  caller: CallerContext,
) => Promise<CallToolResult>;

export function buildAgentDeckTools(deps: {
  sessionManager: SessionManagerClass;
  adapterRegistry: AdapterRegistryClass;
  rateLimiter: RateLimiter;          // B'5
  waitReplyCoordinator: WaitReplyCoordinator;  // B'2.b
}): AgentDeckTool[] { ... }
```

每个 transport 适配器在 handler wrap 层把自己的 caller context 注入：

- **in-process**（B'3）：`buildAgentDeckTools` 时 closure 拿到当前 SDK session id（lazy provider，与 task-manager `getTasksMcpServerForSession` 同款 pattern）。caller.callerSessionId 强制覆盖 args，无视调用方传值。
- **HTTP**：从 args.caller_session_id（zod 必填）+ Authorization header 反查（兜底）。两者冲突时优先 args（client 显式表态），但都缺时 deny。
- **stdio**：args.caller_session_id 必填，handler 内反查 sessionRepo 验证 session 存在；不存在 deny。

---

## 3. Tool 完整 Schema

字段命名约定：tool args **snake_case**（与 task-manager 既有约定 + Python SDK 惯例一致）；内部 TS 接口 camelCase。

### 3.1 `spawn_session`

```ts
inputSchema: z.object({
  adapter: z.enum(['claude-code', 'codex-cli', 'aider', 'generic-pty'])
    .describe('Target adapter id. Use list_sessions to see currently registered adapters.'),
  cwd: z.string().min(1).max(4096)
    .refine((p) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p), 'Must be absolute path')
    .describe('ABSOLUTE working directory for the new session. Relative paths are rejected — caller must resolve before passing (rationale: HTTP/stdio transports have no reliable per-caller cwd context).'),
  prompt: z.string().min(1).max(100_000)
    .describe('Initial user message (1-100KB). Required — sessions cannot start blank.'),
  team_name: z.string().min(1).max(128).optional()
    .describe('Optional: team scope label. R2: just persisted to sessions.team_name (existing column from v006); used by callers to group reviewer/teammate sessions. R3.E will add team metadata table; until then this is purely a tag.'),
  permission_mode: z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
    .optional()
    .describe('Claude-only permission mode (ignored by other adapters).'),
  codex_sandbox: z.enum(['workspace-write', 'read-only', 'danger-full-access'])
    .optional()
    .describe('Codex-only sandbox mode (ignored by other adapters).'),
  caller_session_id: z.string().min(1).max(128)
    .describe('Required: the session id of the calling agent. In-process transport overrides this with the closure-injected real session id.'),
  parent_session_id: z.string().min(1).max(128).optional()
    .describe('Optional: the parent session id for depth tracking. Defaults to caller_session_id when omitted.'),
}),
returns: { sessionId: string, adapter: string, cwd: string, teamName: string | null }
```

**handler 行为**：
1. 校验 caller（详 §5 + §6 防递归 4 条规则）
2. **先**调 `sessionRepo.setSpawnLink(reservedId, parentSid, parentDepth + 1)` 占位写入 spawn_chain（与 fan-out check 同步原子段，详 §6.6）
3. 调 `adapterRegistry.get(adapter).createSession({ cwd, prompt, permissionMode, codexSandbox, teamName })`
4. 若 `team_name` 非空 → `sessionManager.recordCreatedTeamName(sid, teamName)`（与现有 IPC `agent-deck new --team` 入口同款）
5. 返回 `{ sessionId, adapter, cwd, teamName }`（失败 throw + 返回 isError；spawn_chain 占位行需回滚）

**与 task-manager 的边界**：spawn 后**不**自动 send_message —— prompt 已在 createSession 内塞进首条 user message。

### 3.2 `send_message`

```ts
inputSchema: z.object({
  session_id: z.string().min(1).max(128).describe('Target session id.'),
  text: z.string().min(1).max(100_000).describe('User message text (1-100KB).'),
  caller_session_id: z.string().min(1).max(128).describe('Required: the session id of the calling agent.'),
}),
returns: { sessionId: string, queued: boolean }
```

**handler 行为**：
1. 校验 caller
2. session 必须存在 + lifecycle ≠ closed
3. 调 `adapter.sendMessage(session_id, text)`（与 IPC 路径同款）
4. **不**等 reply，立即返回（要等 reply 调 wait_reply）

### 3.3 `wait_reply`

```ts
inputSchema: z.object({
  session_id: z.string().min(1).max(128),
  until: z.enum(['first_message', 'turn_complete', 'idle']).default('idle')
    .describe('first_message = next assistant message; turn_complete = next finished event; idle = no events for idleQuietMs (tuned by app settings, see B`6).'),
  timeout_ms: z.number().int().min(1000).max(600_000).default(60_000)
    .describe('Hard timeout (1s-600s, default 60s). On timeout returns partial messages collected so far.'),
  since_ts: z.number().int().min(0).optional()
    .describe('Only collect events with ts > since_ts. Default = caller wall-clock at handler entry. Use to avoid re-collecting already-seen messages.'),
  caller_session_id: z.string().min(1).max(128),
}),
returns: {
  sessionId: string,
  until: 'first_message' | 'turn_complete' | 'idle',
  timedOut: boolean,
  aborted: boolean,                                 // true 仅当 caller 通过 SDK abortSignal 中断
  events: Array<{ kind, ts, text?, summary? }>     // 按 kind 投影，剥离 sensitive payload
}
```

#### 3.3.1 三档 until 语义详解

| until | 完成条件 | 典型用途 |
|---|---|---|
| `first_message` | session 出现第一条 `kind: 'message'` 事件（assistant 文字）即返回 | lead 想拿 teammate 第一句回复就走（最快） |
| `turn_complete` | session 出现 `kind: 'finished'` 事件 OR `waiting-for-user` 事件即返回 | 等 teammate 完整回合结束（含 thinking/tool-use 全跑完）；**xhigh reasoning / opus 高 reasoning effort 场景推荐用这档**（thinking 间隔可能 >5s 触发 idle 误判） |
| `idle` | session 在 idleQuietMs 内没有任何新事件即返回（默认 5s）| 等 teammate 整体停止 / 进入 idle 状态（最稳，最慢） |

`idleQuietMs` 默认 5s，可在 settings 里配（B'6）；不暴露给 tool args（避免 prompt 注入打死循环）。

#### 3.3.2 超时语义

- `timed_out: true` 时仍返回 events 数组（partial 收集，不抛错）
- 超时不影响 session 自身（不 abort 不 interrupt）—— wait_reply 仅是观察者
- 默认 60s，上限 600s（10 min）—— 防止 LLM 用 `timeout_ms: Infinity` 卡死 tool handler

#### 3.3.3 中断语义

被 caller 通过 SDK abortSignal 中断时 → 返回当前已收集 events + `timedOut: false` + `aborted: true`；不抛错（不让 caller 整个 query 失败）。`aborted` 字段已在 §3.3 returns schema 中声明。

#### 3.3.4 并发 wait_reply（同 session）+ since_ts 语义

**问题**：多个 caller 用不同 `since_ts` 同时 wait_reply 同一 session 时，简单共享单一 promise 会让后来者漏收 `[since_ts, promise_creation_ts)` 区间历史事件。

**解决方案**（reviewer 双对抗 HIGH-2 修法）：

1. **promise key**：`${sessionId}:${until}:${idleQuietMs}`（不含 timeout_ms / since_ts）
2. **promise 内部 collect 起始 ts** = `baseline_ts = Date.now()`（promise 首次创建瞬间），coordinator 在 promise resolve 时返回 `{ baseline_ts, events: collected_after_baseline }`
3. **每个 caller** 在 promise resolve 后做两步合并：
   ```ts
   const sinceTs = args.since_ts ?? handlerEntryTs;  // 默认 = handler 入口时间
   const backfill = sinceTs < baseline_ts
     ? eventRepo.list({ sessionId, fromTs: sinceTs, toTs: baseline_ts })  // 回查历史
     : [];
   const live = collected_after_baseline.filter((e) => e.ts > sinceTs);   // 二次 filter
   return { events: [...backfill, ...live] };
   ```
4. **timeout** 通过 `Promise.race(coordinatorPromise, sleep(timeout_ms))` 在 caller 一侧独立处理；超时时仍走 backfill + filter 两步合并，partial events 不丢

**Coordinator 资源**：promise resolve 后清掉 key（下一个 caller 重建新 promise，从下一波事件开始等）。`baseline_ts` 由 coordinator 在创建 promise 时记录并随 promise 状态一起暴露。

**eventRepo 查询要求**：`eventRepo.list({ sessionId, fromTs, toTs })` 接口需要 B'2.b 实施时校验是否已有；没有则补一个（应该已有，event-repo.ts 现有 `listBySession` 类方法）。

### 3.4 `list_sessions`

```ts
inputSchema: z.object({
  caller_session_id: z.string().min(1).max(128),
  status_filter: z.enum(['active', 'dormant', 'closed', 'all']).default('active'),
  adapter_filter: z.enum(['claude-code', 'codex-cli', 'aider', 'generic-pty']).optional(),
  spawned_by_filter: z.string().min(1).max(128).optional(),  // REVIEW_28 E 段
  limit: z.number().int().min(1).max(200).default(50),
}),
returns: { total: number, sessions: Array<{ sessionId, adapter, cwd, lifecycle, title, lastEventAt, teamName, spawnedBy, spawnDepth }> }
```

**字段说明**：
- `adapter` 字段值 = `SessionRecord.agentId`（adapter id 与 agent id 字符串值同源，如 `'claude-code'` / `'codex-cli'` / `'aider'` / `'generic-pty'`）
- `spawnedBy` / `spawnDepth` 来自新增的 sessions.spawned_by / spawn_depth 列（详 §6.5）
- `spawned_by_filter`（REVIEW_28 E 段）：仅返回 `spawnedBy === <filter>` 的 session；典型场景是 lead 用 `spawned_by_filter:<self_session_id>` 反查自己 spawn 的所有 child（如 deep-code-review SKILL 在 lead context 重置后捡起 stranded reviewer teammate）。**信任边界**：不做 ownership 校验，与现状 list_sessions 单用户 app-wide 信任域一致；任何 caller 可查任意 spawnedBy id。

**handler 行为**：
1. 校验 caller
2. 调 `sessionManager.list({ status, adapter, limit })`
3. 在 `slice(limit)` 前应用 `spawned_by_filter`（避免大 lead 反查少量 children 时被 limit cutoff 误报空列表）
4. 投影出 metadata（不含 events / messages，复用 §3.5 `projectSession`）

**只读，不走防递归限流；但仍要求 caller_session_id 用于审计 / 后续拓扑可视化。**

### 3.5 `get_session`（REVIEW_28 F 段）

```ts
inputSchema: z.object({
  caller_session_id: z.string().min(1).max(128),
  session_id: z.string().min(1).max(128),
}),
returns: { sessionId, adapter, cwd, lifecycle, title, lastEventAt, teamName, spawnedBy, spawnDepth }  // 同 list_sessions 单 session 投影
```

**handler 行为**：
1. 校验 caller
2. `sessionRepo.get(session_id)` 不存在 → `isError` + hint「Use list_sessions to discover ids」
3. 投影出 metadata（**复用同一份 `projectSession`** 与 list_sessions，避免 raw SessionRecord 暴露 / future visibility predicate 加在一处即两 tool 同步生效）

**典型场景**：lead 已持有从 spawn_session 返回的 sessionId，调 `get_session` 直接拿 receiver 的 lifecycle / lastEventAt 判断「投递 failed 是 receiver closed 还是还没回复」（vs `list_sessions` 大海捞针）。

**信任边界**：与 `list_sessions` 一致 —— 单用户 app-wide read，无 ownership 校验。如果未来引入 multi-user / per-team 隔离，必须在 `projectSession` 加 visibility predicate 让两 tool 同步生效。

### 3.6 `shutdown_session`

```ts
inputSchema: z.object({
  session_id: z.string().min(1).max(128),
  caller_session_id: z.string().min(1).max(128),
  reason: z.string().max(500).optional()
    .describe('Optional human-readable reason logged to events table.'),
}),
returns: { sessionId: string, lifecycle: 'closed' }
```

**handler 行为**：
1. 校验 caller（caller 不能 shutdown 自己 —— 防止 LLM 误调死循环）
2. 调 **`sessionManager.close(session_id)`**（**不**调 `delete`）—— 该方法需在 B'1 前补：
   - 调 adapter.closeSession（已有：abort SDK live query + 清 pending Maps）
   - `sessionRepo.setLifecycle(id, 'closed', Date.now())`（已有 setLifecycle 方法）
   - emit `session-end` event
   - **不**删 sessions 行 + **不**触发 ON DELETE CASCADE → events / file_changes / summaries 全部保留
3. 返回 `{ sessionId, lifecycle: 'closed' }`

**为什么不调 `delete`？**（reviewer 双对抗 HIGH-4 修法）

`sessionRepo.delete` 是 hard-delete（`DELETE FROM sessions WHERE id = ?`，session-repo.ts:322），加上 v001_init.sql 的 `ON DELETE CASCADE` 会把 events / file_changes / summaries 全部级联删掉。在 deep-code-review 等场景中 lead 还要在 reviewer shutdown 后引用 reviewer 输出做三态裁决，hard-delete 致命。改为 lifecycle=closed 保留所有数据，与现有 LifecycleScheduler 的「自动 closed → 历史保留 N 天 → 才物理删除」节奏一致。

**自我保护**：caller_session_id === session_id ⇒ deny（return isError）。让 lead 主动结束自己的入口走 IPC / UI（强行 shutdown 自己会导致 SDK 子进程下面的 wait_reply 拿不到任何后续事件）。

---

## 4. Caller-id 注入策略（spike-B'-caller-id 已确认）

`@anthropic-ai/claude-agent-sdk` 的 `tool()` handler 第二参数 `extra: unknown` 不暴露稳定 caller schema。所以 caller_session_id 必须由 application layer 强制提供 —— 三 transport 各自策略：

### 4.1 in-process（B'3）

```ts
// sdk-bridge/index.ts 在 spawn 前
const tools = await buildAgentDeckTools({
  ...,
  callerSessionIdProvider: () => internal.realSessionId ?? tempKey,  // closure
});
```

handler 内：

```ts
async (args, _extra) => {
  const callerFromClosure = callerSessionIdProvider();
  // closure 强制覆盖（无视 args.caller_session_id 防止 prompt 注入伪造）
  const caller: CallerContext = {
    callerSessionId: callerFromClosure,
    parentSessionId: args.parent_session_id ?? callerFromClosure,
    transport: 'in-process',
  };
  // depth 在 §6 防递归校验时从 sessionRepo.getSpawnDepth(callerFromClosure) 反查
  // ...
}
```

**安全性**：LLM 即便在 prompt 里被注入「调 `spawn_session(caller_session_id: 'fake-id')`」，handler 从 closure 拿真实 id，args 字段被忽略。

### 4.2 HTTP（B'4）

handler 内：

```ts
// 1. args.caller_session_id 必填（zod 已校验）
// 2. Authorization header 仅做认证（Bearer mcpServerToken 校验，详 §5），
//    不携带 caller sessionId 信息 → caller 鉴别完全依赖 args.caller_session_id + sessionManager 反查
// 3. handler：从 args.caller_session_id 反查 sessionManager.get(id)
const caller: CallerContext = {
  callerSessionId: args.caller_session_id,
  parentSessionId: args.parent_session_id ?? args.caller_session_id,
  transport: 'http',
};
const session = sessionManager.get(caller.callerSessionId);
if (!session) {
  return err(`unknown caller_session_id: ${caller.callerSessionId}`);
}
if (session.lifecycle === 'closed') {
  return err(`caller_session_id ${caller.callerSessionId} is closed`);
}
// 注：dormant 视为 valid caller —— 用户切走但 session 未关，仍是合法实体
```

**安全性**：HTTP transport 只对**已知 sessionId** 的调用方放行。攻击者必须先知道某个有效 sessionId 才能伪造身份；agent-deck 的 sessionId 是 UUIDv7 + DB 内部生成，外部无法枚举。

### 4.3 stdio（B'1 同时落）

同 HTTP（args 必填 + 反查）。无 Authorization header（stdio 父进程隐式信任），但仍需 sessionId 反查。

stdio 用例：用户在 Cursor / Continue / 任何 stdio MCP client 里挂 agent-deck-mcp，Cursor 不知道自己的 sessionId（不在 agent-deck 注册）—— 这种「外部 client」 caller_session_id **必须传 `'__external__'` 字面量**（zod 加 special-case）。`__external__` caller 默认 deny spawn_session（防递归保险），仅允许 list_sessions / wait_reply 只读类操作。

> **FAQ**：「为什么 stdio 不允许外部 client spawn？」—— 因为外部 client 不在 agent-deck SessionManager 内，没有 sessionId 链路就没法做 depth / fan-out 限流（详 §6），fork bomb 风险无法收敛。如果用户想让外部工具起 agent-deck session，请用 HTTP transport + 提前在 Settings 里建一个「external-bridge」session 当 caller。

---

## 5. 鉴权层

### 5.1 HookServer onRequest 扩展

```ts
// src/main/hook-server/server.ts:29-51 现有 hook auth + 加 /mcp 分支
this.app.addHook('onRequest', async (request, reply) => {
  if (request.url.startsWith('/hook/')) {
    return checkHookToken(...);
  }
  if (request.url.startsWith('/mcp')) {
    return checkMcpToken(...);  // 用独立 token，与 hook token 不同
  }
});
```

### 5.2 MCP token 来源

新增 settings 字段 `mcpServerToken: string | null`（与 `hookServerToken` 同生成模式：首次启动自动 32 字节 hex）。

**为什么独立 token？**
- hook token 嵌进每个 CLI 子进程 spawn 时的 hook 命令，泄漏面广（settings.json / 各 cwd 的 .claude/）
- MCP token 仅嵌进 codex `~/.codex/config.toml` 的 mcp_servers 段（B'4）+ Settings UI 显示给用户复制（外部 MCP client 用），泄漏面窄
- 一旦 hook token 泄漏，MCP 通道仍安全；反之亦然

### 5.3 in-process 不走 token（同进程闭包）

`createSdkMcpServer` 注册的 server 在 SDK query() 内部直接走 closure，不经过 HTTP，不需要 token。

---

## 6. 防递归 3 条规则（B'5 + REVIEW_28 移除 §6.2）

### 6.1 depth 上限

- spawn_session 调用时 handler 内：
  ```ts
  // 从 caller_session_id 反查 sessionRepo 的 spawn_chain（详 §6.5 schema）
  const parentDepth = sessionRepo.getSpawnDepth(caller.callerSessionId);  // 默认 0
  if (parentDepth >= MAX_DEPTH) return err(`spawn depth ${parentDepth} >= max ${MAX_DEPTH}`);
  // 记录新 session 的 depth = parentDepth + 1
  ```
- `MAX_DEPTH` 默认 3（lead → teammate → sub-teammate → leaf 三层够用），可在 settings 配（`mcpMaxSpawnDepth`，1-10）

### 6.2 ~~同 cwd realpath 比较~~（**2026-05 移除**，REVIEW_28）

> **状态**：~~已移除~~（2026-05，详 reviews/REVIEW_28.md）。本节保留编号避免影响 §6.3-§6.6 引用与 §10 V11 / V20 历史用例编号；新会话不再触发 cwd cycle 检测。
>
> **原意图**：防 lead 在同 cwd 用同 adapter spawn 自己 / 整链祖先 cycle。
>
> **移除原因**：原规则把 `deep-code-review` SKILL（lead 在 repo 起两个 reviewer teammate 同 cwd 同 adapter）等真实合法用例一并 deny，与 SKILL 设计直接冲突；同时 §6.1 depth + §6.4 fan-out + §6.3 spawn-rate 三条已构成有界资源覆盖。
>
> **覆盖范围说明**（**不是「完全等价覆盖」**）：移除后残留「语义自递归」（lead 同 cwd 同 adapter 反复 spawn 同款任务）由 §6.1 depth=3 截断接受 —— 最多 3 层 spawn 即停。三条剩余 guard 覆盖**数量上界**（fan-out 5 / depth 3 / 极端 5+25+125=155 descendants），**不**单独覆盖语义重复执行；如未来需要侦测异常重复 spawn 模式，可加非阻断 telemetry warning，但不应作为 deny 规则恢复（避免再次拦合法 SKILL 用例）。

### 6.3 per-app spawn-rate（应用级全局限流）

- 滑动窗口：`mcpSpawnRatePerMinute` 默认 **10**（spawn / minute；reviewer 双对抗 MED 修法：原 5 偏紧，留并行 deep-review buffer）
- 跨所有 caller 累计；触顶 ⇒ deny + 返回 `retry_after_ms`
- 用 `RateLimiter` class（自管 timestamp Array + 过期裁剪）
- **顺序约束**（REVIEW_28 reviewer-codex MED-1 修法）：rate token **必须**在 §6.1 depth + §6.4 fan-out 都通过后才扣 (`tryConsume()` 放最后)。否则一个已达 fan-out=5 的 lead spam spawn_session 时会先消耗 app-wide token，把 quota 拒掉给别的合法 lead → 饥饿。当前实现见 `spawn-guards.ts applySpawnGuards`。

### 6.4 per-parent fan-out

- 同一 caller_session_id 的当前 active children 数：`sessionManager.list({ spawnedBy: callerSessionId, lifecycle: 'active' }).length`
- 上限 `mcpMaxFanOutPerParent` 默认 5；触顶 ⇒ deny
- **极端规模**（depth=3 / fan-out=5 全开）：lead 自身 + descendants = 1 + (5 + 25 + 125) = **156 live session**。spawn-rate=10/min 限制创建速度（156 个最快也要 ~16 分钟铺满），spawn 完成后 spawn-rate 不再卡，存量靠 fan-out + depth 兜底

### 6.5 spawn chain 持久化（DB schema + repo API 实施清单）

#### 6.5.1 DB schema

- migration `v009_mcp_spawn_chain.sql`：
  ```sql
  ALTER TABLE sessions ADD COLUMN spawned_by TEXT REFERENCES sessions(id) ON DELETE SET NULL;
  ALTER TABLE sessions ADD COLUMN spawn_depth INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX idx_sessions_spawned_by ON sessions(spawned_by);
  ```
- `ON DELETE SET NULL` 在 §3.5 改 lifecycle=closed 后**永远不触发**（兜底策略，万一未来真删才用）

#### 6.5.2 repo / manager API 必须扩的清单（B'2.a 前必做）

> 这是 R2 实施前置硬性要求。reviewer 双对抗 HIGH-3 修法：rename 路径已经存在 latent bug（v008 codex_sandbox 漏列），R2 加 spawn_depth/spawned_by 必须一并修。

1. **`session-repo.ts:60-92` `upsert`**：INSERT 列名清单与 ON CONFLICT UPDATE 子句**同时**加 `spawned_by` 与 `spawn_depth`，并补 `codex_sandbox`（v008 既有 latent bug 顺手修）
2. **`session-repo.ts:273-291` `rename` 的 `toExists=false` 分支 INSERT**：列名 + ? 占位符同步加 `spawned_by` / `spawn_depth` / `codex_sandbox`（务必 ? 数与列数一致，CHANGELOG_35 踩过 14 vs 13 列错位的坑）
3. **`session-repo.ts:rename` 的 `toExists=true` 分支**：仿现有 team_name / permission_mode 「OLD 覆盖 NEW」逻辑，增加 spawned_by / spawn_depth 的覆盖 UPDATE
4. **新增 `sessionRepo.getSpawnDepth(id: string): number`**：单查 sessions.spawn_depth；session 不存在返回 0（兜底）
5. **新增 `sessionRepo.setSpawnLink(id: string, parentId: string, depth: number): void`**：UPDATE sessions SET spawned_by, spawn_depth WHERE id=?；handler 在 createSession 前可先调（reserve 模式，详 §6.6）
6. **`session-repo.ts` 加 `ListOptions { agentId?, lifecycle?, spawnedBy?, limit?, offset? }`**：替代现有 `listActiveAndDormant`，由 `sessionManager.list` 透传给上层；老 `listActiveAndDormant` 标 deprecated 不删（避免改动现有 47 个调用点）
7. **新增 `sessionManager.close(id): Promise<void>`**：调 adapter.closeSession + sessionRepo.setLifecycle(id, 'closed') + emit session-end；**不**调 sessionRepo.delete（与 §3.5 修法 lifecycle=closed 配套）
8. **`session-repo.ts:rowToRecord` + `SessionRecord` type**：加 `spawnedBy?: string | null` / `spawnDepth: number` 字段映射

> 实施编排：8 项改动放进 B'1 同 commit（"transport + repo 扩展" 一起落），让 B'2.a 实施时这些 API 已就绪。

### 6.6 Race Protection（reviewer 双对抗 MED 修法）

防 LLM 单回合并发 N 个 spawn_session 穿透 fan-out / spawn-rate 上限（MCP 允许 parallel tool_use）：

- **per-caller spawn-mutex**：以 caller_session_id 为 key 的同步段。Node.js event loop 单线程，**先 reserve 后 await**：
  ```ts
  // 同步 reserve（fan-out check + setSpawnLink 占位行 INSERT）
  const counter = inFlightChildren.get(callerSid) ?? 0;
  if (counter + sessionsLive >= MAX_FAN_OUT) return err(...);
  inFlightChildren.set(callerSid, counter + 1);
  const reservedId = generateUuidV7();
  sessionRepo.setSpawnLink(reservedId, callerSid, depth);  // 占位写入

  try {
    // 异步 await
    await adapterRegistry.get(adapter).createSession({...});  // 用 reservedId
  } catch (e) {
    sessionRepo.delete(reservedId);  // 回滚占位（这里用 hard-delete 因为占位行无子表数据）
    throw e;
  } finally {
    inFlightChildren.set(callerSid, (inFlightChildren.get(callerSid) ?? 1) - 1);
  }
  ```
- **RateLimiter inc + check 同步段**：rateLimiter.tryConsume() 内部 `if (timestamps.length >= limit) return false; timestamps.push(now); return true;` 必须同步无 await
- **createSession 接收 reservedId**：adapter 接口加 optional `presetSessionId?: string` 参数（claude-code 已有同款 tempKey 模式），让 spawn-mutex reserve 的 id 直传；其他 adapter 不实现则 spawn-mutex 退化到「createSession 后写 setSpawnLink」（race window 短，可接受）

> Note：reservedId 选 UUIDv7（与 sessionRepo 现有 id 生成同款）。adapter `createSession` 内部如果生成自己的 sessionId 会与 reservedId 冲突 —— claude-code/codex-cli 都用 SDK 返回的真实 id，应用层 reservedId 仅作 spawn_chain 占位，真实 id 通过现有 rename 机制覆盖（rename 路径已在 §6.5 实施清单 #2-3 修过 spawn_depth/spawned_by 列）。

---

## 7. Settings 字段（汇总 B'5 / B'6）

新增字段：

```ts
// src/shared/types/settings.ts
interface AppSettings {
  // ... 既有
  enableAgentDeckMcp: boolean;        // 总开关（默认 false，与 enableTaskManager 同模式）
  mcpServerToken: string | null;      // HTTP / stdio transport token
  mcpHttpEnabled: boolean;            // HTTP /mcp 路由开关（默认 true，配 codex 自动注入用）
  mcpStdioEnabled: boolean;           // stdio 子命令开关（默认 false，仅外部用户主动开）
  mcpMaxSpawnDepth: number;           // 默认 3，范围 [1, 10]（reviewer LOW: 用户调高时配合 §6.2 整链回溯防 cycle）
  mcpSpawnRatePerMinute: number;      // 默认 10，范围 [1, 60]（reviewer MED 修法：原 5 偏紧，并行 deep-review 留 buffer）
  mcpMaxFanOutPerParent: number;      // 默认 5，范围 [1, 20]
  mcpWaitReplyIdleQuietMs: number;    // 默认 5000，范围 [1000, 60000]
}
```

DEFAULT_SETTINGS 同步加默认值。

**与既有开关的关系**：
- `enableAgentDeckMcp` OFF → in-process 不挂 + HTTP 路由 401 + stdio 子命令报「未启用」 + Codex config.toml 自动剥离 mcp_servers.agent_deck 段
- `enableAgentDeckMcp` ON 但 `mcpHttpEnabled` OFF → 仅 in-process 给 claude（codex 没法连）
- 关掉只影响**下次新建会话**（B'3 注入是 spawn-time，与 enableTaskManager 同模式）；HTTP 路由 hot-toggle 立即生效

> **Future**：`mcpStdioAllowExternalSpawn: boolean`（§11.1 争议条目）—— 若用户呼声足，下一轮加

---

## 8. 替代老 Claude builtin team tools 的语义映射（用户文档）

> 给 `deep-code-review` skill 重写（R3.E11）+ 用户在 Claude 会话内手起 team 用，本节是用户视角文档。

| 老 Claude builtin tool | 新 agent-deck-mcp 调用 | 备注 |
|---|---|---|
| `TeamCreate({ team_name, agent_type })` | （不直接对应）由 `spawn_session` 隐式建 team —— 多个 spawn_session 共享同一 `team_name` arg 即可 | R3.E 之前 `team_name` 是 spawn_session 可选 arg；R3.E 上线后 team 由 agent-deck-mcp `create_team` 显式建（届时本表更新） |
| `Agent({ subagent_type: 'reviewer-claude', team_name: 'X', name: 'r1', ... })` | `spawn_session({ adapter: 'claude-code', cwd, prompt: '<reviewer-claude prompt>', team_name: 'X' })` | adapter 字段决定底层 runtime；prompt 字段塞 reviewer agent body |
| `Agent({ subagent_type: 'reviewer-codex', ... })` | `spawn_session({ adapter: 'codex-cli', cwd, prompt: '<reviewer-codex prompt>' })` | 异构 reviewer 用不同 adapter 自然实现 |
| `SendMessage({ to: 'r1', message: '...' })` | `send_message({ session_id: '<spawn 返回的 sid>', text: '...' })` | session_id 来自 spawn_session 返回 |
| 等 teammate idle 通知（自动） | `wait_reply({ session_id, until: 'idle', timeout_ms: 60000 })` | 显式 polling，不再隐式通知 |
| `SendMessage({ to: 'r1', message: { type: 'shutdown_request', ... } })` | `shutdown_session({ session_id })` | 不再通过协议消息传 shutdown，直接 tool 调用 |
| `TeamDelete()` | （不直接对应）所有 spawn 出来的 session 各自 `shutdown_session` 即可 | R3.E 上线后 `delete_team` 显式删 team metadata |

### 8.1 deep-code-review skill 调用范例（R3.E11 落地后样子）

```
1. spawn reviewer-claude:
   mcp__agent_deck__spawn_session(
     adapter='claude-code', cwd=$REPO,
     prompt='你是 reviewer-claude... <agent body 全文>',
     team_name='deep-review-2026-05-11')
   → returns { sessionId: 'sess-claude-1' }

2. spawn reviewer-codex:
   mcp__agent_deck__spawn_session(
     adapter='codex-cli', cwd=$REPO,
     prompt='你是 reviewer-codex... <agent body 全文>',
     team_name='deep-review-2026-05-11')
   → returns { sessionId: 'sess-codex-1' }

3. 等两个 reviewer 各自出第一条结论：
   parallel:
     mcp__agent_deck__wait_reply(session_id='sess-claude-1', until='turn_complete', timeout_ms=300000)
     mcp__agent_deck__wait_reply(session_id='sess-codex-1', until='turn_complete', timeout_ms=300000)

4. lead 自己做三态裁决（不调 tool）

5. 反驳轮：
   mcp__agent_deck__send_message(session_id='sess-codex-1', text='reviewer-claude 提出 X，请反驳...')
   mcp__agent_deck__wait_reply(session_id='sess-codex-1', until='turn_complete', timeout_ms=180000)

6. 收尾：
   mcp__agent_deck__shutdown_session(session_id='sess-claude-1')
   mcp__agent_deck__shutdown_session(session_id='sess-codex-1')
```

---

## 9. 命名 / 文件布局

```
src/main/agent-deck-mcp/
├── server.ts                     # B'1 顶层入口（per-session in-process / 全局 HTTP / stdio 三 factory）
├── tools.ts                      # B'2.a 6 tool 注册 + handler（REVIEW_28 加 get_session）
├── wait-reply-coordinator.ts     # B'2.b promise dedup + idle 检测 + backfill 合并
├── caller-context.ts             # §4 三 transport caller 提取
├── rate-limiter.ts               # B'5 滑动窗口 + per-parent
├── transport-http.ts             # B'1 HTTP transport (fastify integration)
├── transport-stdio.ts            # B'1 stdio transport (cli.ts 子命令调)
└── __tests__/
    ├── tools.test.ts
    ├── wait-reply-coordinator.test.ts
    └── rate-limiter.test.ts

src/main/store/migrations/
└── v009_mcp_spawn_chain.sql     # §6.5.1 spawned_by + spawn_depth 列

src/main/store/session-repo.ts   # §6.5.2 #1-#6 + #8：upsert/rename 扩列 + getSpawnDepth/setSpawnLink + ListOptions + rowToRecord 字段映射 + 顺手修 v008 codex_sandbox 漏列
src/main/session/manager.ts      # §6.5.2 #7：新增 close(id) 方法（lifecycle=closed 而非 delete）

src/main/cli.ts                   # +mcp 子命令（B'1 stdio 入口）
src/main/hook-server/server.ts    # B'1/B'5 /mcp 路由 + 鉴权扩展
src/shared/types/settings.ts      # §7 新字段
src/main/adapters/claude-code/sdk-bridge/index.ts  # B'3 in-process 注入位
src/main/codex-config/agent-deck-mcp-injector.ts   # R1.A5 + B'4 codex config 写入
src/main/codex-config/runtime-config-merger.ts     # R1.D7 runtime config 副本
src/renderer/components/settings/sections/AgentDeckMcpSection.tsx  # B'6 UI
docs/agent-deck-mcp-protocol.md   # 本文件
```

---

## 10. 验证清单

R2 完成后必须全过：

| ID | 验证项 | 期望 |
|---|---|---|
| V1 | 启动 dev / 已装 .app + Settings 开 `enableAgentDeckMcp` + 启 claude session → console 见 `[agent-deck-mcp] in-process attached for sid=...` | ✅ |
| V2 | 同上 claude session 内调 `mcp__agent_deck__list_sessions(caller_session_id='<sid>')` → 返回当前所有 session metadata | ✅ |
| V3 | 同上 调 `mcp__agent_deck__spawn_session(adapter='codex-cli', cwd='/tmp', prompt='ping')` → 起 codex session + UI 看到新 session 卡片 | ✅ |
| V4 | 紧接调 `mcp__agent_deck__wait_reply(session_id='<codex sid>', until='first_message', timeout_ms=60000)` → 60s 内拿到 codex 第一条文字 | ✅ |
| V5 | `curl 127.0.0.1:47821/mcp -X POST -d '...'` 不带 token → 401 | ✅ |
| V6 | 带正确 token → MCP `initialize` 返回 server info | ✅ |
| V7 | codex 会话 list_mcp_tools 见 `mcp__agent_deck__*` 6 个 | ✅ (R1.A5 + REVIEW_28 加 get_session) |
| V8 | 故意构造 `caller_session_id` 不存在 → handler 拒 + 返回 isError | ✅ |
| V9 | 故意 LLM 在 in-process 内伪造 `caller_session_id` 字段 → 仍按 closure 真实 id 处理（log 出现 override warn）| ✅ |
| V10 | depth=4 spawn → deny 「spawn depth 3 >= max 3」 | ✅ |
| V11 | ~~同 cwd + 同 adapter spawn 自己 → deny~~ | ❌ obsolete (REVIEW_28：§6.2 移除，same-cwd same-adapter 现在是合法路径) |
| V12 | 1 分钟内连 spawn 6 次 → 第 6 次 deny + retry_after_ms ≈ 60000 | ✅（注意 REVIEW_28：rate token 在 fan-out 通过后才扣，此用例需用不会撞 fan-out 的 caller 触发）|
| V13 | 同一 caller spawn 6 个 child → 第 6 次 deny 「fan-out 5 reached for parent X」 | ✅（REVIEW_28：fan-out deny 不消耗 spawn-rate token） |
| V14 | wait_reply 同 session 并发 2 caller → 共享 promise（log 见 `[wait-reply] reuse promise key=...`）+ 两个 caller 同时收到 reply | ✅ |
| V15 | wait_reply 超时返回 partial events + `timed_out: true`，session 不被 abort | ✅ |
| V16 | shutdown_session(self) → deny 「cannot shutdown self」 | ✅ |
| V17 | shutdown_session(other) → 该 session lifecycle=closed + sessions.events / file_changes / summaries 仍存在 + UI 看到 closed 标记（不消失）| ✅ |
| V18 | `enableAgentDeckMcp=true` + `mcpStdioEnabled=false` 跑 `agent-deck mcp` → 报「未启用」错误退出 | ✅ |
| V19 | wait_reply caller A (since_ts=t1) + caller B (since_ts=t2 > t1) 并发同 session → 各自 events 数组按 since_ts 切片，A 拿到的 ts 集合包含 B 的 ts 集合 | ✅ |
| V20 | ~~4 层 spawn cycle（lead@/repo → child@/sub → grandchild@/repo, 同 adapter）→ deny~~ | ❌ obsolete (REVIEW_28：§6.2 整链回溯移除；同款 4 层 cycle 现在仅由 §6.1 depth 截断（depth=4 >= max=3 时 deny）) |
| V21 | `pnpm typecheck` + `pnpm vitest run`（新增 wait-reply / rate-limiter / tools 单测全过）| ✅ |
| V22 | `list_sessions(spawned_by_filter:'<lead-sid>')` → 返回该 lead 的所有 children 投影 | ✅ (REVIEW_28 E 段) |
| V23 | `get_session(session_id:'<sid>')` → 返回单 session 投影（含 lifecycle / lastEventAt 等）；不存在 sid 返回 isError | ✅ (REVIEW_28 F 段) |
| V24 | fan-out=5 撞顶后 spam 5 次 spawn → 全 deny + spawn-rate quota 未消耗（别的 lead 仍能正常用 quota） | ✅ (REVIEW_28 reviewer-codex MED-1 修法验证) |

---

## 11. 已知争议 / 待 review 决策（需要双对抗确认）

### 11.1 stdio external caller 一刀切 deny spawn 是否过激？

**正方**：fork bomb 风险无法收敛，stdio 父进程身份完全黑盒，安全保守。
**反方**：用户有合理需求（Cursor 内挂 agent-deck-mcp 起 reviewer session 跑 review）。

**当前裁决**：默认 deny；后续如有用户呼声，加 setting `mcpStdioAllowExternalSpawn: boolean` + 全局更严格的 spawn-rate（如 1/分钟）。

### 11.2 caller_session_id 在 in-process 是否真的应该 closure 强制覆盖？

**正方**：防 prompt 注入伪造身份。
**反方**：lead 内 LLM 想代理另一个 session 调 tool（如「以 reviewer-1 名义给 reviewer-2 send_message」）合法用例被堵死。

**当前裁决**：closure 强制覆盖。需要代理调用的场景是 R3.E 阶段 team 抽象的事，不在 R2 范围。

### 11.3 send_message 是否应该返回 reply？

**正方**：单调用做完更省 prompt。
**反方**：MCP 是 request/response 同步模型，等 reply 必须阻塞，已经被 wait_reply 覆盖；混在一起增加复杂度 + 超时语义割裂（send_message timeout vs wait_reply timeout）。

**当前裁决**：拆分。send_message 立即返回，wait_reply 显式等。

### 11.4 wait_reply 的 idleQuietMs 是否应该 per-call 可调？

**正方**：不同场景需要的 idle 阈值不同（reviewer 长 thinking ≠ 简单 ping）。
**反方**：暴露给 prompt 增加打死循环面（设极大 idle 让 wait_reply 永远 hold）。

**当前裁决**：不暴露；改用 timeout_ms 上限 600s 控制最坏情况；idleQuietMs 由 Settings 全局配（B'6）。

### 11.5 spawn_chain DB schema 是否值得加？

**正方**：防递归 §6.1 / §6.4 必须依赖 spawn_depth + 父子关系；无 schema 只能内存 Map（重启丢失，无法跨进程一致）。
**反方**：sessions 表加 2 列影响所有 sessions 查询路径；migration 风险。

**当前裁决**：加。spawn_depth/spawned_by 是 R2 防递归基础，没有这两列防递归 4 条规则有 2 条无法实施。Migration 风险通过 ALTER TABLE ADD COLUMN（DEFAULT NULL/0）控制，且 §6.5.2 实施清单 #1-#3 同时修补 upsert / rename 路径列表，避免 SDK fallback 路径写新行时漏列。

### 11.6 默认 `mcpMaxSpawnDepth=3` vs `4`

**正方（取 3）**：plan v3 §8.1 deep-code-review 范例只用 1 层（lead → reviewer-pair）；3 层够大多数场景；过深会让 fork bomb 自我节流前先打到 fan-out 上限，纵深防御。
**反方（取 4）**：hierarchical 4 层（lead → orchestrator → reviewer-pair → fix-agent）合理用例被堵；用户调高需进 Settings UI 改值，不直觉。

**当前裁决**：取 3 + Settings UI 暴露调到 [1, 10]；hierarchical 用例如果被用户呼声反馈再考虑上调默认。

### 11.7 stdio 已知 sessionId 冒充攻击

**问题**：单用户信任域下，本机进程 X 知道有效 sessionId 即可冒充该 session 调 stdio MCP；若 X 知道多个 sessionId，可绕过 per-parent fan-out 累积攻击（每个 ID 起 5 个 child = 25 sessions）。

**正方（接受）**：单用户信任域，本机攻击者已经能 SQL 直接读 sessionId；per-app spawn-rate（10/min）仍生效，时间锁兜底。
**反方（缓解）**：stdio 强制 `__external__` caller，禁止已有 sessionId 冒充。

**当前裁决**：接受（单用户信任域 + spawn-rate 兜底）。如果以后引入 multi-user / 共享桌面场景再考虑改 stdio 强制 __external__。

---

## 12. 与 R3 (E 阶段) 的边界

R2 的 6 tool 是 R3 team 抽象的**底层原语**，但 R2 不直接实现 team：
- R2 的 `spawn_session({ team_name: 'X' })` 只是把 team_name 透传到 sessionRepo（与 task-manager 现有 `sessions.team_name` 列同款），不建 team 元信息表
- R3 加 `agent_deck_teams` 表 + `create_team` / `delete_team` / `list_teams` MCP tools（届时本 ADR 增订 §13）
- R3 的 `deep-code-review` skill 重写依赖本 R2 的 6 tool + R3 后续加的 team tool（按 plan v3 风险节，R3.E11 必须与 E5/E6 同 PR 落地）

R2 上线后短窗口（R3 完成前）用户可手动用 spawn_session + send_message 模拟 team 协作，**不依赖任何 team backend**，所以 R3 的硬切代价不影响 R2 的可用性。

---

## 13. 变更历史

- 2026-05-11：initial DRAFT（本会话 R2 启动）
- 2026-05-11：reviewer 双对抗（reviewer-claude + reviewer-codex）三态裁决后修订 → ACCEPTED
  - HIGH-1：§3.1 `spawn_session` schema 补 `team_name` 字段（双方一致）
  - HIGH-2：§3.3.4 wait_reply 共享 promise + caller backfill / since_ts filter 语义补全（双方一致）
  - HIGH-3：§6.5 拆出实施清单 8 项，补 `sessionRepo.upsert` / `rename` 扩列要求 + `sessionManager.close(id)` 新方法（reviewer-claude 独有，主 agent 实证 session-repo.ts:60-92 / 273-291 已有 v008 codex_sandbox 漏列 latent bug）
  - HIGH-4：§3.5 `shutdown_session` 改 `lifecycle=closed` 而非 hard-delete（reviewer-codex 独有，主 agent 实证 session-repo.ts:322 是 `DELETE FROM sessions` + v001_init.sql:24/40/52 ON DELETE CASCADE）
  - MED：§3.1 cwd 强制 absolute / §3.3 returns 加 `aborted` 字段 / §6.6 新增 Race Protection 段（per-caller spawn-mutex + reserve 模式）/ §6.5 加 ListOptions 实施要求
  - LOW：§2.2 / §4.1 删 CallerContext.depth 字段（用 sessionRepo 反查为单一信源）/ §4.2 改文字去掉「冲突时优先 args」死分支 / §3.4 加 adapter = agentId 注 / §6.2 改沿 spawn_chain 整链回溯 / §3.3.1 turn_complete 加 xhigh reasoning 推荐说明
  - 默认值调整：`mcpSpawnRatePerMinute` 5 → 10（reviewer 双对抗 MED，并行 deep-review 留 buffer）
  - §11 新增争议条目：6 (MAX_DEPTH=3 vs 4) / 7 (stdio 已知 sessionId 冒充) / Future `mcpStdioAllowExternalSpawn`
  - §10 验证清单加 V17（shutdown 后数据保留）/ V18（stdio disabled 报错）/ V19（并发 since_ts 切片）/ V20（cwd 整链 cycle 检测）

- 2026-05-12：REVIEW_28 reviewer-claude × reviewer-codex 双对抗后修订
  - **§6.2 移除**：原 §6.2 cwd realpath 整链回溯拒掉 `deep-code-review` SKILL 的合法用例（lead 在 repo 起两 reviewer teammate 同 cwd 同 adapter）；§6.1 depth + §6.4 fan-out + §6.3 spawn-rate 三条已构成有界资源覆盖。残留语义自递归由 depth 截断接受，**不**写为「完全等价覆盖」（reviewer-codex LOW-1 修法）。§6.2 编号保留避免影响其他章节引用
  - **§6.3 顺序约束**：rate token 在 §6.1 depth + §6.4 fan-out 都通过后才扣（reviewer-codex MED-1 修法）—— 防止已达 fan-out 上限的 lead spam spawn_session 把 app-wide rate quota 拒掉给别的合法 lead → 饥饿
  - **§6.4 极端规模**：写明 1 + (5 + 25 + 125) = 156 live session（reviewer-codex MED-2，原文「125」漏算几何级数加和）
  - **§3.4 `list_sessions`**：加 `spawned_by_filter` optional 字段 + 信任边界一句（reviewer-claude MED-1 / LOW-2 + reviewer-codex INFO-1 联动）
  - **§3.5 `get_session`**：新 tool（reviewer-claude MED-2 + reviewer-codex LOW-2 联动）；复用 `projectSession` 与 list_sessions 同款投影 + 单用户 app-wide 信任边界
  - **§3.6 `shutdown_session`**：原 §3.5 顺次后移
  - **6 tool / 6 个 tool**：§1.1 / §3 / §9 / §12 全文档 5→6 同步（reviewer-claude MED-2，避免 EXTERNAL_CALLER_ALLOWED Record 缺 key TS 报错）
  - **§10 V11 / V20 标 obsolete**（reviewer-claude HIGH-3）；新增 V22 / V23 / V24 验证 spawned_by_filter / get_session / fan-out deny 不消耗 rate token
  - **代码同步**：spawn-guards.ts 删 `checkCwdCycleAlongChain` + `safeRealpath`；tools.ts:233 spawn_session description 删 `cwd-cycle` 字段；session-repo.ts `listAncestors` 标 deprecated；AgentDeckMcpSection.tsx UI 文案删「整链 cwd cycle 检测」
  - **测试同步**：spawn-guards.test.ts 删 §6.2 用例 + 加 fan-out deny 不消耗 rate token 用例；tools.test.ts 删 cycle 用例 + 加 spawned_by_filter ×2 + get_session ×2
- 
