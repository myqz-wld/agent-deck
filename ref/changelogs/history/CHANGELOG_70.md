# CHANGELOG_70: 修 bootstrap mount MCP HTTP transport 失败 (FST_ERR_INSTANCE_ALREADY_LISTENING)

## 概要

打包安装后 wrapper ping 验证暴露 R2 / B'4 引入的 commit `cdb01ae feat(mcp): B'4 + R1.A5 + R1.D7 codex 自动挂 agent-deck MCP via HTTP transport` 把第 6.5 段「mount HTTP /mcp 路由」错误地放在第 6 步 `await hookServer.start()`（fastify.listen）**之后** → fastify 5.x 在 listen 后调 `app.route()` 抛 `FST_ERR_INSTANCE_ALREADY_LISTENING` → MCP HTTP `/mcp` 完全不挂 → codex / 外部 MCP client 连不上 agent-deck，跨工具协作能力失效。修法：把 6.5 段整体前移到 5.5 PRE_LISTEN 阶段；同步在 `HookServer.registerRoute` 加应用层 invariant 把契约固定在边界。详见 REVIEW_27。

## 变更内容

### `src/main/index.ts`

- 把第 6.5 段（`setAgentDeckMcpTokenEnv` + `if (settings.enableAgentDeckMcp && settings.mcpHttpEnabled) { await import + registerAgentDeckMcpHttpRoutes(routeRegistry) }`）整段从 6 步 `hookServer.start()` 之后挪到 6 步 **之前**，重命名为 5.5 步（PRE_LISTEN）
- 5.5 段头注释明确「**必须在 hookServer.start() 之前注册 routes**，否则 fastify 5.x 抛 FST_ERR_INSTANCE_ALREADY_LISTENING」+ 引用 REVIEW_27 / CHANGELOG_70 + 引用 fastify 内部检查位置 `lib/route.js:208 throwIfAlreadyStarted`
- 6 段头注释加「POST_LISTEN 分水岭」标注，提示后续任何 `routeRegistry` / `registerRoute` 调用都会被 invariant 拒

### `src/main/hook-server/server.ts`

- `registerRoute` 入口加应用层 invariant：`if (this.started) throw new Error('HookServer.registerRoute called after listen — routes must be registered during bootstrap before hookServer.start()')`
- 不动 `start()` / `stop()` / `app.route()` 调用本身
- 与 fastify 内置 `lib/route.js:208` `throwIfAlreadyStarted` 是双保险：本层 fail-fast 错误位置距离 HookServer 抽象边界 0 层调用栈，错误文案直接指向修法（fastify 通用「Cannot add route」非应用语义）

## 备注

- **不影响 dev / 默认装机**：`DEFAULT_SETTINGS.enableAgentDeckMcp = false`（`src/shared/types/settings.ts:343`），本次 bug 仅在用户曾经手动开过该 setting 后触发（持久化在 `~/Library/Application Support/agent-deck` 跨重装保留）；dev 同样会触发，只是默认值挡住没人撞上
- **应用内会话不受影响**：in-process MCP 走 SDK direct attach（启动日志 `task-manager mcpServers attached for session` + `agent-deck-mcp in-process MCP attached for session` 两条都正常），HTTP transport mount 失败时仍能 spawn agent / 调 `mcp__agent_deck__*`，仅外部进程（codex）连不上 `/mcp`
- **不引入「toggle 后即时重挂」逻辑**：与 `src/main/agent-deck-mcp/transport-http.ts:14-17` 自带 by-design 文档一致（fastify 不支持运行时 deregister 路由），用户 toggle 设置后仍需重启应用生效；`src/main/ipc/settings.ts:221-239` APPLY_FNS 不含这两个字段
- **不做 starting 状态追踪**：reviewer-codex 单方建议，当前 bootstrap 严格 sequential，无 listen 进行中的并发注册路径；增加复杂度 / 边际收益 ≈ 0；如未来真有并发注册需求再加
- **关联**：[REVIEW_27.md](../../reviews/history/REVIEW_27.md) 双异构对抗审视记录（reviewer-claude Opus 4.7 xhigh general-purpose subagent + reviewer-codex gpt-5.5 xhigh CLI wrapper，第一次 402 Payment Required 暂停 + 用户充值后重试通过；3 个对抗待审项均双方一致 ✅）
- **验证**：`pnpm typecheck` 通过；用户重新 `pnpm dist` + 覆盖安装 + wrapper ping → 启动日志应转为 `[agent-deck-mcp] HTTP transport mounted at /mcp`
