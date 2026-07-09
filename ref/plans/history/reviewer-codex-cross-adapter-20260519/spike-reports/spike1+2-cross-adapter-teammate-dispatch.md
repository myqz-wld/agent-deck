# Spike 1+2 — Cross-Adapter Teammate Spawn + send_message 双向 Dispatch + 反驳轮

**日期**：2026-05-19
**plan_id**：reviewer-codex-cross-adapter-20260519
**spike 目标**：实测 claude lead 跨 adapter spawn codex-cli teammate（reviewer-codex native）+ teammate→lead send_message dispatch + lead→teammate dispatch + 反驳轮双向 dispatch 全链路是否跑通。

## 动机

按 RFC 修订 scope：改造目标是让 SKILL.md Step 1 lead 跨 adapter spawn（reviewer-codex 走 `adapter:'codex-cli'` 而非 wrapper 模式的 `'claude-code'`）。这条 path 的 prerequisite 是 cross-adapter teammate 通信机制能稳定 work：
- spawn 链：claude SDK lead 调 `mcp__agent-deck__spawn_session(adapter:'codex-cli', agent_name:'reviewer-codex')` 起 codex SDK teammate
- 下行 dispatch：lead → reviewer-codex（send_message + adapter.receiveTeammateMessage + adapter.sendMessage 喂给 codex SDK thread）
- 上行 dispatch：reviewer-codex → lead（reviewer 调 `mcp__agent-deck__send_message` 回 reply，universal-message-watcher 自动注入 lead conversation flow as user-role message）

## 假设

1. cross-adapter spawn 成功返回有效 sessionId / spawnPromptMessageId（spawn 链 work）
2. reviewer-codex 收到 spawn prompt 后启动 codex SDK thread + 跑 review + 产出 finding（codex SDK in-process 工作模式 work）
3. reviewer-codex 调 `mcp__agent-deck__send_message` 回 lead，reply 自动 wire prefix dispatch 注入 lead conversation flow（上行 dispatch work）

## 实测

**Test scope**：内联代码片段 micro-review

```ts
function divide(a: number, b: number): number {
  return a / b;
}
```

`focus`：1-2 条 finding 用于验证机制（不展开 review）。

**步骤**：

1. lead claude SDK 同 message 并发起两 spawn（同 team_name `spike-cross-adapter-20260519`）：
   - `spawn_session(adapter:'claude-code', agent_name:'reviewer-claude', cwd:<agent-deck repo>, prompt:<micro-review prompt>, team_name:<team>, display_name:'spike-reviewer-claude')`
   - `spawn_session(adapter:'codex-cli',   agent_name:'reviewer-codex',  cwd:<agent-deck repo>, prompt:<micro-review prompt>, team_name:<team>, display_name:'spike-reviewer-codex')`

2. 等 reviewer reply 自动注入 lead conversation flow

## 结论

### ✅ Spawn 链 work（spike 1 第一关 PASS）

两 spawn 都成功返回（同 team_id `12ef7310-b6b5-4ae0-88eb-c2f7c8246c04`）：

| reviewer | sessionId | adapter | spawnDepth | spawnPromptMessageId |
|---|---|---|---|---|
| spike-reviewer-claude | `8b8624dd-cd4a-49ab-bae9-fdc5db8bc803` | claude-code | 1 | `25371635-32bb-44b3-b441-cc635ecac1ac` |
| spike-reviewer-codex  | `019e4069-ab58-7102-bc35-dedb9963c5d0` | codex-cli   | 1 | `eec6530d-31d0-49c4-ba3d-447321447063` |

reviewer-codex 的 sessionId 形式（`019e4069-ab58-7102-...` 第三段首位 7 = UUID v7）确认是 codex SDK 真实 thread id（不是 tempKey），说明 sdk-bridge index.ts:392-396 sid rename 链已 fire（tempKey randomUUID v4 → real thread id v7 + mcpSessionTokenMap.rename + codexBySession Map rename 全跑过）。

### ✅ reviewer 跑通 review + 产出独立 finding（spike 1 第二关 PASS）

两 reviewer 都跑了 review 并产出 finding（异构对抗机制 work）：

**reviewer-claude reply**（自动注入 lead conversation flow，wire prefix `[from spike-reviewer-claude @ claude-code][msg c0325d78-...][sid 8b8624dd-...]`）：

- [HIGH] divide 第 2 行：除零返回 IEEE 754 特殊值未处理（验证：`node -e "1/0; -1/0; 0/0"` runtime 实测）
- [MED] divide 第 2 行：NaN 输入传染无防护（验证：`node -e "NaN/2"` runtime 实测）

**reviewer-codex output**（**未自动注入 lead** — 见下方 ❌ blocker）：

- [MED] inline:1 — `b` 为 0 时返回 `Infinity / -Infinity / NaN`（验证：阅读内联代码确认无 `b === 0` 校验）

三态裁决（spike 验证用，不算正式 review）：

- ✅「除零未校验」双方独立提出（异构强冗余）→ HIGH 真问题

### ❌ teammate→lead 上行 dispatch broken（spike 1 第三关 BLOCKER）

**关键发现**：reviewer-codex（codex-cli adapter）调 `mcp__agent-deck__send_message` 时**失败**，reply 未自动注入 lead conversation flow。

**user UI 实测**（screenshot 21:25:44）：

- reviewer-codex 调 `mcp__agent-deck__send_message` 至少 2 次（第一次标「失败」+ 紧接着第二次重试）
- reviewer-codex 自己 fallback assistant output：「`send_message` 调用被取消，未能回传 lead。拟回传内容如下：...」
- 用户手工把 reviewer-codex 的 finding 内容转贴给 lead（人工承担 dispatch 职责）

**已排除的 failure 模式**：

| 模式 | 排除理由 |
|---|---|
| PendingTab 弹审批被 deny | codex SDK approvalPolicy 写死 `'never'`（`src/main/adapters/codex-cli/index.ts:21` + `sdk-bridge/index.ts:329`），tool 直接放行无 approval gate |
| reviewer 自己中止（NO MSG ANCHOR / SCOPE PATH MISMATCH abort）| reviewer-codex 真的调出去了（UI tool call log 显示调用 + 「失败」标记），不是逻辑层 abort |
| spawn 时 token 注入失败 | sdk-bridge index.ts:392-396 token allocate + ensureCodex envOverride 注入实现完整（plan codex-handoff-team-alignment-20260518 P2 Step 2.5c 修法），且 sessionId v7 = thread id 形式说明 rename 链 fire |
| spawn 时 hand-off context 注入失败 | screenshot 实测注入完整（含 `name: reviewer-codex / Team id: ... / lead session_id / send_message 用法`） |

**未排除 / 待定位的 failure 模式**：

| 模式 | 定位线索 |
|---|---|
| send_message handler 内部 9 种 err 路径之一（`no-shared-team` / `team-not-shared` / `ambiguous-team` / `reply_to_message_id not found` / `cross-team reply not allowed` / `Per-team rate limit exceeded` / `session not found` / `closed` / `self`）| 需后端 log 看 handler 调用栈 |
| transport-http auth 反查问题（HookServer.checkMcpAuth → mcpSessionTokenMap.get 反查失败 → fallbackToGlobal=true → external caller sentinel → withMcpGuard `EXTERNAL_CALLER_ALLOWED.send_message=false` deny）| 需后端 log 看 mcp HTTP /mcp route auth check 结果 |
| universal-message-watcher.enqueueAgentDeckMessage 内部失败（rate-limiter / repo.insert 100KB cap / 内部 emit 失败）| 需后端 log 看 enqueue / dispatch error |
| codex SDK 内部把 mcp tool call result 解读成「cancelled」（HTTP error / timeout / mcp-sdk 协议层错）| 需 codex SDK debug log + mcp HTTP transport 日志 |

**user UI tool call result 详情未能展开**（用户反馈「点不开」），所以具体 error message 未知。

## Spike 状态

- spike 1（spawn 链 + cross-adapter 起 teammate）：✅ PASS
- spike 1 第二关（reviewer 跑 review + 产出 finding）：✅ PASS
- spike 1 第三关（teammate→lead 上行 dispatch）：❌ BLOCKER — 改造能否落地的核心 prerequisite，必须解决
- spike 2（lead→teammate 下行 dispatch + 反驳轮双向 dispatch）：⏸ 阻塞在 spike 1 第三关；上行 broken 时反驳轮不可能跑通，反驳轮单独 spike 无意义。lead→teammate 下行 dispatch 间接通过 spawn 首轮 prompt 注入验证（reviewer-codex 收到 spawn prompt 跑了 review），但 SKILL 编排实际用 `send_message` 路径未独立验证

## 影响 plan

1. **plan 必须含 Phase 0「排查并修 send_message dispatch blocker」**（改造能否落地的核心 prerequisite）
2. **plan §不变量** 必须含：cross-adapter teammate 上行 dispatch（reviewer-codex 调 send_message）应当通过 universal-message-watcher 自动注入 lead conversation flow，无 manual 转贴
3. **Phase 0 验收**：必须在 plan 内嵌一个回归 test —— spawn cross-adapter teammate + send_message 回 lead 闭环通过

## Phase 0 Step 0.1a/0.2 — root cause 定位 PASS（2026-05-20 22:19）

**reproducer 跑法**：spawn cross-adapter teammate 时 prompt 强制 reviewer-codex 在 send_message 调用失败时 **inline 写完整 error 到 assistant output**（绕过 reply 失败 lead 看不到 error 的问题）。

**reviewer-codex 实测吐出真实 error**：

```json
=== SEND_MESSAGE CALL 1 ===
Args: {"session_id":"f1566571-...","team_id":"fec68801-...","text":"test reply 1","reply_to_message_id":"094af6d6-..."}
Result: {
  "setupPhase": "initialize",
  "error": "missing mcp-session-id or initialize failed",
  "initializeResponse": {
    "httpStatus": 400,
    "headers": {"content-type": "application/json"},
    "body": {
      "jsonrpc": "2.0",
      "error": {
        "code": -32600,
        "message": "Invalid Request: Server already initialized"
      },
      "id": null
    }
  }
}
```

reviewer-codex 自己 message：「I can't get a second MCP session through the stateful route」 — 拿不到第二个 MCP session 走 stateful route。

### Root cause（4 层 signal 精确定位）

失败发生在 **mcp HTTP transport initialize 阶段**（**Signal 1 之前的协议层**），不是 4 层 signal 任意一层：

1. **Signal 1 transport-http auth** — **未触达**（initialize 在 auth 之前，但 auth check 也已经过 — fastify onRequest 路由级 hook 已通过 token 反查）
2. **Signal 2 handler 9 种 err** — **未触达**（请求根本没到 handler）
3. **Signal 3 universal-message-watcher** — **未触达**
4. **Signal 4 codex SDK process 内部** — handler 没 return 任何 result，failure 在 mcp-sdk 协议层 `initialize` step

### Root cause 机制

`src/main/agent-deck-mcp/transport-http.ts:175-177`：

```ts
const transport = new http.StreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
});
```

- **单 transport instance**（应用全局，registerAgentDeckMcpHttpRoutes 调用一次创建）
- **stateful 模式**（sessionIdGenerator 非 undefined）

mcp-sdk `StreamableHTTPServerTransport` stateful 模式假设是「**单 client 对单 server**」 — transport 维护单 session id，client 第一次 `initialize` 拿到 session id，后续 request 携带 mcp-session-id header；transport 已 initialized 后第二次 `initialize` 同 transport 撞 `Server already initialized` 错误。

**但我们 use case 是「多 codex SDK 子进程对单 server」** — 每个 codex SDK 子进程都是独立 mcp client，都要独立 initialize；多 client 共用同一 transport instance 必撞 stateful 限制。

### claude-code adapter 不受影响

claude-code adapter 不走 mcp HTTP transport — 走 in-process `createSdkMcpServer` (server.ts:25-44)，per-session 实例化（与 task-manager getTasksMcpServerForSession 同模式）。所以 same-adapter（claude lead × claude reviewer-claude）路径完全不撞此 bug，只 codex SDK adapter（codex teammate spawn 走 HTTP transport）受影响。

### Fix 方向

**A. Stateless 模式**（最简单）：`sessionIdGenerator: undefined` 让 transport 走 stateless 模式（每 request 独立，不需要 session lifecycle）。我们的 5 个 mcp tool（spawn / send_message / list_sessions / get_session / shutdown_session）都不需要 cross-request session state — stateless 充足。

**B. Per-client transport 实例**（multi-client stateful，复杂）：每次 client `initialize` POST 时按 mcp-session-id 创建独立 transport instance，server 端 dispatcher map by mcp-session-id route。代码复杂度大幅增加。

**C. mcp-sdk 文档推荐路径**（待验证）：mcp-sdk 1.29 是否提供 multi-client stateful 标准实现 — 看 sdk source。

**Phase 0 Step 0.3 倾向 A（stateless）** — 最简、改动小、与我们 5 个 mcp tool 无 cross-request state 需求一致。Step 0.3 实施前先看 mcp-sdk source 确认 stateless mode 真支持 + 同 transport.handleRequest 接受多 init request 不撞错。

## Phase 0 Step 0.4 — fix v1 (stateless 单 transport reuse) **不充分** + 修订为 fix v2 (per-request fresh transport) (2026-05-20 01:20)

### Step 0.4 vitest test 实证 fix v1 不充分

写 `src/main/agent-deck-mcp/__tests__/transport-http-multi-client-init.test.ts`，真起 `http.Server` + 挂 `transport.handleRequest` + `fetch` 发真 multi-client init 请求实测三档行为：

| 模式 | 第一次 init | 第二次 init |
|---|---|---|
| stateful（`sessionIdGenerator` 非 undefined）+ 单 transport reuse | 200 SSE | **-32600 「Server already initialized」**（spike 1+2 实测 root cause） |
| stateless（`sessionIdGenerator: undefined`）+ 单 transport reuse | 200 SSE | **status=500 + 空 body**（fix v1 commit `c67ddde` **新 bug**） |
| stateless + 每 request fresh transport instance | 200 SSE | **200 SSE** ✅（fix v2 路径可行） |

### fix v1 失败 root cause 机制

**mcp-sdk 1.29 webStandardStreamableHttp.js:142-144**：

```js
async handleRequest(req, options) {
    if (!this.sessionIdGenerator && this._hasHandledRequest) {
        throw new Error('Stateless transport cannot be reused across requests. Create a new transport per request.');
    }
    this._hasHandledRequest = true;
    // ...
}
```

stateless 模式（`sessionIdGenerator === undefined`）+ `_hasHandledRequest === true`（同 transport instance 处理过一次 request）→ throw 「Stateless transport cannot be reused across requests」。

**hono node-server listener.js:518 + 441**：mcp-sdk transport 通过 `getRequestListener` 桥接 Node HTTP / Web Standard。`responseViaResponseObject` 路径用 `res = await res.catch(handleFetchError)` 把 fetchCallback throw 转成 `new Response(null, { status: 500 })` —— **不是 reject 不进 try/catch outer block**，而是把 throw 就地转成 status=500 空 body，且**不**触发 `console.error(e)`（不进 `handleResponseError` 路径）。

**结果**：fix v1 stateless 模式 + 单 transport reuse 第二次 init 表现为 status=500 + 空 body，与 stateful -32600 错码不同但同样 broken（cross-adapter teammate 第二次 init 失败，send_message dispatch 仍不工作）。

### fix v2 修法（mcp-sdk 1.29 official example 标准 pattern）

mcp-sdk 1.29 `dist/cjs/examples/server/simpleStatelessStreamableHttp.js` 给出 stateless multi-client 标准实现：

```js
app.post('/mcp', async (req, res) => {
    const server = getServer();   // fresh McpServer per-request
    try {
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        res.on('close', () => {
            transport.close();
            server.close();
        });
    } catch (error) {
        // ... error handling
    }
});
app.get('/mcp', async (req, res) => {
    res.writeHead(405).end(JSON.stringify({ error: 'Method not allowed.' }));
});
app.delete('/mcp', async (req, res) => {
    res.writeHead(405).end(JSON.stringify({ error: 'Method not allowed.' }));
});
```

**关键设计**：

- POST /mcp 每 request 创建 fresh transport + fresh McpServer + connect → handleRequest，request 完成后 `res.on('close')` 清理两者
- GET / DELETE 走 **405 Method not allowed**（stateless 不支持 SSE 长连 / session DELETE）
- 每 request transport instance 独立 → `_hasHandledRequest` 始终 `false` → 不撞 reuse throw

### fix v2 实施 commit `835aa7c`

`src/main/agent-deck-mcp/transport-http.ts` 改造：

- `registerAgentDeckMcpHttpRoutes` 移除上层全局 transport / mcpServer 创建
- POST /mcp handler 内部 per-request 创建 fresh `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` + `buildAgentDeckMcpServerForExternalTransport('http')` + `mcpServer.connect(transport)` → `transport.handleRequest(req.raw, reply.raw, req.body)`，`reply.raw.on('close')` 清理两者（mcp-sdk official example 同款套路）
- GET / DELETE 走 405 Method not allowed
- shutdown 是 noop（per-request transport / server lifecycle 在 reply.raw close 事件里清理）
- 极端 throw 路径兜底：`try { transport.handleRequest } catch` 写 status=500 + JSON-RPC `-32603 Internal server error`（mcp-sdk official example 同款）

### Step 0.4 fix v2 PASS 实证

- `transport-http-multi-client-init.test.ts` 3 个 case 全 PASS（stateful reuse 撞 -32600 / stateless reuse status=500 空 body / per-request fresh 两次都 200）
- 全量 vitest **877 pass + 76 skip + 0 fail**（0 regression — transport-http-extra-auth 10 pass + spoofing-attack-paths 11 pass + 全套其他 856 tests 全 pass）
- typecheck pass

### 性能开销评估

每 request 跑 `buildAgentDeckMcpServerForExternalTransport`（new McpServer + 5+ tool register）+ `McpServer.connect(transport)`。

- `loadMcpSdk` / `loadSdk` 走 V8 module cache + Promise dedupe（首次后后续 instant）
- McpServer instance 化 + tool register（5 个 mcp tool + 5 个 plan-driven tool）+ transport.connect 全是纯内存操作 + minimal IO
- Per-request 增量延迟毫秒级 + 无 cross-request state，production load 可接受

### 真实端到端 fix-verification 待 user 重启 .app 触发

**当前 lead session 跑在 PID 78626 的打包 .app**（`/Applications/Agent Deck.app`，启动于 8:13PM），其 main 进程加载的 `transport-http-DwCnqxLm.js` 仍是 base_commit `40d7527` 的 stateful 模式（`sessionIdGenerator: () => randomUUID()`）。fix v2 commit `835aa7c` 在 worktree branch 上**未装入运行中 main 进程**。

重启 .app 装 worktree 代码会 kill 当前 lead session,本会话 fix-verification 走 vitest unit test 路径 B 实证已完成,留 user 重启后用 cross-adapter spawn pair reproducer 真实端到端复测：

```
mcp__agent-deck__spawn_session({
  adapter: 'codex-cli',
  agent_name: 'reviewer-codex',
  team_name: '<test-team>',
  cwd: '<agent-deck repo>',
  prompt: <reproducer prompt 强制 inline error message,与 spike 1+2 / Phase 0 Step 0.1a 同款>,
  display_name: 'fix-v2-verify-reviewer-codex',
});
```

预期：reviewer-codex 调 `mcp__agent-deck__send_message` **不再**撞 -32600 / status=500，reply 正常注入 lead conversation flow as user-role message。

