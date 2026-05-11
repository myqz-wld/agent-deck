# Spike 阶段报告（plan v3 前置验证）

> 验证 plan v3 5 项关键假设，决定 R1-R4 任务是否需要砍 / 调档。
> 跑出日期：2026-05-11

## 总览

| Spike | 状态 | 结论 | Plan 影响 |
|---|---|---|---|
| spike-A2 | ✅ | codex `resumeThread` + 切 sandbox 真透传生效 | A2 任务保留，capabilities `canRestartWithPermissionMode: true` |
| spike-A3 | ✅ | 5 codex 并发 oneshot 资源温和（10s / ~44MB / 复用 app-server 单例） | A3 max-concurrent 默认 2-3（与 claude 同档），无需保守化 |
| spike-D5 | ✅（反证） | 65KB AGENTS.md 完整加载，**32KiB 上限不存在** | plan 风险节移除「AGENTS.md 32KiB」假设；reviewer-claude N1 finding 反证 |
| spike-B'-wire | ✅ | mcp-sdk 1.29.0 `StreamableHTTPServerTransport` 完整类，集成 fastify ~50-100 LOC | plan B'1 三协议合计 ~400 LOC（不是 600），reviewer-claude HIGH-3 部分高估 |
| spike-B'-caller-id | ⚠️ 应对确认 | tool handler `extra: unknown`，caller context 不暴露稳定 schema | B'5 强制 input schema `caller_session_id` 方案唯一，防递归 4 条规则保留 |

**结论**：plan v3 全部任务保留，无需砍。LOC 可微调（B'1 -200）。进 R1 阶段。

---

## spike-A2: codex resume + 切 sandbox 透传

### 静态结论（先得）

读 `node_modules/@openai/codex-sdk/dist/index.js`：

- `Thread.runStreamedInternal:50-93` 每次 turn 从 `_threadOptions` 读 sandboxMode/workingDirectory/etc 重新拼 CLI args
- `resumeThread(id, options):459-461` 接受新 options 创建新 Thread
- `CodexExec.run:178-179` `--sandbox` 拼接独立于 `:214-215` `resume <id>`，每 turn 都按当前 options 重新生成

### 实测过程

```bash
# step1: workspace-write 起 thread + 创建 hello.txt
codex exec --sandbox workspace-write --skip-git-repo-check -o /tmp/spike-a2-out1 - < prompt-step1
# thread_id = 019e0c3c-1f2c-7d30-adcf-6421f70dec07
# canary.txt 仍存在，hello.txt 创建成功

# step2: resume + 切 read-only 试删 canary.txt
codex exec --sandbox read-only --skip-git-repo-check resume <thread_id> --json - < prompt-step2
# 输出: 删除失败，错误消息：rm: canary.txt: Operation not permitted
# canary.txt 仍存在 ✅
```

### 实测结论

- ✅ resume 同 thread + 切 sandbox 真透传到 OS 层 sandbox 拒绝
- ⚠️ 注意 codex CLI flag 顺序：`exec --sandbox X resume <id>`（`--sandbox` **必须**在 `resume` **前**），否则 CLI 报 `unexpected argument '--sandbox'`。SDK 的 args 拼接顺序符合此约束
- ⚠️ stderr 出现 `failed to record rollout items: thread <id> not found` warning — 非 fatal，但要在 A2 实施时观察是否影响 thread 持久化

### A2 任务影响

- 保留 A2 任务（`~350 LOC`）
- 设 `capabilities.canRestartWithPermissionMode: true`
- 实现 `restartWithPermissionMode(sid, newMode, handoffPrompt)`：closeSession → resumeThread(oldId, {sandboxMode:newMode}) → push handoffPrompt 到 pendingMessages → emit session-start 复用旧 sessionId
- 持久化原 sandboxMode/workingDirectory/approvalPolicy 到 sessionRepo（重启应用后 resume 恢复原 sandbox）

---

## spike-A3: 5 codex 并发 oneshot 资源消耗

### 实测过程

```bash
# 5 个并发 codex exec，prompt = "请说 hi 然后停止。三个字以内。"
for i in 1..5: zsh -i -l -c "codex exec --sandbox read-only -c model_reasoning_effort='low' -o /tmp/spike-a3/out-$i.txt - < prompt" &
```

### 实测结论

- ✅ 总耗时 **10 秒**（5 个并发，几乎与单个相同）
- 5 个输出全是 "hi"
- ps 采样：单个 codex node 进程 ~44 MB RSS；codex CLI 走 **app-server 单例模式**（pid 14489 broker / 14492 codex app-server / 14493 codex 二进制 ~32-44 MB）
- 5 个并发实际复用 app-server，**不是** 5×单进程内存

### 反证 reviewer-claude HIGH 风险

reviewer-claude finding：「codex SDK 是 spawn codex CLI 子进程（README 第一句明说 spawns the CLI）。同一台 mac 同时跑 N 个 codex 子进程的资源消耗远比 claude SDK in-process 大」

**实测推翻**：codex SDK + CLI 走 app-server 单例 daemon 模式，N 个并发不是 N×子进程开销。

### A3 任务影响

- 保留 A3 任务（`~350 LOC`）
- max-concurrent 默认与 claude 同档（2-3 个），不需保守化到 1
- 但仍按 adapter 分桶（防极端场景 codex 跑大 prompt 占大量 token）

---

## spike-D5: AGENTS.md 32KiB 上限

### 实测过程

```bash
# 拼 65 KB AGENTS.md：顶部 + 500 个 SECTION 段（每段 ~100 字符）+ 底部 marker
# 让 codex 回答 1) 顶部 marker 见到吗 2) 底部 marker 见到吗 3) SECTION 数
codex exec --sandbox read-only --skip-git-repo-check -c model_reasoning_effort='low' -o out -
```

### 实测结论

```
1. YES   ← 顶部 marker SPIKE_D5_TOP_MARKER_PRESENT
2. YES   ← 底部 marker SPIKE_D5_BOTTOM_MARKER_PRESENT
3. 500   ← 中间 SECTION 全部读到
```

文件实际 65,283 bytes ≈ 63.7 KiB，远超 plan 假设的 32 KiB 上限。

### 反证 reviewer-claude N1 finding

reviewer-claude N1：「plan 现状发现节 + 风险节都写「~/.codex/AGENTS.md 32KiB 上限」。但 codex SDK README + dist/index.d.ts + dist/index.js 全文搜不到 32768 / 32KiB / "32 \* 1024" / "AGENTS_MD_LIMIT" 等关键词；plan 没给来源链接。」

**实测推翻 32KiB 假设**：65KB 完整加载，无截断。

### D 阶段任务影响

- D5 ADR 仅需写入「32KiB 上限不存在，AGENTS.md 实际由 codex CLI 按 token 预算自管」
- D 阶段风险节移除「AGENTS.md 32KiB」相关担忧
- 但实施时仍建议监控 AGENTS.md 体积（毕竟 token 是计费的，超大 AGENTS.md 推升每次 turn cost）

---

## spike-B'-wire: MCP HTTP transport 集成成本

### 静态结论

`@modelcontextprotocol/sdk` 1.29.0 已装 + 提供 `StreamableHTTPServerTransport` 完整类。集成 fastify 仅需：

```ts
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
const server = new McpServer({...});
await server.connect(transport);
fastify.post('/mcp', (req, reply) => transport.handleRequest(req.raw, reply.raw, req.body));
fastify.get('/mcp', (req, reply) => transport.handleRequest(req.raw, reply.raw));
fastify.delete('/mcp', (req, reply) => transport.handleRequest(req.raw, reply.raw));
```

**估算**：HTTP transport 集成 ~80 LOC，加上 stdio + in-process 三协议合计 ~400 LOC（不是 plan 估的 ~600）。

### 反证 reviewer-claude HIGH-3 部分

reviewer-claude HIGH-3：「B'1/B'2 ~400 LOC 严重低估 ... HTTP transport 要在 hook-server 上挂 /mcp 路由实现完整 MCP wire protocol（Streamable HTTP / SSE / session id 协商 / lifecycle），单 protocol 实现就远超 400 LOC」

**部分推翻**：MCP wire protocol 已被 SDK 完整封装，不需要 from scratch 实现。但 B'2 五个 tool（特别 wait_reply）的实现复杂度 reviewer 估算合理，不下调。

### B' 阶段任务影响

- B'1 LOC 下调到 ~400（不是 ~600）
- B'2.b wait_reply 仍是 ~350 LOC（最复杂 tool，含 until 三档 + 超时 + 中断 + 并发共享 promise）
- B' 总 LOC 估算 ~2280 → ~2080

---

## spike-B'-caller-id: MCP tool handler caller context

### 静态结论

`@anthropic-ai/claude-agent-sdk/sdk.d.ts:5178` `tool()` 与 `SdkMcpToolDefinition` handler 签名：

```ts
handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>;
```

**`extra: unknown`** — SDK 不暴露稳定 caller context schema。意味着：
- 不能假设 `extra.sessionId` / `extra.callerInfo` / `extra.parentTeamName` 之类字段存在
- 即使运行时存在某个字段，下次 SDK 升级可能改名 / 删除 / 形态变化

### 应对方案确认

`B'5` 防递归 4 条规则的 caller-id 来源**唯一稳定路径** = 强制 tool input schema 含 `caller_session_id` 字段：

```ts
inputSchema: z.object({
  adapter: z.enum(['claude-code', 'codex-cli', 'aider', 'generic-pty']),
  cwd: z.string(),
  prompt: z.string(),
  team_name: z.string().optional(),
  caller_session_id: z.string(),  // ← 强制必填
  parent_session_id: z.string().optional(),  // 给 depth 链路用
  depth: z.number().int().min(0).default(0),  // 给 depth 上限用
})
```

代价：调用方（claude/codex 在 prompt 里）必须知道自己的 session_id 才能调 tool。

**应对**：
- in-process MCP 路径：closure 注入 `sessionIdProvider()` 在 tool handler 内强制覆盖 `args.caller_session_id`（无视调用方传的值，用当前 session id）
- HTTP MCP 路径：要求调用方在 prompt 里被告知（README + SKILL 文档化），handler 内再 fall-back 到 HTTP `Authorization` 携带的 session token 反查
- 拿不到 caller-id 时 handler 整体 deny（reviewer 建议）

### B' 阶段任务影响

- B'5 防递归 4 条规则方案确定（depth 上限 / 同 cwd realpath / per-app spawn-rate / per-parent fan-out）
- B'2.a tool handler 实现要做 in-process closure 覆盖 `args.caller_session_id`
- B'7 用户文档要写明「外部 MCP client 调 spawn_session 必须传 caller_session_id」

---

## Plan v3 → v3.1 增量调整（已落地）

| 项 | 原 plan v3 | spike 后调整 |
|---|---|---|
| AGENTS.md 上限风险 | 32KiB 上限 | **删除该风险**（实测 65KB 完整加载） |
| B'1 LOC | ~600 | ~400（HTTP transport SDK 已封装） |
| A3 max-concurrent | 按 adapter 分桶（codex 默认 1） | 默认 2-3（与 claude 同档，app-server 单例复用） |
| A2 实施细节 | 透传新 sandbox | 加注：CLI flag 顺序 `--sandbox X resume <id>`（SDK 已正确拼接） |
| B'5 caller-id | 强制 input schema | 加注：in-process closure 覆盖 + HTTP fallback HTTP Auth 反查 |

**所有 spike 失败退路均未触发，无任何 plan 任务砍掉。**
