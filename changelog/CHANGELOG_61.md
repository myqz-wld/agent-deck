# CHANGELOG_61: R1.A 阶段 — Codex adapter 能力对齐 Claude（plan v3 落地，6 commit + spike 验证）

## 概要

实施「Agent Deck adapter-agnostic 多模型协作平台改造」plan v3 第一阶段：
让 codex-cli adapter 在 Agent Deck 内部跟 claude-code 同等 first-class，
覆盖事件流细度 / sandbox 持久化与冷切 / 间歇总结 / TOML 配置写入 / CLI 跨
adapter 5 个能力面。本次 6 个 atomic commit + 5 项 spike 实测验证 plan
关键假设。剩余 R1.A.A4b（设置面板 UI）/ A5（codex 注入 deck mcp，dep B'4）/
A8（codex-cli 单测扩展）作为后续 commit。

## 变更内容

### Spike 阶段（plan v3 5 项前置验证，全 ✅）

详见 `experiments/spikes/SPIKE_REPORT.md`：

- **spike-A2**：codex `resumeThread` + 切 sandbox 真透传生效（实测 rm canary.txt 被
  read-only sandbox 拒，OS 层 `Operation not permitted`）。CLI flag 顺序约束：
  `--sandbox X resume <id>` 必须前置。
- **spike-A3**：5 codex 并发 oneshot 总耗 10s + 单进程 ~44MB，复用 codex
  app-server 单例 daemon 模式；max-concurrent 与 claude SDK 同档 2-3 即可，
  无需按 adapter 分桶（反证 plan v2 风险评估的过度保守）。
- **spike-D5**：65KB AGENTS.md 完整加载（YES YES 500），`32KiB` 上限假设不存在
  （反证 reviewer-claude N1 finding）。
- **spike-B'-wire**：mcp-sdk 1.29.0 已封装 `StreamableHTTPServerTransport`，
  集成 fastify ~80 LOC，三协议总 ~400 LOC（plan v2 估 600 偏高）。
- **spike-B'-caller-id**：tool handler `extra: unknown` 不暴露 caller schema，
  必须强制 input schema 含 `caller_session_id` + in-process closure 覆盖。

### A1: codex item.updated 增量 + UI in-place upsert + tool-use-end status

`src/main/adapters/codex-cli/translate.ts`：

- 新增 `translateItemUpdated()` 转发 command_execution / mcp_tool_call 增量为
  `tool-use-start`（同 toolUseId + aggregatedOutput / status / exitCode），让
  UI 实时显示 codex 工具调用进度（典型场景：跑 30s 的 npm test，stdout 一行
  一行涨）。其它 item 类型增量仍跳过（agent_message / reasoning 文本去重复杂；
  file_change / web_search / todo_list / error 终态拿 item.completed 足够）。

`src/renderer/stores/session-store.ts`：

- 新增 `upsertEvent()` helper，pushEvent 对 tool-use-start 按 toolUseId
  in-place 替换；其它 kind 行为不变（unshift 倒序追加）。避免 30 秒长 command
  推几十条 update 撑爆 RECENT_LIMIT (200) 把上下文挤掉。

`src/main/adapters/claude-code/sdk-bridge/sdk-message-translate.ts`：

- claude tool_result block 的 `is_error` 翻为 `status: 'failed' | 'completed'`，
  与 codex tool-use-end 字段对齐（之前 claude tool-use-end 完全不区分成败）。

`src/renderer/components/activity-feed/rows/tool-row.tsx`：

- ToolEndRow 检查 `status / error / exitCode`：失败时红色边框 + "失败" 字样 +
  exit code badge（如 `exit 1`）。跨 adapter 统一显示。

### A2: codex sandbox 持久化（A2a）+ 冷切（A2b）

**A2a**（`490f3b4`）：

- DB migration v008 + `sessions.codex_sandbox` 列；SessionRecord 新增
  `codexSandbox?` 字段；session-repo `setCodexSandbox(id, sandbox)` 独立 UPDATE
  方法 + upsert SQL 全字段覆盖防 spread 静默丢失。
- codex bridge createSession 路径 sandboxMode 优先级链：
  `opts.codexSandbox > sessionRepo.codexSandbox (resume 路径) > bridge.currentSandboxMode`
- `codex.resumeThread(id, options)` 透传 sandboxMode / workingDirectory /
  approvalPolicy（之前 resume 路径只传 skipGitRepoCheck，新建时选过的 sandbox
  在 resume 后丢失被 SDK 默认覆盖）。
- 新建 + resume 两路径都调 setCodexSandbox 持久化。

**A2b**（`ed73637`）：

- AdapterCapabilities 新增 `canRestartWithCodexSandbox` bool；AgentAdapter 新增
  `restartWithCodexSandbox?(sid, sandbox, prompt)` 可选方法。各 adapter 默认
  false，codex-cli true。
- bridge.restartWithCodexSandbox 实现：emit 占位 message → closeSession
  (intentionallyClosed) → setCodexSandbox → createSession({resume, codexSandbox,
  prompt}) → 失败回滚 DB + emit error。与 claude restartWithPermissionMode 同
  范式。
- 新增 IPC channel `AdapterRestartWithCodexSandbox` + handler 校验 capability。
- preload `restartWithCodexSandbox(agentId, sid, sandbox, prompt)` API。

UI 端 SessionDetail 切档下拉留作 A2c follow-up。

### A3: Summarizer 跨 adapter dispatch + codex SDK oneshot runner

`src/main/session/summarizer.ts`：

- `summarize()` 按 `session.agentId` dispatch：
  - `'claude-code'` → `summariseViaLlm`（claude SDK haiku，原行为）
  - `'codex-cli'` → `summariseCodexSessionViaOneshot`（codex SDK low effort）
  - 其他 adapter → 跳过 LLM 直接走 fallback（最近 assistant 文字 / 事件统计）

`src/main/adapters/codex-cli/summarizer-runner.ts`（新建）：

- `summariseCodexSessionViaOneshot()`：codex SDK oneshot 跑总结
  - sandboxMode='read-only' 防工具调用 + approvalPolicy='never'
  - reasoning effort='low'（spike-A3 实测够用 + 出字快）
  - thread.run 同步等终态（不流式，oneshot 不需逐字渲染）
  - 懒创建 cachedCodex 实例 + 跟 settings.codexCliPath 联动失效

spike-A3 反证 codex oneshot 资源温和（5 并发 10s / ~44MB / app-server 单例），
与 claude SDK 共用全局 summaryMaxConcurrent 不需分桶。

### A4a: ~/.codex/config.toml MCP servers TOML writer

`src/main/codex-config/toml-writer.ts`（新建）+ 13 tests：

- marker 包裹策略：`# === Agent Deck MCP Servers START ... ===` 与 END 之间
  Agent Deck 自管，外面用户内容（含用户手写的 [model_providers.*] /
  顶层 model="..." / 用户自己的 [mcp_servers.X] 段）严格保留。
- 不引入 TOML parser 依赖（避免 @iarna/toml 120KB / smol-toml 5KB 新依赖
  打包负担）。行级正则解析 + 简单 TOML 序列化（codex mcp_servers 字段集
  受限：string / string array / nested env table 全部能手序列化）。
- atomic write（write tmp + rename）防进程崩溃 / 磁盘满留半截 toml。
- server name 正则校验 `[\w-/]+`；含 / 自动 quote 段名（agent-deck/<X>
  命名约定，A5 任务复用 namespace 避免与用户 server 撞名）。

后续 A4b（settings 字段 + IPC + UI 面板）、A5（agent-deck 自带 server 自动
注入，dep B'4）下个 commit 周期跟进。

### A9: agent-deck CLI new --adapter / --codex-sandbox

`src/main/cli.ts`：

- `--adapter` flag 与 `--agent` 等价（更通用命名，对齐 adapter 注册概念）。
- adapter 短名 alias 表：`codex` → `codex-cli`、`claude` → `claude-code`。
- `--codex-sandbox` flag 透传 codex per-session sandbox 档位（复用 CHANGELOG_60
  IPC 通路）。
- VALUE_REQUIRED_FLAGS 加 `adapter` / `codex-sandbox` 防静默吞值。

验证（用户手测）：

```bash
agent-deck new --adapter codex --cwd $PWD --prompt ping
agent-deck new --adapter codex --codex-sandbox read-only --prompt ping
agent-deck new --adapter claude --prompt 你好
```

## 备注

- 本批未做 R1.A4b（设置面板 UI 加 server / 编辑 / 删除）—— 跨 IPC + UI 渲染
  + 对 dev 环境实测依赖大，留 follow-up commit。
- 本批未做 R1.A5（codex 自动注入 Agent Deck MCP server）—— 依赖 R2.B'4
  （Agent Deck MCP server transport 落地）才能跑通端到端。
- 本批未做 R1.A8（codex-cli 单测扩展 translate / sandbox-restart / summarizer）
  —— A4a 已含 toml-writer 13 tests；A1/A2/A3 测试留 follow-up。
- A2c（UI sandbox 切档下拉）：bridge 接口已就绪，SessionDetail 加下拉即可。
- 关联 plan：`/Users/apple/.claude/plans/magical-puzzling-muffin.md` v3
- 关联 spike 报告：`experiments/spikes/SPIKE_REPORT.md`
- commit 链路：`da7f224` (A1) / `490f3b4` (A2a) / `ed73637` (A2b) /
  `a748af1` (A3) / `ff61b5a` (A4a) / `f33e01a` (A9)
