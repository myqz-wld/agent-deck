# CHANGELOG_247: foundation 模板对齐（目录架构 / 记录编号 / review 过期 / 500 行护栏）

## 概要

按 project-engineering-foundation 模板补齐 `CLAUDE.md` 缺失的共享规则节并落地配套维护脚本；所有 agent-deck 专属 design invariant（鉴权边界 / MCP 边界 / 内置资产自闭环 / IPC 边界 / 打包规则）原样保留，不改变运行时行为。

## 变更内容

### `CLAUDE.md`

- 新增「基础目录架构」节：标准落位 + agent-deck 专属 `resources/`、`ref/flows/`、`ref/architecture/` 条目。
- 「改动后必做」从 3 条扩为 5 条：补 changelog/review 编号规则（`X` 取最大值 +1，`ls` 确认；INDEX 摘要 ≤ 80 字）和 `.refs/` 未终态 plan/review 生命周期（终态收口归档 `ref/` + 清理工作副本）。
- 「升级约定」节补 `ref/conventions/tally.md` 计数机制：语义相同条目 +1，`count >= 3` 走 review 升级为 `ref/conventions/<X>-<topic>.md`。
- 新增「Review 过期与最小复审范围」节：unreviewed ∪ expired ∪ scope_unknown + 4 条过期判定。
- 新增「文件大小护栏（500 行）」节：拆分优先级 + "do not split" 保护清单出口。
- 头部描述改为共享 SSOT 措辞，覆盖全部规则节。

### `.gitignore`

- 补 `.refs/` ignore（未终态 plan/review 工作副本区，此前缺失）。

### `scripts/` / `README.md`

- 新增 `scripts/file-level-review-expiry.sh`（来自 foundation skill），review 过期检查脱离 skill 独立可跑；README「项目结构」scripts 树同步补条目。

## 备注

- 本轮验证：`pnpm typecheck` 通过；`git check-ignore .refs/x` 确认 `.refs/` 被忽略；`git diff --check` 无问题。
