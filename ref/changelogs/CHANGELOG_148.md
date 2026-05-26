# CHANGELOG_148 — archive_plan + task_delete ok return 字段统一 camelCase

## 概要

agent-deck-mcp 15 个 tool 中,`archive_plan` 与 `task_delete` 两个 tool 的 ok return 字段是历史遗留 snake_case(其他 13 tool 均 camelCase),破坏「ok return 字段一律 camelCase」一致性。本次统一全部 camelCase + 删向后兼容注释,**MCP tool 协议 breaking change**(args 字段一律 snake_case 约定不动)。

## 变更内容

### `ArchivePlanResult` 接口字段全 camelCase

- `archived_path` → `archivedPath`
- `commit_hash` → `commitHash`
- `branch_deleted` → `branchDeleted`
- `worktree_removed` → `worktreeRemoved`
- `plans_index_action` → `plansIndexAction`
- `final_status` → `finalStatus`
- `spike_reports_archived` → `spikeReportsArchived` + 嵌套 `src_path/dst_path` → `srcPath/dstPath`
- `warnings` / `archived` / `teammatesShutdown` 已 camelCase 不动

### `TaskDeleteResult` 接口字段全 camelCase

- `task_id` → `taskId`
- `deleted_ids` → `deletedIds`
- `success` 已 camelCase 不动

### 改动文件(6)

- **改** `src/main/agent-deck-mcp/tools/schemas.ts` —— 两 result interface 字段重命名 + 删 archive_plan 顶部「snake_case 保持向后兼容」注释 + jsdoc 字段名同步
- **改** `src/main/agent-deck-mcp/tools/handlers/archive-plan.ts` —— ok return 直接透传 impl 的 camelCase(impl 内部本就 camelCase),删 9 行 snake_case 转换层
- **改** `src/main/agent-deck-mcp/tools/handlers/task-delete.ts` —— ok return 字段名换
- **改** `src/main/agent-deck-mcp/tools/index.ts` —— archive_plan tool description 注入 SDK system prompt 的字段名同步
- **改** `resources/claude-config/CLAUDE.md` —— §archive_plan 节返回值字段 + spike-reports 段 + UX 完善列表三处同步
- **改** `resources/codex-config/CODEX_AGENTS.md` —— 同款双端 mirror 三处(避免 codex SDK 会话被旧约定误导)

### 不改动的部分

- **args 字段**(`task_id` / `worktree_path` / `caller_session_id` 等)一律 snake_case,schemas.ts:13 顶部明确约定 —— 全部保留
- **历史归档** `plans/` `changelog/` `reviews/` `README.md` —— 是当时事实记录不回溯改
- `archive-plan-impl.ts` 内部 —— 本来就 camelCase

## 验证

- `pnpm typecheck` ✅ 通过(0 errors)
- `grep` 全 src/ + resources/ 0 个 snake_case 残留字段
- 3 transport(in-process / HTTP / stdio)共享同一份 schema,一并切换无遗漏
