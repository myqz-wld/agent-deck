---
review_id: 27
reviewed_at: 2026-05-12
expired: false
skipped_expired: []
---

# REVIEW_27: bootstrap mount MCP HTTP transport 失败（FST_ERR_INSTANCE_ALREADY_LISTENING）

## 触发场景

打包 + 装到 `/Applications` + wrapper ping 验证：app 拉起 / session 建立 / window shown 全 OK，但启动日志暴露：

```
[agent-deck-mcp] failed to mount HTTP transport
FastifyError: Fastify instance is already listening. Cannot add route!
  at HookServer.registerRoute (out/main/index.js:5812)
  at RouteRegistry.registerForAdapter (out/main/index.js:5848)
  at registerAgentDeckMcpHttpRoutes (out/main/transport-http-Ctvu5mtC.js:51)
  at async bootstrap (out/main/index.js:10726)
```

bug 影响：应用内会话走 in-process MCP（`task-manager mcpServers attached for session` + `agent-deck-mcp in-process MCP attached for session` 两条 log 都正常）不受影响；但**外部进程**（codex / 其他 MCP HTTP client）想接 agent-deck MCP HTTP `/mcp` 端连不上 → R2 / B'4 引入的「codex 自动接 agent-deck MCP 跨工具协作」**全失效**。

为什么 dev 没暴露：`DEFAULT_SETTINGS.enableAgentDeckMcp = false`（`src/shared/types/settings.ts:343`）+ `mcpHttpEnabled = true`（`345`）；默认 if 不进所以 dev / 一般用户从未触发。本次新装 .app 用户数据目录（`~/Library/Application Support/agent-deck`）保留了之前手动开过 `enableAgentDeckMcp` 的设置，新装 .app 第一次 boot 就 if=true → 命中 bug。dev 同样会触发，只是默认值挡住没人撞上。

## 方法

**双异构对抗**（按 `~/.claude/CLAUDE.md`「Fallback：手动并发」节，plugin reviewer-claude / reviewer-codex 不可用，按手动模板走）：

- **reviewer-claude**：Claude Opus 4.7 xhigh general-purpose subagent（Task 工具）
- **reviewer-codex**：Codex CLI gpt-5.5 xhigh（外部 wrapper，`zsh -i -l -c "codex exec --sandbox read-only --skip-git-repo-check -c model_reasoning_effort=xhigh"`，第一次 402 Payment Required 暂停 → 用户充值后第二次跑通）

**约束**：根因已锁（fastify 5.x `lib/route.js:208-209` `throwIfAlreadyStarted('Cannot add route!')` + `lib/errors.js:451-453` `FST_ERR_INSTANCE_ALREADY_LISTENING` + 引入 commit `cdb01ae feat(mcp): B'4 + R1.A5 + R1.D7 codex 自动挂 agent-deck MCP via HTTP transport`），不重审根因；对抗仅审 (1) 修复方案完备性 (2) 同类漏网之鱼 (3) 架构护栏建议。

**范围**：

```text
src/main/index.ts                            bootstrap 6 / 6.5 段顺序 + 后续步骤连锁
src/main/hook-server/server.ts               registerRoute / start invariant
src/main/hook-server/route-registry.ts       registerForAdapter 转发
src/main/agent-deck-mcp/transport-http.ts    registerAgentDeckMcpHttpRoutes 实现
src/main/codex-config/agent-deck-mcp-injector.ts  setAgentDeckMcpTokenEnv 实现
```

**机器可读范围**（File-level Review Expiry 用，按字典序）：

```review-scope
src/main/agent-deck-mcp/transport-http.ts
src/main/codex-config/agent-deck-mcp-injector.ts
src/main/hook-server/route-registry.ts
src/main/hook-server/server.ts
src/main/index.ts
```

> spot-check 但未深审的文件不进 review-scope（避免 over-claim「已审」豁免）：`src/main/ipc/settings.ts:221-239` APPLY_FNS（确认 toggle 不重挂）、`src/shared/types/settings.ts:343-345`（默认值核对）、`src/main/adapters/claude-code/index.ts:43-46`（确认 adapter init 在 listen 前注册 ✅）。

## 三态裁决结果

> 本节遵循「决策对抗」节的验证纪律：每条 ✅ 必须带验证手段。本轮根因已锁不重审，对抗仅评修复方案 / 漏网之鱼 / 护栏。

### ✅ 真问题（双方独立提出 / 一方提出且现场实践验证成立）

| # | 严重度 | 文件:行号 | 问题 | A | B | 验证手段 |
|---|---|---|---|---|---|---|
| 1 | HIGH | `src/main/index.ts:131-152`（6 / 6.5 段顺序）↔ `src/main/hook-server/server.ts:99-107` ↔ `src/main/agent-deck-mcp/transport-http.ts:120-147` | bootstrap 第 6 步 `await hookServer.start()`（fastify.listen）后才在第 6.5 步 `await import + registerAgentDeckMcpHttpRoutes(routeRegistry)` 调 `routeRegistry.registerForAdapter('agent-deck-mcp', { method, url:'/mcp' })` × 3 → fastify 抛 FST_ERR_INSTANCE_ALREADY_LISTENING → MCP HTTP `/mcp` 路由完全不挂。引入 commit `cdb01ae feat(mcp): B'4 + R1.A5 + R1.D7 codex 自动挂 agent-deck MCP via HTTP transport`。**修法**：把 6.5 段（`setAgentDeckMcpTokenEnv` + `if (settings.enableAgentDeckMcp && settings.mcpHttpEnabled) { ... }`）整段挪到 6 步 `hookServer.start()` **之前**（PRE_LISTEN，重命名 5.5 步） | ✅完备 | ✅完备 | claude reviewer：grep `started\|isRunning\|listeningPort\|bearerToken\|mcpBearerToken\|hookServer\|RouteRegistry\|routeRegistry` on transport-http.ts → 0 命中（仅注释提 HookServer，无运行时依赖）；读 index.ts:154-330 验证后续步骤不引用 `hookServer` / `routeRegistry` / `agentDeckMcpHttpShutdown`；读 `src/main/codex-config/agent-deck-mcp-injector.ts:77-83` 验证 `setAgentDeckMcpTokenEnv` 仅 `process.env` 写删；fastify 源码 `lib/route.js:209` `throwIfAlreadyStarted('Cannot add route!')`。codex reviewer：额外读 mcp-sdk 本地源码 `node_modules/.pnpm/@modelcontextprotocol+sdk@1.29.0_zod@4.3.6/.../streamableHttp.js:99-105` 确认 `StreamableHTTPServerTransport.start()` 是 per-request transport 的 no-op 启动语义；读退出路径 `src/main/index.ts:310-319` 验证 shutdown 顺序仍合理（先 shutdown MCP HTTP transport 再 stop hookServer） |
| 2 | LOW | `src/main/hook-server/server.ts:99-101` | `HookServer.registerRoute` 直接转发到 `app.route(options)`，对「listen 后调用」无应用层 invariant，fastify 内层抛 `FST_ERR_INSTANCE_ALREADY_LISTENING` 错误位置距离应用契约 2 层调用栈、错误文案是 fastify 通用「Cannot add route」非应用语义。**修法**：在 `registerRoute` 入口加 `if (this.started) throw new Error('HookServer.registerRoute called after listen — routes must be registered during bootstrap before hookServer.start()')` | ❓中立倾向加（边际收益但非零，建议加 + 命名分阶段 PRE/POST_LISTEN 替代） | ✅建议加（应用层 guard 把契约固定在 HookServer 边界，今后同类改动定位更快） | 双方读 fastify 源码 `lib/route.js:208-209` + `lib/errors.js:451-453` 确认是双保险（fastify 已等价检查），应用层增量价值在错误文案靠近应用语义、定位更快；codex 额外提 `starting` 状态边角 ❓ 不做（当前 bootstrap 严格 sequential await chain，无并发注册路径） |

### ✅ 漏网之鱼审计：无

双方独立 grep `registerForAdapter|hookServer\.registerRoute|app\.route\(` 全 src/main，命中点全集（剔除 type 定义 / 函数实现 / test）：

| 调用点 | 时序 | 状态 |
|---|---|---|
| `src/main/agent-deck-mcp/transport-http.ts:134` | bootstrap 6.5 段（listen 后） | ❌ bug 来源（待修） |
| `src/main/adapters/claude-code/index.ts:45` | 在 `adapterRegistry.initAll`（bootstrap 第 5 步 = listen 前） | ✅ |

IPC settings APPLY_FNS（`src/main/ipc/settings.ts:221-239`）双方独立逐字段核对：不含 `enableAgentDeckMcp` / `mcpHttpEnabled` / `mcpStdioEnabled` 的 apply* 即改即生效逻辑，无 `registerAgentDeckMcp*` 调用 → toggle 后仅写 DB，与 `src/main/agent-deck-mcp/transport-http.ts:14-17` 自带 by-design 文档「toggle 后状态需重启 HookServer 才能换 / 撤路由（fastify 不支持运行时 deregister 路由）」一致 → 无埋雷。

teams / session / task-manager / notify 模块 0 命中。

### ❌ 反驳

无（双方对修复方案 / 漏网之鱼 / 护栏建议三方向均无反驳条目）。

### ❓ 部分 / 未验证

| 现场 | A 视角 | B 视角 | 是否已验证 | 结论 |
|---|---|---|---|---|
| `HookServer.registerRoute` invariant 是否覆盖「`app.listen()` 进行中」并发注册（`started` 在 listen resolve 后才置位） | 未提（默认 sequential bootstrap 无此风险） | ❓ 弱断言：可额外跟踪 `starting` 状态覆盖 listen 进行中并发注册 | 未实践验证 | 当前 bootstrap 6 / 6.5 严格 sequential await，无 listen 进行中的并发 register 路径（双方 grep 未发现）→ 不做 starting 状态追踪，本次 invariant 仅查 `started` 即可，留为未来如有需要再加 |

## 修复

### HIGH-1：bootstrap 6 / 6.5 顺序前移到 5.5 PRE_LISTEN

`src/main/index.ts` —— 把现行 6.5 段（`setAgentDeckMcpTokenEnv(...)` + `if (settings.enableAgentDeckMcp && settings.mcpHttpEnabled) { await import + registerAgentDeckMcpHttpRoutes(routeRegistry) }`）整段从 132-152 行挪到 132 行 `await hookServer.start()` **之前**，作为新「步骤 5.5 (PRE_LISTEN)」。新段头注释明确「**必须在 hookServer.start() 之前注册 routes**，否则 fastify 5.x 抛 FST_ERR_INSTANCE_ALREADY_LISTENING」+ 引用 REVIEW_27 / CHANGELOG_70。

### LOW-2：HookServer.registerRoute 加应用层 invariant

`src/main/hook-server/server.ts:99-101` —— `registerRoute` 入口加 `if (this.started) throw new Error(...)` 应用层 invariant，命中时错误文案明确指向「routes must be registered during bootstrap before hookServer.start()」，把契约固定在 HookServer 边界，避免今后再写时序错时只能依赖 fastify 模糊错误。

### 不做

- **starting 状态追踪**（codex 单方建议）：当前 bootstrap 严格 sequential，无 listen 进行中的并发注册路径；增加复杂度 / 边际收益 ≈ 0；如未来真有并发注册需求再加
- **PRE_LISTEN_PHASE / POST_LISTEN_PHASE 命名分段**（claude 单方建议）：边际改善属注释 / 文档级，不阻塞；本次仅在前移段头加 `// 必须在 hookServer.start() 之前` 注释覆盖该需求
- **IPC settings toggle 重新挂 transport**：双方核对 by-design 一致，不修，不引新功能

## 验证

- `pnpm typecheck` 通过
- bug 现场 wrapper ping 启动日志可观测：装新版后 wrapper ping → 日志应不再出现 `[agent-deck-mcp] failed to mount HTTP transport`，转为 `[agent-deck-mcp] HTTP transport mounted at /mcp`

## 关联 changelog

- [CHANGELOG_70.md](../changelog/CHANGELOG_70.md)：本次修复落地

## Agent 踩坑沉淀

候选 1 条：「bootstrap 启动 fastify / express / koa 等 HTTP server 时，所有 route 必须在 listen 前注册完。后续才接的功能模块（如 plugin 自动启停）必须挪到 listen 之前 PRE_LISTEN 阶段，否则 listen 后注册路由会被框架拒。如有疑问加 invariant 应用层兜底」追加进 `.claude/conventions-tally.md`「Agent 踩坑候选」section（首次记录，count=1）。
