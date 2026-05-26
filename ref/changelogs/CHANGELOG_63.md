# CHANGELOG_63: R2 阶段 — Agent Deck MCP server（plan v3 落地，8 commit）

## 概要

实施 plan v3 R2 阶段：Agent Deck 自跑 MCP server，让 claude / codex / 第三方
MCP client 通过 5 个 tool（spawn_session / send_message / wait_reply /
list_sessions / shutdown_session）跨 adapter 编排其他 coding agent session。

三 transport 并存（in-process / HTTP / stdio）+ 防递归 4 条规则 + 47 单测。
合并实现 R1 follow-up：A5（codex 自动注入 mcp）+ D7（codex runtime config 协同）。

8 个 atomic commit：B'0 ADR（reviewer 双对抗后修订到 ACCEPTED）→ B'1 transport
骨架 + sessionRepo/manager 先决重构 → B'2.a 同步 tool → B'2.b wait_reply →
B'3 claude 自动挂 → B'4 codex HTTP 注入 → B'5 防递归 4 条规则 → B'6 Settings UI。

## 变更内容

### B'0: ADR（docs/agent-deck-mcp-protocol.md）

reviewer-claude + reviewer-codex 双对抗评审三态裁决后修订到 ACCEPTED。4 条 HIGH
全部修：

- HIGH-1（双方一致）：spawn_session schema 加 `team_name` 字段
- HIGH-2（双方一致）：wait_reply 共享 promise + caller backfill / since_ts filter
  语义补全（baseline_ts + since_ts 区间历史 backfill 合并到 live events）
- HIGH-3（reviewer-claude 独有 + 主 agent grep 实证 session-repo.ts:60-92 / 273-291
  rename 路径已有 v008 codex_sandbox 漏列 latent bug）：拆出实施清单 8 项
- HIGH-4（reviewer-codex 独有 + 主 agent grep 实证 session-repo.ts:322 是
  `DELETE FROM sessions` + v001_init.sql:24/40/52 ON DELETE CASCADE）：
  shutdown_session 改 `lifecycle=closed` 而非 hard-delete

MED / LOW / Nit 全部合并：cwd 强制 absolute / aborted 字段 / Race Protection 段 /
整链回溯 cwd cycle / depth 字段从 CallerContext 移除 / 默认 spawnRate 5→10。

### B'1: transport 骨架 + sessionRepo / manager 先决重构

DB / Repo（按 ADR §6.5.2 实施清单 8 项）：

- migration `v009_mcp_spawn_chain.sql`：sessions 加 `spawned_by`（FK + ON DELETE
  SET NULL 兜底）+ `spawn_depth`（NOT NULL DEFAULT 0）+ `idx_sessions_spawned_by`
- `session-repo.ts`：upsert / rename 路径同步加新列；rename `toExists=false` 分支
  从 13 列扩到 16 列（**顺手补 v008 codex_sandbox 漏列 latent bug** —
  CHANGELOG_35 同款踩坑教训）；`toExists=true` 分支加 OLD 覆盖 NEW UPDATE
  （codex_sandbox / spawned_by / spawn_depth 都参与「会话身份」覆盖语义）
- 新增 `sessionRepo.getSpawnDepth / setSpawnLink / listAncestors / listChildren`
- `session/manager.ts` 新增 `close(id)`：调 adapter.closeSession + setLifecycle
  到 closed，**不**调 sessionRepo.delete（与 markClosed 不同：本方法是「立即终止」
  含 SDK 子进程关闭，scheduler markClosed 是「自然衰减」无需关 SDK）
- `shared/types/session.ts` SessionRecord 加 spawnedBy / spawnDepth 字段

Settings：8 个新字段 + DEFAULT_SETTINGS：`enableAgentDeckMcp` / `mcpServerToken` /
`mcpHttpEnabled` / `mcpStdioEnabled` / `mcpMaxSpawnDepth` / `mcpSpawnRatePerMinute` /
`mcpMaxFanOutPerParent` / `mcpWaitReplyIdleQuietMs`。
`settings-store.ts` 首启自动生成 `mcpServerToken`（与 hookServerToken 独立 32-byte hex）。

HookServer：构造签名加 mcpToken；onRequest 加 `/mcp` 前缀分支用独立 token 校验
（与 `/hook/*` 路径同款 timingSafeEqual 常量时间比较）；加 `mcpBearerToken` getter
给 B'4 codex 自动注入用。`index.ts` new HookServer 同步加 settings.mcpServerToken。

agent-deck-mcp/ 新模块（5 文件）：

- `types.ts`：CallerContext / EXTERNAL_CALLER_ALLOWED 表（spawn / send / shutdown
  外部 caller 默认 deny；list / wait_reply 允许）
- `tools.ts`：5 tool zod schema（B'1 完整 schema + B'2 完整 handler）
- `server.ts`：getAgentDeckMcpServerForSession in-process factory（与 task-manager
  同款 SDK createSdkMcpServer pattern）
- `transport-http.ts`：mcp-sdk McpServer + StreamableHTTPServerTransport + fastify
  POST/GET/DELETE 三方法挂载（reply.hijack 让 transport 直写 raw）
- `transport-stdio.ts`：StdioServerTransport module（cli 子命令暂未暴露）

### B'2.a: 同步 tool 实现（spawn / send / list / shutdown）

按 ADR §3.1/3.2/3.4/3.5 实现 4 个同步 tool 的完整 handler 逻辑：

- `denyExternalIfNotAllowed`：__external__ caller 对 spawn/send/shutdown 直接 deny
- `validateExternalCaller`：HTTP/stdio caller 必须能反查 sessionRepo + 未 closed
  in-process 走 closure 强制覆盖跳过反查
- `spawn_session`：simplified self-spawn 1 层 cycle 检测（B'5 替换为整链回溯）→
  adapter.createSession → setSpawnLink + record team_name + permission_mode（与 IPC
  adapters.ts 同款）
- `send_message`：session 必须存在 + 未 closed → adapter.sendMessage
- `list_sessions`：投影 metadata 仅含 sessionId/adapter/cwd/lifecycle/title/
  lastEventAt/teamName/spawnedBy/spawnDepth；不暴露 events/messages/activity/source
- `shutdown_session`：caller_session_id ≠ session_id → sessionManager.close（不 delete）
  幂等：已 closed target 直接返回 alreadyClosed:true

单测 21 例（mock sessionRepo / sessionManager / adapterRegistry / loadSdk 跳 SQLite +
SDK 真依赖）：external caller deny / caller validation / in-process closure 防伪造 /
spawn cycle / send 边界 / shutdown 幂等 / list 投影。

### B'2.b: wait_reply 完整实现

按 ADR §3.3 + §3.3.4（reviewer 双对抗 HIGH-2 修法）实现 wait_reply tool 的
三档 until 语义 / 超时 / 并发共享 promise / caller 各自 since_ts filter + backfill。

新增 `wait-reply-coordinator.ts` (~210 LOC)：
- promise key = `${sid}:${until}:${idleQuietMs}`，同 key 共享一个 promise + listener
- baseline_ts = promise 创建瞬间，coordinator 内部仅收 ts >= baseline_ts 的 live 事件
- first_message：emit message 即 resolve
- turn_complete：emit finished / waiting-for-user 即 resolve
- idle：每收 event reset N ms timer，N ms 静默后 resolve
- session-removed 强制 resolve（reason=session-closed）
- shutdownAll 应用关闭时清理所有 active

tools.ts wait_reply handler 走两步合并（防 caller since_ts 漏收）：
- 拉 [args.since_ts ?? handlerEntryTs, baseline_ts) 段历史 backfill（eventRepo
  新增 `listForSessionRange` 接口）
- live events 用 since_ts 二次 filter
- Promise.race(coordinator, sleep(timeout_ms)) 实现 timeout（不 abort coordinator
  让其他 caller 继续等）；超时返回 partial events + timedOut=true

单测 wait-reply-coordinator 13 例（三档 until / 共享 promise / baseline 防御 /
session-removed / shutdownAll / projection）。

### B'3: claude 会话自动挂 in-process Agent Deck MCP

按 ADR §2 / §4.1：claude 会话 spawn 时若 settings.enableAgentDeckMcp ON，挂
in-process MCP server name='agent-deck'，pre-approve `mcp__agent_deck__*` 通配。
callerSessionIdProvider 走 lazy 工厂，让 tools.ts 强制覆盖 args.caller_session_id
防 prompt 注入伪造身份。

与 task-manager 共存：mcpServers 字段同时含 tasks + agent-deck（任一 toggle 开 →
对应 server 挂；都开 → 两 server 并存；都关 → mcpServers 字段不展开）。

未触动 canUseTool / summarizer / agentTeamsEnabled。

### B'4 + R1.A5 + R1.D7: codex 自动挂 agent-deck MCP via HTTP transport

main bootstrap：
- `setAgentDeckMcpTokenEnv(settings.mcpServerToken)` 设进 process.env
- 双开关同 ON 时 await `registerAgentDeckMcpHttpRoutes(routeRegistry)` 挂
  StreamableHTTPServerTransport 到 fastify /mcp（POST/GET/DELETE 三方法）
- 应用关闭时 `agentDeckMcpHttpShutdown` 优先于 hookServer.stop 调用（关 SSE 长连接）

`codex-config/agent-deck-mcp-injector.ts`（新）：
- `buildAgentDeckMcpConfigForCodex` 计算 codex SDK config 字段：
  `{ mcp_servers: { 'agent-deck': { url: 'http://127.0.0.1:<port>/mcp',
    bearer_token_env_var: 'AGENT_DECK_MCP_TOKEN' } } }`
- 通过 env var 间接引用 token（与 codex 文档推荐用法一致）
- `mergeCodexConfig` 浅合并工具
- 不写盘 ~/.codex/config.toml（避免污染用户配置）；与 R1.A4b 用户手配
  mcp_servers 互补
- 单测 12 例覆盖 5 deny 分支 + 1 happy path + 6 merge

codex-cli/sdk-bridge：
- `types.ts CodexBridgeOptions` 加 `hookServer?: HookServer` 字段
- `index.ts ensureCodex` 调 buildAgentDeckMcpConfigForCodex(settings, this.opts.hookServer)
  把结果传给 `new sdk.Codex({codexPathOverride, config})`
- `codex-cli/index.ts init(ctx)` 把 ctx.hookServer 传给 bridge constructor

### B'5: 防递归 4 条规则 + race protection

按 ADR §6.1-§6.6（含 reviewer 双对抗 MED Race Protection 修法）。

`rate-limiter.ts`（新）：
- `RateLimiter` class：滑动窗口同步段（tryConsume / retryAfterMs / setLimits）
- `InFlightChildrenCounter` class：per-caller in-flight 计数 (inc / dec / get)
- spawnRateLimiter / inFlightChildren 模块级单例

`spawn-guards.ts`（新）：`applySpawnGuards(caller, newCwd, newAdapter)` 按代价升序：
1. depth 上限：sessionRepo.getSpawnDepth(caller) >= mcpMaxSpawnDepth → deny
2. spawn-rate：滑动窗口 60s / mcpSpawnRatePerMinute → deny + retryAfterMs
3. fan-out：DB listChildren + in-flight 叠加，effective+1 > max → deny；通过则 inc
4. cwd realpath 整链回溯：caller + 沿 sessionRepo.listAncestors 任一同 cwd 同 adapter
   → deny（自动 release 已 inc 的 fan-out slot）

通过返回 `{ ok, parentDepth, fanOutSlot.release() }`，handler 必须在 createSession
完成后 finally release（idempotent；catch 路径同款 release 防双计数）。

每次 handler 调用同步刷 spawnRateLimiter.setLimits 让 Settings hot-toggle 立即生效
（不像 sandbox 那样 spawn-time 锁定）。

tools.ts spawn_session handler：
- 删 simplified `checkSelfSpawnCycle`（已被 spawn-guards 整链回溯接管）
- 新增 fanOutSlot 释放语义（catch + finally 双保险）

测试 spawn-guards.test.ts 12 例覆盖：depth / spawn-rate / fan-out（含 release 幂等
+ cycle deny 路径自动 release）/ cwd cycle 整链。

### B'6: Settings UI

新增 `AgentDeckMcpSection.tsx` (~120 LOC)：
- 总开关 enableAgentDeckMcp
- transport 子开关：mcpHttpEnabled / mcpStdioEnabled
- 防递归阈值（4 个 NumberInput，热生效）：mcpMaxSpawnDepth / mcpSpawnRatePerMinute /
  mcpMaxFanOutPerParent / mcpWaitReplyIdleQuietMs
- mcpServerToken 只读显示 + 复制按钮 + 提示「不要修改」+ 轮换路径
- 文档每个开关都标注：spawn-time 锁定 vs hot-toggle 立即生效

SettingsDialog.tsx 注册新 section（放在 ExperimentalSection 后）。

## 备注

- **未触动 ADR §11.1 mcpStdioAllowExternalSpawn 争议条目**：当前 stdio external
  caller 默认 deny spawn / send / shutdown。后续如有用户呼声再加 setting
  `mcpStdioAllowExternalSpawn` + 全局更严格 spawn-rate（如 1/分钟）兜底
- **未实现 stdio cli 子命令暴露**：`agent-deck mcp` 子命令未在 cli.ts 注册，依赖
  B'2.a 完成 IPC 反向调用（stdio 子进程跑在独立 Node 进程，不能直接访问主进程
  sessionManager / adapterRegistry）。transport-stdio.ts module 已写好，下一阶段
  接 IPC 反向调用即可暴露
- **R3.E 阶段 deep-code-review skill 重写**：5 tool 是 R3 team 抽象的底层原语，
  R3.E11 把 deep-code-review skill 重写为「走 mcp__agent_deck__* 单范式」时直接
  消费本 ADR 定义的 5 tool
- **migration v009 占用与 R3.E 冲突解决**：本 ADR 占用 v009_mcp_spawn_chain；
  R3.E 改占 v010_agent_deck_teams（按时间顺序）。两个 migration 互不依赖，顺序无关
- **测试统计**：47 mcp tests passed（22 tools + 13 wait-reply-coordinator + 12
  spawn-guards） + 12 codex-mcp-injector + 13 codex toml-writer = 72 R2 新增。
  全套 vitest 293 passed，2 fail 是 worktree electron binary 已知问题
- **关联 reviews**：本轮 ADR reviewer 双对抗结论压在 docs/agent-deck-mcp-protocol.md §13
  「变更历史」内，未单独建 REVIEW_<N>.md 文件（ADR 自带审计链路）
