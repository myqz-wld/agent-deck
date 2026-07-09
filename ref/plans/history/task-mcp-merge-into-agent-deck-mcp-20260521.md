---
plan_id: "task-mcp-merge-into-agent-deck-mcp-20260521"
created_at: "2026-05-21T20:55:00+08:00"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/task-mcp-merge-into-agent-deck-mcp-20260521"
status: "completed"
base_commit: "698f345c1f4abd41b4a09949c2f6b12a12b9e237"
base_branch: "main"
final_commit: "413a1e0ad78a54af3b19667fab8e8c4fa3c319b2"
completed_at: "2026-05-24"
---
# Plan: task mcp 物理合并到 agent-deck-mcp，让 codex 也能用

## 总目标

把现 `src/main/task-manager/` 5 个 in-process MCP tool（`task_create` / `task_list` / `task_get` / `task_update` / `task_delete`）物理合并到 `src/main/agent-deck-mcp/tools/handlers/`，工具名从 `mcp__tasks__task_*` 改成 `mcp__agent-deck__task_*`，让 codex SDK 子进程通过现有 agent-deck-mcp HTTP transport 自动拿到这 5 个 tool（之前 codex 端完全没挂 tasks mcp，文档 vs 实现 contract mismatch）。

**起源**：用户问「task 系列的 mcp 没有放在 agent-deck 里吗，然后 codex cli adapter 好像看不到 task 系列」→ 调查铁证 codex SDK 子进程 `ensureCodex` 只通过 `buildAgentDeckMcpConfigForCodex` 注入 `mcp_servers.agent-deck`，**完全没注入 mcp_servers.tasks**；但 `resources/codex-config/CODEX_AGENTS.md:17-33` 文档明示「task 进度跟踪走 `mcp__tasks__*`」→ codex teammate 想跟踪进度时找不到 tool。本 plan 通过合并消除双 server / 让 codex 自动通过现有 HTTP transport 拿到 task tool 修复。

**RFC 3 轮收口共识**（本会话 + 上次会话）：
- D1 完全合并到 agent-deck server（工具名 `mcp__agent-deck__task_*`，breaking）
- D2 删 `enableTaskManager` settings 合一到 `enableAgentDeckMcp`
- D3 直接 breaking 一刀切，不做 dual-register / alias 兼容期
- D4 单 phase 一锅出
- D5 task handler schema 完全靠齐 agent-deck-mcp 现有 `makeCtx(args, extra)` pattern
- D6 `task_create` / `task_update` / `task_delete` 三写 deny external；`task_list` / `task_get` 读 allow
- D7 ingest 行为分流：in-process 路径继续 ingest；HTTP transport 路径 skip ingest
- D8 `src/main/store/task-repo.ts` 零动；mcp tool tests port 到 `agent-deck-mcp/__tests__/`

**修法核心**：task 5 个 handler 物理位置挪 + caller_session_id 反查模式（与现有 10 个 agent-deck-mcp tool 同款 `HandlerContext.caller.callerSessionId`）+ 删 enableTaskManager 双 toggle 合一 + 删独立 `tasksServer` 注入路径让 agent-deck-mcp 一个 server 暴露 15 个 tool。

**与 task-mcp-owner-session-id-rewrite-20260521（已 archive `698f345`）的关系**：本 plan 在该 plan 之上做物理位置 + 工具名重构，**不动 owner_session_id data model**（v023 schema 全保留）。两个 plan 正交：owner_session_id 改 data model 不改 tool 物理位置；本 plan 改物理位置不改 data model。

## 不变量

1. **工具命名无冲突**：5 个 task tool 名（`task_create` / `task_list` / `task_get` / `task_update` / `task_delete`）与现有 10 个 agent-deck-mcp tool（spawn_session / send_message / list_sessions / get_session / shutdown_session / archive_plan / hand_off_session / enter_worktree / exit_worktree / shutdown_baton_teammates）零冲突 → 合并后 `mcp__agent-deck__*` namespace 暴露 15 个 tool
2. **caller_session_id 防注入**：in-process transport closure override（`callerSessionIdOverride` lambda）永远优先于 `args.caller_session_id`。5 个 task tool handler 用 `makeCtx(args, extra)` 拿 `HandlerContext.caller.callerSessionId`，与现有 10 个 tool 完全对称
3. **external transport (HTTP + stdio) 写 deny 不漏**（R2 F-R2-5 修订 — reviewer-codex R2 LOW）：`task_create` / `task_update` / `task_delete` 三写命中 `EXTERNAL_CALLER_ALLOWED.task_* = false`；HTTP `fallbackToGlobal === true` 路径强制 reject（transport-http.ts spoofing 防御）+ **stdio sentinel 路径走 `denyExternalIfNotAllowed` helper deny**（helpers.ts:68-110 是 stdio 独立兜底）。与现有 spawn / archive_plan 同款防御
4. **owner_session_id data model 零动**：v023 schema（`owner_session_id NOT NULL REFERENCES sessions(id) ON DELETE CASCADE`）+ `reassignOwner` API + `agentDeckTeamRepo.findActiveMembershipsBySession` / `listActiveMembers` reverse join 视野算法 + `agentDeckTeamRepo.findSharedActiveTeams` same-team 写权限校验完全沿用，本 plan 不碰
5. **task-repo / task-changed eventBus / IPC TaskChanged 推 renderer 路径不动**：`src/main/store/task-repo.ts` + `src/main/store/__tests__/task-repo.test.ts` 零动；`task-changed` eventBus + IPC `TaskChanged` 推 renderer 路径完全不动，renderer TasksSection 行为零回归
6. **enableTaskManager 用户老配置自动清理**：settings-store.ts `REMOVED_KEYS` 加 `'enableTaskManager'`，下次启动 `delete` 历史 key；UI 不再有此开关
7. **claude-code adapter 单 mcp server**：`query-options-builder.ts` + `mcp-server-init.ts` 不再起独立 `tasksServer`，只剩 `agentDeckMcpServer` 一个（allowedTools 单一 pattern `mcp__agent-deck__*`）
8. **`isTaskMcpTool` 切前缀 + 注释明示 dead helper**（R1 F5 修法 — reviewer-codex LOW-2 验证 / reviewer-claude MED-3 反驳前提失效）：`isTaskMcpTool` 当前是 **dead helper**（`grep -rln isTaskMcpTool src/` 全仓只命中 `read-only-tools.ts` 自己定义 + 历史 changelog / plan 引用，**无生产 import**；`can-use-tool.ts:74` 走 `READ_ONLY_TOOLS.has(toolName) || toolName.endsWith('__ImageRead')` 不调本 helper；agent-deck in-process 工具放行靠 `allowedTools: [AGENT_DECK_MCP_TOOL_PATTERN]` 通配，与本 helper 无关）。teammate auto-approve 路径同款不调本 helper。修法两选一：(a) 同步切前缀 `mcp__tasks__` → `mcp__agent-deck__task_` + 加 jsdoc `/** 注意：当前 dead helper，无生产 import；保留兼容历史 grep / 未来若 inbox-watcher / auto-approve 路径接入此 helper 不需要再改前缀 */`；(b) 直接 delete 整个 helper（最干净）。**默认走 (a)** 保留兼容（删 helper 撞 changelog / plan 历史引用 grep 不一致）
9. **应用打包 CLAUDE.md + CODEX_AGENTS.md §task 进度跟踪节双端同步**：`resources/claude-config/CLAUDE.md` + `resources/codex-config/CODEX_AGENTS.md` 双端工具名 `mcp__tasks__*` → `mcp__agent-deck__task_*`，删 `enableTaskManager` 例外注释。codex 端额外删「codex 端无原生 task 工具」对称化注释（现在 codex 端真能用 task 工具了）

## 设计决策（不再争论 — RFC 三轮共识 + 上次会话收口）

### D1: 完全合并到 agent-deck server（RFC 第 1 轮 Q1 选 A）

用户 RFC 第 1 轮 Q1 选「完全合并到 agent-deck server」。5 个 task handler 挪到 `src/main/agent-deck-mcp/tools/handlers/task-{create,list,get,update,delete}.ts`，工具名 `mcp__agent-deck__task_*`。breaking change（工具名换）。

理由：单 server / 单架构 / 单 HTTP 路由 /mcp 暴露 15 个 tool，长期维护负担最低。codex SDK 子进程通过现有 `buildAgentDeckMcpConfigForCodex` HTTP transport 自动拿到 5 个新 task tool，零额外注入工作。tasks 独立 server / 共享 HTTP 路由两个备选（保 `mcp__tasks__*` 不 break）增加双 server 维护成本无收益。

### D2: 删 enableTaskManager 合一 + 老用户 ON 迁移守护（RFC 第 1 轮 Q2 选 A + R1 F11 修法）

用户 RFC 第 1 轮 Q2 选「删 enableTaskManager 合一」。task tools 跟随 `enableAgentDeckMcp` 开关；settings-store.ts `REMOVED_KEYS` 加 `enableTaskManager` 自动清理用户老配置。

**关键迁移守护**（R1 F11 修法 — reviewer-codex R1 补充 MED）：单纯 `REMOVED_KEYS` delete 让 **raw `enableTaskManager === true` + raw 不含 `enableAgentDeckMcp`** 的老用户静默失能（task tools 跟随仍为 false 的 `enableAgentDeckMcp` → 从「task tools 可用」变「不可用」）。修法：settings-store.ts 加 smart migration 钩子，**在 `REMOVED_KEYS` delete 循环之前** 读 raw 值：

- raw `enableTaskManager === true` 且 raw 不含 `enableAgentDeckMcp` → set `enableAgentDeckMcp = true` 后再 delete legacy（保留老用户「task tools 可用」语义）
- raw `enableTaskManager === false` 或不含 → 不动 `enableAgentDeckMcp`，直接 delete legacy（老用户主动 OFF 表达「不想用」尊重；新用户默认 OFF）
- raw 含 explicit `enableAgentDeckMcp` 值 → 不被 legacy 覆盖（用户后期决策优先）

代码位置（R2-claude-MED-1 修订 + R3-claude-MED-1 行号精确化 — 现场 cat verify）：`src/main/store/settings-store.ts:49-78`（migration 段 + delete loop 完整范围）— **插入点 line 74**（`for (const key of REMOVED_KEYS) {` 起头那行之前，与现有 migration 段 49-73 同款 `if (raw.X !== undefined && raw.Y === undefined) → migrate` pattern 对齐）。⚠️ R3 修订：R2 写的「插入点 71」是错的 — line 71 在 mcpSpawnRatePerMinute migration block 内部 `store.set` 调用（67-73 整个 if-body），不是 delete loop 之前。**实施前按 Step 13 grep guard 重核**（line 漂移 ±5 容差仍走 grep 结果）

理由：单 toggle 心智模型最简单 + breaking change 不引入用户感知破坏；smart migration 让用户「无感升级」。

### D3: 直接 breaking 一刀切（RFC 第 1 轮 Q3 选 A）

用户 RFC 第 1 轮 Q3 选「直接 breaking 一刀切」。不做 dual-register / alias 兼容期。

理由：dual-register 短期兼容需多写 ~50 行 alias router + 永久双工具入口维护成本无收益（reviewer agent body / SKILL / 文档 grep 已确认 0 hit `mcp__tasks__*` 硬编码字面量；live SDK session 用旧名调撞「Unknown tool」是合理 breaking 信号）。

### D4: 单 phase 一锅出（RFC 第 1 轮 Q4 选 A）

用户 RFC 第 1 轮 Q4 选「单 phase 一锅出」。一次 review / 一次合入。配合 D3 breaking 一刀切最自然。

理由：拆 phase 增加多轮 deep-review / 多次 commit / 多次切换状态机的成本，单 phase 改动量约束在「物理位置挪 + 工具名换 + 删 toggle」三件事，scope 边界清晰。

### D5: schema 完全靠齐 agent-deck-mcp 现有 pattern（RFC 第 2 轮 Q1 推荐）

5 个 task tool schema 加 `caller_session_id?: string` + `parent_session_id?: string`，handler 进 `makeCtx(args, extra)` 拿 `HandlerContext.caller.callerSessionId`，反查 `sessionRepo.get(sid)` + `agentDeckTeamRepo.findActiveMembershipsBySession(sid)` 走 owner_session_id 闭包 / visible scope 算法 / same-team check（与 v023 实现等价）。

理由：单 server 单 pattern 心智模型最简单；HTTP transport 自动复用现有 `makeCtx` / `resolveCallerSidForReadOnly` / `EXTERNAL_CALLER_SENTINEL` 路径；in-process closure override（`callerSessionIdOverride` lambda）行为零回归。保留双 pattern 违反 user CLAUDE.md §约束 1 信息密度（同款规则不抽到一处）。

### D6: 写 deny external / 读 allow external（RFC 第 2 轮 Q2 推荐；R1 F1 修法）

`EXTERNAL_CALLER_ALLOWED` 当前是严格 `Record<AgentDeckToolName, boolean>` 类型（`src/main/agent-deck-mcp/types.ts:110-121`），10 个 tool 全部显式枚举，不存在「不加 = 默认 allow」语义。加 5 个 task tool 必须**显式 5 entries**：

- `task_create: false` / `task_update: false` / `task_delete: false`（与 spawn / shutdown / archive_plan 同款 deny external）
- `task_list: true` / `task_get: true`（与 list_sessions / get_session 同款显式 allow）

理由：写操作污染 universal team backend 数据（UUID 不可恢复 + blocks 链路混乱 + owner_session_id 跨 session FK 误改），与现有 8 个写 tool 防御模式一致；只读没 spoofing 风险，挡住合法 read-only mcp client（如 Inspector / 监控脚本）查询自己已知 task_id 是合法 use case。

⚠️ **R1 F1 修法**（双方独立 — reviewer-codex HIGH / reviewer-claude MED-1）：旧版本措辞「`task_list / task_get` 不加 → 允许 external（默认 allow）」与现有 `Record` 严格类型契约冲突 — TS 编译会撞 `Property 'task_list' is missing in type '...'`；即使绕过类型，`denyExternalIfNotAllowed` 内 `!EXTERNAL_CALLER_ALLOWED[toolName]` 把 `undefined` 当 `true`（deny），read allow 语义同时丢。修后强制显式 5 entries。

### D7: ingest 跨 adapter 分流（RFC 第 2 轮 Q3 推荐）

- in-process 路径继续 ingest `team-task-*` AgentEvent 到 caller sid（claude SDK session events 流看得到，与 v023 现状等价）
- HTTP transport 路径 ingest skip（caller 是 codex SDK 子进程时不写 events）
- `task-changed` eventBus + IPC `TaskChanged` 推 renderer 路径完全不动（与 ingest 解耦）

理由：codex SessionDetail 渲染 team-task-* AgentEvent 完全未实证（CHANGELOG_<X> A3 / v023 ingest 路径只在 claude in-process 验证过），ingest 进 codex sid 风险大需 spike；保守路径让 renderer task UI 零回归 + claude in-process TeamDetail 看 task 操作能力保留；如真需要 codex teammate 跟踪 task 进度，后续单独 spike 加 ingest 时间窗口不紧。

实施：handler 内通过 `ctx.caller.transport === 'in-process'` 判断走 ingest 分支；HTTP / stdio 路径跳过 `sessionManager.ingest` 调用。

### D8: task-repo 位置不动 + tests port（RFC 第 2 轮 Q4 推荐）

- `src/main/store/task-repo.ts` + `src/main/store/__tests__/task-repo.test.ts` **零动**（含 v023 owner_session_id schema + `reassignOwner` API）
- `src/main/task-manager/__tests__/{tools.crud,tools.read-ingest}.test.ts` **port** 到 `src/main/agent-deck-mcp/__tests__/task-{crud,events}.test.ts`（改 import 路径 + 适配 HandlerContext mock + 改 mock pattern 走 makeCtx 注入 vs 旧 closure 注入）
- `src/main/task-manager/` 整个子目录删空（`server.ts` + `tools.ts` 删；`__tests__/` 内文件搬走后删空）

理由：task-repo 是 IPC `TaskList` renderer caller + mcp handler 双消费者的共享 store 层（与 sessionRepo / agentDeckTeamRepo 同级），物理位置 `src/main/store/` 是正确的层。tools.crud.test.ts / tools.read-ingest.test.ts 是 mcp tool 测试（不是 repo 测试），跟着 handler 一起迁是 §约束 7 同步约束硬要求。

## 步骤 checklist

- [ ] Step 0: 进 EnterWorktree（plan-driven，新会话 cold start 必走）
- [ ] Step 0.5: 加 `src/main/agent-deck-mcp/tools/handlers/task-helpers.ts`（R1 F12 修法 — reviewer-codex R1 补充 LOW）— 抽现有 `task-manager/tools.ts:71-154` **4 个 runtime helper**（依赖 store/team repo）：`argsToInputWithoutOwner` / `getVisibleOwnerSessionIds`（含 F2 archived team filter）/ `isCallerAuthorizedToWrite`（findSharedActiveTeams + caller==owner 特例）/ `getCallerFirstTeamName`，5 个 task handler import 复用。⚠️ R3-claude-MED-2 修订：R2 写的范围 50-154 含 STATUS_VALUES at line 50（已移 schemas.ts）+ ok/err helper at 52-63（agent-deck-mcp/tools/helpers.ts:140-173 已有同款），与本步骤后文「STATUS_VALUES 不放本文件」自相矛盾，**精确范围 71-154**（仅 4 个 runtime helper 起讫行）。**STATUS_VALUES 不放本文件**（R2 F-R2-4 修订 — 避免 schema 层从 handler 层间接拉 sessionRepo / agentDeckTeamRepo 运行时依赖，破坏 `schemas.ts` 只依赖 zod 的纯 schema 边界）→ 放 `src/main/agent-deck-mcp/tools/schemas.ts` 顶部 export（schema 层 enum 天然位置），handler 从 schemas.ts import STATUS_VALUES。**实施前按 Step 13 grep guard 重核行号**（line 漂移 ±5 容差仍走 grep 结果）。**测试**：Step 18-20 测试直接覆盖 shared helper（archived team filter / same-team predicate / first team lookup）
- [ ] Step 1: 加 `src/main/agent-deck-mcp/tools/handlers/task-create.ts` — 从 task-manager/tools.ts 抽 task_create handler，重写成 `(args, ctx: HandlerContext) => HandlerResult` 形式，caller_session_id 走 `ctx.caller.callerSessionId`，ingest 走 `ctx.caller.transport === 'in-process'` 分支；**注册时（Step 7）传 annotations**（R1 F3 修法）：`{readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:false}`
- [ ] Step 2: 加 `src/main/agent-deck-mcp/tools/handlers/task-list.ts` — 同上，visible scope 算法（caller 同 team active member sids union {callerSid}，含 F2 archived team filter）原样保留；现有 `{annotations: {readOnlyHint: true}}` 透传
- [ ] Step 3: 加 `src/main/agent-deck-mcp/tools/handlers/task-get.ts` — 跨 team 只读直接 `taskRepo.get(args.task_id)`；现有 `{annotations: {readOnlyHint: true}}` 透传
- [ ] Step 4: 加 `src/main/agent-deck-mcp/tools/handlers/task-update.ts` — same-team check 走 `isCallerAuthorizedToWrite` helper，caller == owner 特例直跳；status pending→completed 时 ingest（in-process 分支）；**注册时（Step 7）传 annotations**（R1 F3 修法）：`{readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:false}`
- [ ] Step 5: 加 `src/main/agent-deck-mcp/tools/handlers/task-delete.ts` — same-team check + cascade predicate（与现状代码对齐 — `task-manager/tools.ts:419-422`）：`(_id, ownerSid) => isCallerAuthorizedToWrite(callerSid, ownerSid)`；**注册时（Step 7）传 annotations**（R1 F3 修法 + R2 F-R2-1 修订）：`{readOnlyHint:false, destructiveHint:true, idempotentHint:false, openWorldHint:false}`（`destructiveHint: true` ⚠️ — task_delete 真删 + cascade 下游；`idempotentHint: false` ⚠️ — 与现状 contract 对齐：`task-manager/tools.ts:409-410` not-found 返 isError 不是 noop，保守不改 handler contract 不扩 scope）
- [ ] Step 6: 加 `src/main/agent-deck-mcp/tools/schemas.ts` 内 5 个 `TASK_*_SHAPE / TASK_*_ARGS_SCHEMA`（snake_case + caller_session_id?/parent_session_id? 加进去与现有 10 个 tool 对称）
- [ ] Step 7: 改 `src/main/agent-deck-mcp/tools/index.ts` buildAgentDeckTools 末尾**注册 5 个新 tool 时显式传 annotations**（R1 F3 修法 — 见 Step 1/4/5 单 tool 注释）；改 `src/main/agent-deck-mcp/types.ts` `AGENT_DECK_TOOL_NAMES` 加 5 个新 tool name（task_create/list/get/update/delete）。**schema 注册 pattern**（R3-claude-LOW-1 修订）：5 个 task tool 用 **plain SHAPE 注册**（与现有 8 个 simple tool spawn/send/list/get/shutdown/enter/exit/baton-teammates 同款），**不**走 archive_plan / hand_off_session 的 `ARGS_SCHEMA.safeParse-wrapper` pattern — task tools 无 `.strict()` / `.refine()` invariant 需 production 真跑校验；`TASK_*_ARGS_SCHEMA` 仅供单测 `safeParse` 用，production 路径走 plain SHAPE。**末端 inline 补**（R1 F6 修法 + R3-codex-LOW-2 修订 — reviewer-claude LOW-1 + reviewer-codex R3 LOW 指出英文 `10 tool` / `7 个 handler` 也命中）：同步 `src/main/agent-deck-mcp/transport-http.ts:23-25` 头部 JSDoc + `:122` 内注释 tool 数量「5+5 = 10」/「5 个 agent-deck tool」→ 全改为「15 个 tool（10 现有 + 5 task）」。**同步改其他 agent-deck-mcp 模块描述**：`tools/index.ts:2` / `tools/schemas.ts:2` / `tools/schemas.ts:610` / `tools/helpers.ts:115` 当前模块描述含 `10 tool` 英文计数；不动 `types.ts` 内 CHANGELOG_100「10 → 7 tool」历史叙述
- [ ] Step 8: 改 `src/main/agent-deck-mcp/types.ts` `EXTERNAL_CALLER_ALLOWED` 加**显式 5 entries**（R1 F1 修法）：`task_create: false` / `task_update: false` / `task_delete: false` / `task_list: true` / `task_get: true`。**强制全部显式赋值**（不存在「不加 = allow」语义，详 §D6 R1 F1 修法注释）
- [ ] Step 9: 删 `src/main/task-manager/` 整个子目录（`server.ts` + `tools.ts` + `__tests__/` 整批）
- [ ] Step 10: 改 `src/main/adapters/claude-code/sdk-bridge/mcp-server-init.ts` 删 tasksServer 段（只剩 agentDeckMcpServer 一个），返回类型从 `{ tasksServer, agentDeckMcpServer }` 简化为 `{ agentDeckMcpServer }`
- [ ] Step 11: 改 `src/main/adapters/claude-code/sdk-bridge/query-options-builder.ts` 删 `tasksServer` 拼装 + 删 `'mcp__tasks__*'` allowedTools pattern，只剩 `agentDeckMcpServer` + `AGENT_DECK_MCP_TOOL_PATTERN`
- [ ] Step 12: 改 `src/shared/types/settings.ts` 删 `enableTaskManager: boolean` 字段 + 默认值 + **同步删上方 jsdoc**（R3-claude-LOW-2 修订 — settings.ts:194-207 jsdoc 含 `mcp__tasks__task_create / list / get / update / delete` literal 必须一并删，避免 §Step 14 末 grep 0-hit invariant 落不下来）；改 `src/main/store/settings-store.ts` 加**smart migration 钩子**（R1 F11 修法 — reviewer-codex R1 补充 MED）：**`REMOVED_KEYS` delete 循环之前**读 raw 值，若 `raw.enableTaskManager === true && raw.enableAgentDeckMcp === undefined` → set `enableAgentDeckMcp = true` 后再 delete legacy；其他 case 直接 delete（详 §D2 R1 F11 修法）。然后 `REMOVED_KEYS` 加 `'enableTaskManager'` 自动清孤儿
- [ ] Step 13: 改 `src/renderer/components/settings/sections/ExperimentalSection.tsx` **删整个 enableTaskManager Toggle + description div 完整 block**（R3-claude-LOW-2 修订 — line 25-38 完整 block，含 line 31 description div 内 `mcp__tasks__*` literal；implementer 只删 `<Toggle>` element 留 dangling description div + literal 会让 §Step 14 末 grep 0-hit invariant 落不下来）；**改 `src/renderer/components/settings/sections/AgentDeckMcpSection.tsx:13,39`**（R1 F10 修法 — 我自己 grep 发现）：「10 个 tool」→「15 个 tool」+ 列名加 5 个 `task_*`；**改 `src/renderer/components/SettingsDialog.tsx:26`** 「10 个 section」如非 tool 数量描述则不动（grep 确认）。**实施前 grep 重核 guard**（R2-claude-MED-3 修订 — reviewer-claude R2 MED-3）：跑 `Bash: grep -nE 'enableTaskManager|10 个 tool|TaskManager|mcp__tasks__' src/renderer/components/settings/sections/AgentDeckMcpSection.tsx src/renderer/components/settings/SettingsDialog.tsx src/renderer/components/settings/sections/ExperimentalSection.tsx` 重新核对实际 line 号；若与 plan 标注超 ±5 行漂移则**走 grep 结果**，并在 commit message 注明 line drift `<plan-old>→<actual-new>`。同款 grep 重核 guard 适用其他 §Step 含 hardcode line ref 的地方（如 §Step 0.5 `task-manager/tools.ts:71-154` 范围引用）
- [ ] Step 14: 改 `src/shared/constants/read-only-tools.ts` `isTaskMcpTool` 前缀 `mcp__tasks__` → `mcp__agent-deck__task_`；改注释 / jsdoc 同步语言 + 加 jsdoc 明示当前 dead helper（R1 F5 修法 — `grep -rln isTaskMcpTool src/` 全仓只命中本文件定义，无生产 import）。**保留删除决策溯源**（R2-claude-LOW-1 修订 — reviewer-claude R2 LOW-1）：R1 reviewer-codex 用 `grep -rln isTaskMcpTool src/` 反证全仓库仅 1 hit（定义本身），无生产 import → confirmed dead helper；reviewer-claude R1 MED-3 提出「prefix 匹配比 hardcode 5-tuple 更安全」时未自己 grep 验证 → 被 codex 反证后 lead 三态裁决 reverse（避免未来 reviewer 翻出来再 propose 同款 hardcode 5-tuple 方案）。**实施末验证命令拆两条**（R3-codex-LOW-1 修订 — reviewer-codex R3 LOW 指出原单条与默认保留 helper 决策互斥）：
  - `grep -Rns 'mcp__tasks__' src/` 应仅返 **0 hit**（src/ 内 `mcp__tasks__` 字面量全清）
  - `grep -Rns 'isTaskMcpTool' src/` 应**仅命中 `src/shared/constants/read-only-tools.ts`**（默认走修法 (a) 保留 helper 切前缀，定义本身允许命中；其他 src/ 路径任何 import 都是 root-cause 信号）
- [ ] Step 15: 改 `resources/claude-config/CLAUDE.md` §task 进度跟踪节工具名 `mcp__tasks__*` → `mcp__agent-deck__task_*`；删「应用 settings `enableTaskManager: false` 关闭时…」例外注释；改 §hand_off_session §app-only 差异节内 task 过继提到的工具名（如有 `mcp__tasks__` 字面量）。**额外**（R1 F7 修法 — reviewer-claude LOW-2）：改 §Agent Deck Universal Team Backend 节首句「Agent Deck MCP 10 tool」→「Agent Deck MCP 15 tool」+ tool name 列表加 5 个 `task_create / task_list / task_get / task_update / task_delete`
- [ ] Step 16: 改 `resources/codex-config/CODEX_AGENTS.md` 同款节同款改；额外删「codex 端无原生 task 工具」对称化注释（合并后两端对称都能用）；同步 §Agent Deck Universal Team Backend 节首句 10 tool → 15 tool（与 claude-config 同款）
- [ ] Step 17: grep 项目内残留**系统化 pattern**：`mcp__tasks__|enableTaskManager|tasksServer|10 个 tool|10 tool|7 个 handler|5 个 agent-deck tool|@main/task-manager|task-manager/server|getTasksMcpServerForSession|buildTaskTools|server: ['\"]tasks['\"]`（R1 F2 + F10 + F14 修法 + R3-codex-MED-1/MED-2/LOW-2 grep guard 扩展 — 覆盖中英文 tool 计数 / task-manager module import / codex fixture server 字段）。changelog/ reviews/ plans/* 历史归档不动；`types.ts` CHANGELOG_100「10 → 7 tool」历史叙述不动；**显式必改 live 资产**：
  - `src/renderer/components/activity-feed/tool-icons.ts:60-64` — 5 个 emoji 映射 key `mcp__tasks__task_*` → `mcp__agent-deck__task_*`（R2 F-R2-2 修订：本项**不**新增 tool-icons 单测，与 Round 2 skip 「INFO 1 ❌ 不接受 tool-icons UI 测试因 ROI 低」对齐）。**额外**（R3-claude-LOW-2 修订）：同步切 `tool-icons.ts:15-23` jsdoc 内 `mcp__tasks__task_*` literal（line 16 + line 23 描述文本），避免 §Step 14 末 grep 0-hit invariant 落不下来
  - `src/main/adapters/codex-cli/__tests__/translate.test.ts:346,596` — 2 处 fixture 字面量 `mcp__tasks__task_create` / `mcp__tasks__task_list` 改 `mcp__agent-deck__task_*`。**额外**（R3-codex-MED-1 修订）：**同步修 fixture 输入 `server: 'tasks'` → `server: 'agent_deck'`**（codex translate.ts:245/285/348 按 `mcp__${i.server}__${i.tool}` 拼接，只改 expected 不改 input 会让测试失败）。grep guard 加 `server: ['\"]tasks['\"]`
  - **桥接 tests 删 task-manager module mock**（R3-codex-MED-2 修订 — reviewer-codex R3 MED 现场 grep 反证）：`src/main/adapters/claude-code/sdk-bridge/__tests__/createsession-fail-fast.test.ts:84` + `setttimeout-fallback-symmetry.test.ts:88` 含 `vi.mock('@main/task-manager/server')` mock，Step 9 删整个 task-manager 目录后该 mock 指向已删模块 → 测试 module not found。修法：删该 mock 或切到 `@main/agent-deck-mcp/server` path（task tool 已合并入 agent-deck-mcp）
  - `docs/agent-deck-team-protocol.md` — ⚠️ **R1-mixed-codex MED-A 反驳记录 → 见 §已知踩坑 #9**：经现场 verify doc 头部明示「**状态**：ACCEPTED（2026-05-11）R3 阶段架构决策记录」属 **ADR archived 历史归档**（与 changelog/ reviews/ plans/ 同档），内含 `mcp__tasks__` 字面量是当时 (R3 时代) 工具命名描述合规 historical reference 不应改。**Step 17 此条 supersede by #9**：ADR archived 类不动；docs 内 live API/protocol doc stub（如 `docs/agent-deck-mcp-protocol.md`）才改
  - `README.md` — 用户可见文档 + 与 CLAUDE.md §改动后必做 第 1 步硬要求同步
  - `src/main/__tests__/_shared/mocks/{sdk-loader,event-bus}.ts` — 测试 mocks 如有引用
  - 其他 grep 残留按出现逐个判断（live → 改 / 历史归档 → 不动）
- [ ] Step 18: port `tools.crud.test.ts` → `src/main/agent-deck-mcp/__tests__/task-crud.test.ts`：buildTaskTools(sessionIdProvider) 调用改成 buildAgentDeckTools({callerSessionIdOverride, transport}) 走 makeCtx；handler 调用从 `handler(args, undefined)` 改成 `handler(args, extra)` 形式
- [ ] Step 19: port `tools.read-ingest.test.ts` → `src/main/agent-deck-mcp/__tests__/task-events.test.ts`：同款适配 + 加 `transport: 'http'` 分支 ingest skip 测试（D7 新增）
- [ ] Step 20: 加 `src/main/agent-deck-mcp/__tests__/task-external-caller.test.ts`：**HTTP transport** `fallbackToGlobal=true` → task_create/update/delete 三写 reject；task_list/get 通过（D6 + R2 F-R2-5 修订 HTTP 路径）。**额外加 stdio transport 场景**（R2 F-R2-5 — reviewer-codex R2 LOW）：stdio sentinel caller_session_id 走 `denyExternalIfNotAllowed` 对 task_create/update/delete 三写返 deny；task_get 通过；task_list visible scope 空（caller sentinel 不属任何 team → ownerSessionIds = [sentinel] → 空结果是预期）
- [ ] Step 21: 加 / 改 `src/main/agent-deck-mcp/__tests__/spoofing-attack-paths.test.ts` 覆盖 5 个 task tool 场景（D5 防注入 closure override，与现有 10 个 tool 同款）。**额外** R2 F-R2-5 配套：spoofed `caller_session_id` 走 stdio sentinel deny path（与 helpers.ts:89-110 stdio non-sentinel invariant 同款）
- [ ] Step 22: 加 settings REMOVED_KEYS 集成测试（如 `src/main/store/__tests__/settings-store.test.ts` 存在），verify `enableTaskManager` 老值被自动 delete
- [ ] Step 23: 加 / 改 ExperimentalSection 单测（如 `src/renderer/components/settings/sections/__tests__/` 存在），verify toggle UI 不再渲染
- [ ] Step 24: `zsh -i -l -c "pnpm typecheck"` 全过；`pnpm build` 全过；`pnpm exec vitest run` 全套通过
- [ ] Step 25: invoke `/agent-deck:deep-review` SKILL kind='mixed'（plan + code 实施一致性）— reviewer 出 finding 修到共识 0 HIGH 0 真 MED
- [ ] Step 26: 收口 — 先写 CHANGELOG_<X>.md 引用本 plan + commit 进 main repo（archive_plan 不会自动写 changelog 引用），然后 `ExitWorktree(action: "keep")` → 调 `mcp__agent-deck__archive_plan({ plan_id, worktree_path, base_branch: "main", changelog_id: "<X>" })`

## 当前进度

- ✅ 调查铁证 codex 端没挂 tasks mcp（contract vs implementation mismatch）
- ✅ RFC 三轮收口（D1-D8 + 不变量 + 测试矩阵 + 无 spike 决策 + 已知踩坑齐）
- ✅ 等 owner_session_id plan 收口（已合入 main commit `eb90a8e` + archive commit `698f345`）
- ✅ 写本 plan 文件
- ⏳ 下一步：§Step 1.5 Deep-Review 评审本 plan，0 HIGH 0 真 MED 后 user confirm 进 worktree

## 下一会话第一步（cold start 必读）

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/task-mcp-merge-into-agent-deck-mcp-20260521.md` 全文（看 §当前进度 / §步骤 checklist）
2. **worktree 不存在**（本会话还没进 worktree，等 §Step 1.5 deep-review 后 user confirm）→ 新会话 cold start **按 adapter 分双路径**（R1 F4 修法 — reviewer-codex MED）：

   - **claude SDK 会话 (claude-code adapter)**：避开 EnterWorktree CLI v2.1.112 stale base bug 走 Bash 显式建 worktree + `EnterWorktree(path:)` 进入。**Bash 命令末尾必须追加 base_commit `698f345c1f4abd41b4a09949c2f6b12a12b9e237`**（不传时 git 默认用 HEAD，main 前进后会落到新 HEAD 不是 plan frontmatter base）：
     ```bash
     git -C /Users/apple/Repository/personal/agent-deck worktree add -b worktree-task-mcp-merge-into-agent-deck-mcp-20260521 /Users/apple/Repository/personal/agent-deck/.claude/worktrees/task-mcp-merge-into-agent-deck-mcp-20260521 698f345c1f4abd41b4a09949c2f6b12a12b9e237
     ```
     然后 `EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/task-mcp-merge-into-agent-deck-mcp-20260521")`

   - **codex SDK 会话 (codex-cli adapter)**：codex 无 native EnterWorktree builtin，走 mcp tool 一步完成（参数显式传 base_commit 让 enter-worktree-impl.ts 内部 `git worktree add -b <branch> <path> <base_commit>` 锁版本）：
     ```ts
     mcp__agent-deck__enter_worktree({
       plan_id: "task-mcp-merge-into-agent-deck-mcp-20260521",
       base_commit: "698f345c1f4abd41b4a09949c2f6b12a12b9e237"
     })
     ```
     该 tool 自动 setCwdReleaseMarker，archive_plan 预检 4 态分流认得跨 adapter 路径。**注**：codex SDK session 后续 shell 命令需显式 `git -C <worktree_path>` 或 worktree 绝对路径（mcp enter_worktree 不改 codex shell 默认 cwd，详 `resources/codex-config/CODEX_AGENTS.md §enter_worktree`）
3. `git -C <worktree_path> rev-parse HEAD` 自检 = base_commit `698f345c1f4abd41b4a09949c2f6b12a12b9e237`
4. **优先 Step 1-9**（add 5 个 handler + schemas + tools/index.ts 注册 + types.ts EXTERNAL_CALLER_ALLOWED + 删 task-manager/）→ Step 10-17（删独立 tasksServer 注入路径 / 删 settings toggle / 改 UI / 改文档 / grep 残留）→ Step 18-23（tests port + 新增 D6 D7 D5 测试）
5. **Step 24** `zsh -i -l -c "pnpm typecheck"` + `pnpm build` + `pnpm exec vitest run` 全过
6. **Step 25** invoke `/agent-deck:deep-review` SKILL kind='mixed'，args 含本 plan 路径 + 主代码变更文件清单（5 task handler 新增 / task-manager/ 删 / settings.ts / settings-store.ts / mcp-server-init.ts / query-options-builder.ts / read-only-tools.ts / ExperimentalSection.tsx / resources/claude-config/CLAUDE.md / resources/codex-config/CODEX_AGENTS.md / tools/schemas.ts / tools/index.ts / types.ts）
7. **Step 26** 先写 `CHANGELOG_<X>.md` 引用本 plan + commit 进 main repo（archive_plan 不会自动写 changelog 引用），然后 `ExitWorktree(action: "keep")` → `mcp__agent-deck__archive_plan({ plan_id: "task-mcp-merge-into-agent-deck-mcp-20260521", worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/task-mcp-merge-into-agent-deck-mcp-20260521", base_branch: "main", changelog_id: "<X>" })`
8. **不重新讨论已记录的 §设计决策 D1-D8**；如需变更先告诉用户征得确认再改

## 已知踩坑

1. **dormant teammate resume 调旧名**：长期挂着的 reviewer dormant 后 resume，第一条 reply 若硬编码 `mcp__tasks__*` 会撞「tool not found」。Mitigation：reviewer body grep 已确认 0 hit；reviewer reply 本身不调 task tool（task tracking 是 lead 职责）；如未来某 reviewer 主动调 task 需重 spawn
2. **老 jsonl history 旧字面量**：CLI history 显示 `mcp__tasks__task_create` 但实际工具已下线 → 仅显示「Unknown tool」不影响运行，jsonl 本身不重放调用
3. **已落盘 plan 文件旧字面量**：completed `plans/*.md` 下若有 plan 引用 `mcp__tasks__*` 字面量是历史归档不改；in_progress 工作中 plan（如 `handoff-render-and-image-batch-20260521.md`）若有引用需 grep 改
4. **用户老配置 `enableTaskManager: true / false`** → settings-store.ts REMOVED_KEYS 自动清，无感知；UI 不再有此开关。如用户原来手动 toggle OFF 表达「不想用 task tools」，合并后无单独开关只能整体关 `enableAgentDeckMcp`（按 D2 决策接受此 trade-off）
5. **测试 mocks 引用 + 3 个 live 资产文件硬列**（R1 F2 修法 — 双方独立 reviewer-codex LOW-1 + reviewer-claude MED-2；R3-codex LOW 修订 — 从 4 条减到 3 条，docs/agent-deck-team-protocol.md 是 ADR archived 移出，详 #9）：`src/main/__tests__/_shared/mocks/sdk-loader.ts` 与 `event-bus.ts` 如有 `mcp__tasks__` 字面量需一并切；**Step 17 已显式 inline 3 个 live 资产**：`activity-feed/tool-icons.ts:60-64` / `codex-cli/__tests__/translate.test.ts:346,596` / `README.md`（详 Step 17；`docs/agent-deck-team-protocol.md` ADR archived 不在此列见 #9）。Step 17 grep pattern 扩展为 `mcp__tasks__|enableTaskManager|tasksServer|10 个 tool|5 个 agent-deck tool` 一并覆盖
6. **`AGENT_DECK_TOOL_NAMES` enum 字符串值**：新加 5 个 task tool 进 enum 时注意字符串值是裸 `'task_create'` 等（不带 `mcp__agent-deck__` 前缀，MCP 协议 server name + tool name 由 SDK 自动拼）；与现有 `spawnSession: 'spawn_session'` 等同款 pattern
7. **`buildAgentDeckTools` 加 5 个 tool 后 HTTP transport 性能**：现有 `transport-http.ts` 走 per-request fresh transport + fresh McpServer 注册 N 个 tool；从 10 个加到 15 个 register 开销 ~50% increase 但仍是毫秒级 in-memory 操作（V8 module cache 命中），production load 可接受。无需优化
8. **`task-changed` eventBus payload schema**：v023 后 `ownerSessionId` 字段已替代 `teamId / teamName`，handler 内 emit 时 `task: created` 直接含 `created.ownerSessionId`，不需要额外字段映射；与现有 task-manager/tools.ts emit 行为完全等价
9. **docs/agent-deck-team-protocol.md ADR archived 边界**（R1-mixed-codex MED-A 反驳记录）：plan §Step 17 「live 资产必改」清单含 `docs/agent-deck-team-protocol.md`，但实际现场 verify doc 头部明示「**状态**：ACCEPTED（2026-05-11）R3 阶段架构决策记录」属 **ADR archived 历史归档**（与 changelog/ reviews/ plans/ 同档），内含 `mcp__tasks__task_create` 字面量是当时 (R3 时代) 工具命名描述合规 historical reference 不应改。Step 17 修订：docs 内 ADR archived 类不动；docs 内 live API/protocol doc（如 `docs/agent-deck-mcp-protocol.md` stub 链接）才改
10. **cascade pre-walk 2N SQL SELECT 性能 follow-up**（R2-claude INFO F-R2-3）：task-delete.ts handler pre-walk + repo BFS 走两遍 BFS（handler 收集 ownerMap N 次 `taskRepo.get(childId)` + repo BFS 又 N 次 `get(next)`），总 SQL SELECT 调用 = 2N + 1。几百到几千 task 规模可接受（同 task-repo.ts:334 注释「tasks 表通常规模不大」）。**Trivial 优化**：让 `taskRepo.delete()` 返回 `{ deletedIds, ownerMap }` 而非仅 `deletedIds`，handler 直接消费 ownerMap 不重复 walk → SQL SELECT 调用降到 N + 1。属 contract refactor 风险大于收益，留 follow-up

## 测试覆盖矩阵（Step 18-23 落实）

| 测试文件 | 覆盖场景 |
|---|---|
| `src/main/agent-deck-mcp/__tests__/task-crud.test.ts` 新建（port from tools.crud.test.ts） | 5 个 task tool 形状校验 + task_create owner_session_id 闭包注入 + task_update / task_delete same-team check + ingest task-changed 事件断言 |
| `src/main/agent-deck-mcp/__tests__/task-events.test.ts` 新建（port from tools.read-ingest.test.ts） | task_list visible scope reverse join + task_get 跨 team 读 + ingest team-task-* AgentEvent（in-process 路径）+ **D7 新增：HTTP transport 路径 ingest skip** |
| `src/main/agent-deck-mcp/__tests__/task-external-caller.test.ts` 新建（D6） | HTTP transport `fallbackToGlobal=true` → task_create / task_update / task_delete reject；task_list / task_get 通过 |
| `src/main/agent-deck-mcp/__tests__/spoofing-attack-paths.test.ts` 改（D5 防注入） | caller 传伪造 `caller_session_id` → in-process closure override 覆盖（覆盖 5 个 task tool 场景，与现有 10 个 tool 同款 pattern） |
| `src/main/store/__tests__/settings-store.test.ts` 改（如存在）/ 新建 | **smart migration 4 格断言**（R1 F11/F13 修法 + R2-claude-MED-2 fresh install 补齐 — reviewer-codex R1 补充 + reviewer-claude R2 MED-2）：(1) raw `enableTaskManager: true` + raw 不含 `enableAgentDeckMcp` → migration 后 `enableAgentDeckMcp: true` + legacy key deleted + warn 日志；(2) raw `enableTaskManager: false` + raw 不含 `enableAgentDeckMcp` → migration 后 `enableAgentDeckMcp: false`（**取 false 把用户原意 carry 过来**，不取 default OFF —— 二者实际值一致但语义清晰）+ legacy key deleted；(3) raw 含 explicit `enableAgentDeckMcp` value → migration 不覆盖（用户决策优先）+ legacy key deleted；(4) **raw 全空（fresh install）→ enableAgentDeckMcp 走 default false + migration hook no-op + 不打 warn 日志**（load-bearing：新用户路径不该看 migration warn 噪音） |
| `src/renderer/components/settings/sections/__tests__/` 改 ExperimentalSection 测试（如存在） | 不再渲染 enableTaskManager 开关 UI |
| 集成验证（手动 / e2e — R1 F8 修法 — reviewer-claude LOW-3 细化）| Step 24 后跑应用启动：(1) 启 codex teammate → 在 codex CLI 内 `/mcp` 查 ListTools 含 `mcp__agent-deck__task_*` 5 个；(2) 让 codex teammate 主动调 `task_create({subject:'spike test'})` end-to-end，verify task 落 DB / renderer TasksSection 显示 / codex SessionDetail 不写 team-task-* event（D7 ingest skip 真起效）；(3) claude lead 调 `task_list` 走 in-process closure path，verify visible scope 含 caller 同 team active member tasks |
| **不变量 5 (eventBus + IPC TaskChanged 路径不动)**（R2-claude-LOW-2 修订 — reviewer-claude R2 LOW-2）| task_create / task_update 后 mock eventBus listener assert `task-changed` event emit 1 次（payload 含 created/updated task + ownerSessionId）；行为与 `mcp__tasks__` 时代 1:1 等价 |
| **不变量 1+7 (单 mcp server + 15 tool)**（R2-claude-INFO-1 修订 — reviewer-claude R2 INFO-1）| Step 24 typecheck 隐式 cover（`AgentDeckToolName` enum 与 `EXTERNAL_CALLER_ALLOWED` Record 编译时校验全部 15 entries）+ Step 25 manual `pnpm dev` 启动 smoke test ListTools 含 15 个 entries。**可选** unit test `Object.keys(buildAgentDeckTools(stubDeps)).length === 15` 加在 `src/main/agent-deck-mcp/__tests__/build-tools.test.ts`（新文件 ~5 行） |

## 参考与 dependencies

- 现状摸底（本会话 Bash grep + cat）：
  - `src/main/task-manager/{tools,server}.ts`（owner_session_id 版 v023，sessionIdProvider 必填，5 个 handler 完整）
  - `src/main/store/task-repo.ts`（v023 schema，reassignOwner API，task-changed event payload schema）
  - `src/main/agent-deck-mcp/{server,tools/{index,schemas,helpers},transport-http,types}.ts`（现有 10 个 tool / 3 transport / makeCtx / EXTERNAL_CALLER_ALLOWED 黑名单 / resolveCallerSidForReadOnly 完整 architecture）
  - `src/main/adapters/claude-code/sdk-bridge/{mcp-server-init,query-options-builder}.ts`（双 server 拼装 / allowedTools 双 pattern）
  - `src/shared/types/settings.ts` + `src/main/store/settings-store.ts`（enableTaskManager 字段 + REMOVED_KEYS 机制）
  - `src/shared/constants/read-only-tools.ts`（isTaskMcpTool 前缀）
  - `resources/claude-config/CLAUDE.md` + `resources/codex-config/CODEX_AGENTS.md`（§task 进度跟踪节 owner_session_id 语言）
  - `src/main/adapters/codex-cli/sdk-bridge/index.ts:241-269`（codex SDK 子进程 `ensureCodex` 只通过 `buildAgentDeckMcpConfigForCodex` 注入 mcp_servers.agent-deck，完全没注入 mcp_servers.tasks — 本 plan 修复根因）
  - `src/main/codex-config/agent-deck-mcp-injector.ts`（agent-deck mcp HTTP transport 注入器，本 plan 合并后 task tools 自动通过这里暴露给 codex）
- RFC 3 轮历史：本会话上方对话 conversation history（覆写 design 决策 D1-D8）
- 相关 plan：[`task-mcp-owner-session-id-rewrite-20260521`](../../../plans/task-mcp-owner-session-id-rewrite-20260521.md)（v023 owner_session_id 重设计 base / 已 archive commit `698f345`，本 plan 基于此 base 做物理位置重构）
- 相关 changelog：CHANGELOG 引用待写（Step 26 收口前补）
