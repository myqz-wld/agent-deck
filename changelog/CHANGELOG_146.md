# CHANGELOG_146 — task mcp 合并入 agent-deck-mcp namespace + 删 enableTaskManager toggle

## 概要

把原独立 `src/main/task-manager/` 的 5 个 in-process MCP tool（`task_create` / `task_list` / `task_get` / `task_update` / `task_delete`）物理合并入 `src/main/agent-deck-mcp/tools/handlers/` namespace。**Breaking change**：工具名从 `mcp__tasks__task_*` 切到 `mcp__agent-deck__task_*`，让 codex SDK 子进程通过现有 `mcp_servers.agent-deck` HTTP transport **自动**拿到 5 个 task tool（修前 codex 端 `ensureCodex` 仅注入 `mcp_servers.agent-deck` 未注入 `mcp_servers.tasks` 是 bug — 文档 vs 实现 contract mismatch，详 [`plans/task-mcp-merge-into-agent-deck-mcp-20260521.md`](../plans/task-mcp-merge-into-agent-deck-mcp-20260521.md) §总目标）。

同时删 `enableTaskManager` 独立 settings toggle，task tools 跟随 `enableAgentDeckMcp` 总开关；settings-store.ts 加 **smart migration 4-case 钩子**自动 carry 老用户 `enableTaskManager: true` 值到 `enableAgentDeckMcp`，新用户路径 no-op 不打 warn 噪音。

经 §Step 0 RFC 3 轮收口 + §Step 1.5 plan deep-review 3 轮 33 finding fix（双 reviewer 0 HIGH GO）+ §Step 25 mixed code+plan implementation deep-review 3 轮 12 finding fix（双 reviewer 0 HIGH/MED GO）。归档 plan [`plans/task-mcp-merge-into-agent-deck-mcp-20260521.md`](../plans/task-mcp-merge-into-agent-deck-mcp-20260521.md)。

## 变更内容

### Stage 1 — agent-deck-mcp 5 task handler + schemas + 删 task-manager/

- **新建** `src/main/agent-deck-mcp/tools/handlers/task-helpers.ts` — 抽 4 runtime helper（依赖 store/team repo）：`argsToInputWithoutOwner` / `getVisibleOwnerSessionIds`（含 F2 archived team filter）/ `isCallerAuthorizedToWrite`（findSharedActiveTeams + caller==owner 特例）/ `getCallerFirstTeamName`
- **新建** 5 个 task handler：`task-create.ts` / `task-list.ts` / `task-get.ts` / `task-update.ts` / `task-delete.ts`（D5 走 `makeCtx(args, extra)` + `HandlerContext.caller.callerSessionId` 闭包注入 owner_session_id 与现有 10 agent-deck-mcp tool 完全对称；D7 ingest 行为分流：`ctx.caller.transport === 'in-process'` 才 ingest `team-task-*` AgentEvent，HTTP / stdio skip 避免 codex SessionDetail 未实证渲染风险）
- **改** `src/main/agent-deck-mcp/tools/schemas.ts` 顶部加 `STATUS_VALUES` export（R2 F-R2-4 修订：schema 层 enum 天然位置，避免 schema 层间接拉 sessionRepo / agentDeckTeamRepo 运行时依赖）+ 5 个 `TASK_*_SCHEMA`（plain SHAPE 注册 pattern，不走 archive_plan / hand_off_session `ARGS_SCHEMA.safeParse-wrapper` — task tools 无 `.strict()` / `.refine()` invariant）+ 5 `TaskXxxResult` interface
- **改** `src/main/agent-deck-mcp/types.ts` — `AGENT_DECK_TOOL_NAMES` 加 5 个 task tool name；`EXTERNAL_CALLER_ALLOWED` Record 严格 5 entries（D6：task_create / task_update / task_delete 显式 false / task_list / task_get 显式 true — R1 F1 修法防「不加 = allow」歧义）
- **改** `src/main/agent-deck-mcp/tools/index.ts` `buildAgentDeckTools` 末尾注册 5 个新 tool（plain SHAPE + R1 F3 annotations 4-tuple — task_create/update 全 false / task_delete `destructiveHint:true + idempotentHint:false`，R2 F-R2-1 修订与现状 contract not-found 返 isError 对齐）
- **删** `src/main/task-manager/` 整个子目录（`server.ts` + `tools.ts` + `__tests__/`）— grep 验证 `@main/task-manager` import 全仓 0 hit

### Stage 2 — 删独立 tasksServer 注入 + settings 删字段 + UI + 文档

- **改** `src/main/adapters/claude-code/sdk-bridge/mcp-server-init.ts` 简化为单 `agentDeckMcpServer`（删 `tasksServer` 拼装段），返回类型从 `{tasksServer, agentDeckMcpServer}` 简化为 `{agentDeckMcpServer}`
- **改** `src/main/adapters/claude-code/sdk-bridge/query-options-builder.ts` — 删 `tasksServer` 字段 + 删 `'mcp__tasks__*'` allowedTools pattern，只剩 `agentDeckMcpServer` + `AGENT_DECK_MCP_TOOL_PATTERN` 单一 pattern
- **改** `src/shared/types/settings.ts` 删 `enableTaskManager` 字段 + 默认值 + jsdoc；`src/main/store/settings-store.ts` 加 **smart migration 4 case 钩子**（line 74 REMOVED_KEYS delete 之前）：
  - (1) raw `enableTaskManager:true` + raw 不含 `enableAgentDeckMcp` → `set('enableAgentDeckMcp', true)` + warn + legacy delete
  - (2) raw `enableTaskManager:false` + raw 不含 `enableAgentDeckMcp` → 不动（保留默认 OFF）+ legacy delete
  - (3) raw 含 explicit `enableAgentDeckMcp` value → migration skip（用户决策优先）+ legacy delete
  - (4) fresh install (raw 全空) → no-op + 不打 warn 噪音（load-bearing：新用户路径不该看 migration warn）
- **改** `src/renderer/components/settings/sections/ExperimentalSection.tsx` — 删整个 `enableTaskManager` Toggle + description div 完整 block（R3-claude-LOW-2 修订 — 不只删 Toggle 留 dangling description div literal）
- **改** `src/renderer/components/settings/sections/AgentDeckMcpSection.tsx` — 「10 个 tool」→「15 个 tool」+ jsdoc 列名加 5 个 `task_*`
- **改** `src/shared/constants/read-only-tools.ts` `isTaskMcpTool` 前缀切 `mcp__tasks__` → `mcp__agent-deck__task_` + 加 dead helper jsdoc 决策溯源（R1 F5 + R2-claude-LOW-1：R1 reviewer-codex 用 `grep -rln isTaskMcpTool src/` 反证 dead，避免未来 reviewer 翻出来再 propose 同款 hardcode 5-tuple 方案）
- **改** `src/renderer/components/activity-feed/tool-icons.ts` — 5 个 emoji map key + jsdoc 同步切前缀
- **改** `resources/claude-config/CLAUDE.md` + `resources/codex-config/CODEX_AGENTS.md` — §task 进度跟踪节工具名切名 + 删 `enableTaskManager: false` 例外注释 + §Agent Deck Universal Team Backend 节首句「10 tool」→「15 tool」+ Breaking 历史段
- **改** `README.md` — 删独立 SDK Task Manager toggle 段；Agent Deck MCP server 描述「10 个 tool」→「15 个 tool」+ 5 task tool 列名；stdio transport 描述精确化「仅暴露 4 个只读 tool 给 external caller / 其余 11 个 write tool 一律 deny external」(R2-claude-LOW F-R2-1)

### Stage 3 — 测试覆盖

- **新建** `src/main/agent-deck-mcp/__tests__/task-crud.test.ts`（17 tests）— 5 tool 形状校验 + owner_session_id 闭包注入 + same-team check + cascade predicate + emit task-changed 事件断言 + **F-D 回归 case**（R1-mixed-codex-LOW-D 修法：cascade emit ownerSessionId 用 child 自己 owner 不用 root，TaskChangedEvent contract:53 一致性）
- **新建** `src/main/agent-deck-mcp/__tests__/task-events.test.ts`（6 tests）— D7 ingest 分流：in-process 路径 ingest team-task-* AgentEvent（含 caller first team name lookup）/ HTTP transport skip ingest
- **新建** `src/main/agent-deck-mcp/__tests__/task-external-caller.test.ts`（13 tests）— D6 EXTERNAL_CALLER_ALLOWED 决策矩阵：HTTP + stdio external transport 3 写 deny + 2 读 allow + stdio invariant 兜底（transport 漏改假设场景）
- **改** `src/main/agent-deck-mcp/__tests__/spoofing-attack-paths.test.ts` — 5 攻击向量 + 5 task tool DENY loop + read-only ALLOW 例外（task_list / task_get）
- **新建** `src/main/store/__tests__/settings-store.test.ts`（4 tests）— smart migration 4 case 断言（legacy true 守护 / legacy false / explicit override / fresh install no-op）

### Stage 4 — typecheck + build + vitest

- `pnpm typecheck` ✅
- `pnpm exec vitest run` ✅ 861 / 862 pass（**+39 tests** vs base：task-crud 17 + task-events 6 + task-external-caller 13 + settings-store 4 + spoofing 加 5 task tool DENY 测试；1 pre-existing fail `manager-ingest.test.ts:298 REVIEW_49 R3 follow-up` 与本 plan 无关，已 verify base_commit `698f345` 上同款 fail）

### Stage 5 — Mixed code + plan deep-review 3 轮（双 reviewer 0 HIGH/MED GO）

R1+R2+R3 累计 12 finding 全 fix（9 ✅ + 1 ❌ docs/agent-deck-team-protocol.md ADR archived 反驳 + 2 follow-up plan §已知踩坑）：

| Round | Finding | 严重度 | 修法 |
|---|---|---|---|
| R1 codex MED | README.md 仍提 SDK Task Manager toggle + 10 个 tool + mcp__tasks__* | MED | README §SDK Task Manager toggle 段删 + 10→15 + 5 task tool 列名 + stdio 描述更精确化 |
| R1 codex LOW | read-only-tools.ts grep `0 hit` 验证命令字符串自循环命中 | LOW | 验证命令彻底重写为「合规 historical 4 处白名单 + 任何额外命中 = live 漏改」 |
| R1 codex LOW→MED | task-delete cascade emit 用 root ownerSessionId 而非 child 各自 owner（违反 TaskChangedEvent contract:53）| MED | task-delete pre-walk ownerMap (taskRepo.get walk root.blocks 闭包) + emit `ownerMap.get(id) ?? target.ownerSessionId` 兜底；task-crud.test.ts 加 F-D 回归 case |
| R1 claude HIGH F-NEW-1 | tools/index.ts:2 + transport-http.ts:24/122 三处「5/10 tool」jsdoc 未更新到 15 | HIGH | 三处 jsdoc 同步 15 tool 与 server.ts SSOT 对齐 |
| R1 claude LOW F-NEW-3 | task-delete.ts:40 jsdoc R3-codex-LOW-1 reference 串台 | LOW | 改成 R3-codex-LOW-3（实际 finding） |
| R1 claude LOW F-NEW-4 | translate.test.ts:426/437 fixture `agent_deck` underscore vs 生产 `agent-deck` hyphen | LOW | underscore → hyphen 与 server.ts:50 生产 SSOT 对齐 |
| R2 codex LOW | read-only-tools.ts `^mcp__tasks__` anchor 漏 quoted literal | LOW | 改用「合规 historical 白名单 + 任何额外命中 = live 漏改」白名单分类语义 |
| R2 claude LOW F-R2-1 | README.md:227 stdio 描述语法混乱（write tool 列「仅允许只读」括号内）| LOW | 精确化「4 只读 / 11 write」分列 |
| R2 claude LOW F-R2-2 | task-delete.ts:50-56 cascade pre-walk fallback 注释「极端 corner case」措辞模糊 | LOW | 改写「不变量保证 ownerMap ⊇ deletedIds 严格成立 → fallback 永远不会触发，保留是 defensive coding 防 future repo BFS 改动」 |
| R2 claude INFO F-R2-3 | cascade pre-walk 2N SQL SELECT 性能（contract refactor `taskRepo.delete() → {deletedIds, ownerMap}`）| INFO | 接受 follow-up 记 plan §已知踩坑 #10 |
| R3 codex LOW | plan §Step 17 + §已知踩坑 #5 仍列 docs/agent-deck-team-protocol.md 为 live 资产与 #9 ADR archived 边界矛盾 | LOW | plan 两处 supersede by #9 + 4 文件减 3 文件硬列 |
| R3 claude LOW F-R3-1 | task-delete.ts:78-79 R1 旧注释「极端 corner case」与 L51-56 R2 新注释「永远不会触发」矛盾 | LOW | 删 L78-79 R1 旧注释（claude 推荐方案 b — L51-56 已 self-documenting） |

**反驳**（不修）：R1 codex MED docs 部分 — 现场 verify `docs/agent-deck-team-protocol.md` 头部明示「**状态**：ACCEPTED（2026-05-11）R3 阶段架构决策记录」属 **ADR archived 历史归档**（与 changelog/ reviews/ plans/ 同档），内含 `mcp__tasks__` 字面量是当时 (R3 时代) 工具命名描述合规 historical reference 不应改。Plan §已知踩坑 #9 记录该 ADR archived 边界澄清。

## 验证

- `pnpm typecheck` ✅
- `pnpm exec vitest run` ✅ 861/862（+39 tests，1 pre-existing fail 与本 plan 无关）
- 集成 e2e 验证留 stage 6 archive_plan 后跑（详 plan §测试覆盖矩阵 集成验证行）：(1) 启 codex teammate `/mcp` 查 ListTools 含 `mcp__agent-deck__task_*` 5 个 / (2) codex teammate 调 `task_create` end-to-end + verify task 落 DB + renderer TasksSection 显示 + codex SessionDetail 不写 team-task-* event (D7 ingest skip 真起效) / (3) claude lead 调 `task_list` 走 in-process closure path 验证 visible scope 含 caller 同 team active member tasks

## Breaking Change 影响面

- **工具名换**：`mcp__tasks__task_*` → `mcp__agent-deck__task_*`（5 task tool）— live SDK session 旧名调撞「Unknown tool」是合理 breaking 信号
- **Settings 字段删**：`enableTaskManager` → `enableAgentDeckMcp`（smart migration 自动 carry 老用户 ON 值，无感知）
- **老 jsdoc / 历史归档 `mcp__tasks__` 字面量**：CHANGELOG_42-145 / reviews / plans/ 历史归档不动；live UI / 测试 fixture / event translation 已全切
