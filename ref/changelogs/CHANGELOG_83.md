# CHANGELOG_83

## 拆 session-repo.ts 590 → session-repo/ 7 文件（plan deep-review-and-split-20260513 Phase 2 Step 2.3）

## 概要

`src/main/store/session-repo.ts` 是 store 层第三大文件（590 行 / 27 method）。本次按 plan
§步骤 checklist Phase 2 Step 2.3 拆为 `session-repo/` 目录 7 文件，每个 ≤ 200 行。typecheck
双端通过。

外部 caller import 路径不变（`from '@main/store/session-repo'` 自动 resolve 到
`session-repo/index.ts`）。`sessionRepo` 对象 27 method surface 100% 一致（spread 自所有
sub-module + reserved word `delete` 单独命名映射）。

## 变更内容

### 拆分（src/main/store/session-repo.ts → src/main/store/session-repo/）

按「关注点 + 风险维度」分组，与 plan §步骤 checklist Phase 2 Step 2.3 设计一致：

- `session-repo/index.ts` (38 行) — facade `sessionRepo` 对象，spread 所有 sub-module
  module-level export function 拼装。`_delete` → `delete` reserved-word 重命名映射。
- `session-repo/types.ts` (92 行) — `Row` interface + `rowToRecord` + `parseGenericPtyConfigJson`
  共享 helper（无 sibling 依赖，所有 sub-module 共享 import）。
- `session-repo/core-crud.ts` (198 行) — 11 个 method：`upsert` / `get` /
  `listActiveAndDormant` / `listHistory` / `_delete`（→ `delete`）+ 5 个 setter
  (`setPermissionMode` / `setTitle` / `setCodexSandbox` / `setClaudeCodeSandbox` /
  `setGenericPtyConfig`)。
- `session-repo/archive.ts` (21 行) — 单 `setArchived` method，独立文件呼应
  CLAUDE.md「lifecycle (active/dormant/closed) 与 archived_at 正交」核心约定，
  与 lifecycle.ts 物理隔离。
- `session-repo/lifecycle.ts` (131 行) — 7 个 method：`setLifecycle` / `setActivity` /
  `findActiveExpiring` / `findDormantExpiring` / `batchSetLifecycle` /
  `findHistoryOlderThan` / `batchDelete`。lifecycle scheduler 主要消费此文件。
- `session-repo/rename.ts` (122 行) — `rename` 单 method，跨表事务复杂迁移
  （sessions + events + file_changes + summaries 4 表 session_id 改名 + toExists 分支 5
  identity 字段覆盖防丢档）。注释保留完整（含 REVIEW_17 R2 / H1-R2 历史 + R4·F2
  generic_pty_config 加列等）。
- `session-repo/spawn-chain.ts` (91 行) — 4 个 MCP spawn 链路 method：
  `getSpawnDepth` / `setSpawnLink` / `listAncestors` / `listChildren`。

### 不修改业务行为

本拆分**仅文件物理拆分**，不修任何 SQL / 业务逻辑 / API surface：
- 27 method 签名 100% 一致（含 `delete` reserved-word workaround：sub-module 内导出
  `_delete`，facade 在 spread 时重命名映射回 `delete`）
- 所有 SQL 字符串原样迁移
- `sessionRepo` 默认对象的 method 名 / 参数顺序 100% 一致
- 共享 helper（`Row` / `rowToRecord` / `parseGenericPtyConfigJson`）从 types.ts re-export，
  各 sub-module 独立 import 不增加 module-level 副作用

## 测试

- `pnpm typecheck` 双端（node + web）通过
- 不跑 vitest（按 CLAUDE.md「跑 vitest SQLite 真测前后必须保护 better-sqlite3 binding」教训）

## 关联

- plan `~/.claude/plans/piped-fluttering-moth.md` Phase 2 Step 2.3
- CHANGELOG_82 (Step 2.2 拆 team-repo) — 同 plan 同 Phase 上一步
- CHANGELOG_81 (Step 2.1 拆 tools.ts + 修 2 条 MED) — 同 plan 同 Phase 第一步

## Phase 2 收口（Tier 1 三大文件全拆完）

至此 plan §步骤 checklist Phase 2 Tier 1 三大文件（tools.ts / agent-deck-team-repo.ts /
session-repo.ts）全部拆分完成，文件 LOC 全部降到 ≤ 220 行。

| Tier 1 文件 | 原 LOC | 拆后 max sub-file LOC | commit |
|---|---|---|---|
| `tools.ts` | 1060 | 281 (handlers/spawn.ts) | `328354f` |
| `agent-deck-team-repo.ts` | 658 | 211 (team-crud.ts) | `cdcb1c7` |
| `session-repo.ts` | 590 | 198 (core-crud.ts) | 本次 |

H3 起进入 Phase 3（Tier 2：pty-bridge.ts 506 / sdk-bridge/index.ts 816）；H4 进入 Phase 4
（Tier 3：manager.ts 650+H1 增量 ≈ 730+ 行，最高风险，必须走 deep-code-review SKILL 异构对抗 +
单独 sub-plan）。
