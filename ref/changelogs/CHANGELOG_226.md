# CHANGELOG_226 — 新项目工程地基补 Codex 入口模板（CLAUDE.md + AGENTS.md 成对落地）

## 概要

新项目工程地基此前只 scaffold Claude 入口（`CLAUDE.md` + `project-claude.template.md`），Codex 视角没有项目入口文件，靠 agent 临时自拼。

补齐 Codex 对偶模板，并把「CLAUDE.md / AGENTS.md 成对落地」写进新项目工程地基：项目约定写全在 `CLAUDE.md`（Claude / Codex 共用 SSOT），`AGENTS.md` 只放 Codex 入口差异（必读顺序 + Codex 工具差异）并指回 `CLAUDE.md`，避免两份项目约定双写漂移——与本仓库自身 `CLAUDE.md` ↔ `AGENTS.md` 的关系一致。

## 变更内容

### resources/templates/

- 新增 `project-agents.template.md`：Codex 项目入口薄指针模板。含必读顺序（先读 CLAUDE.md → 应用内 Codex SDK/MCP/skill 再读 `CODEX_AGENTS.md` → 对照 Claude 对偶资产）、Codex 操作要点（`rg`/`apply_patch`、worktree 走 MCP、turn-based、prompt 资产成对审计）、「项目特定 Codex 差异（如有）」占位。
- `project-claude.template.md`：顶部 note 标注它是 Claude / Codex 共享仓库规则 SSOT，且 Codex 对偶入口是 `AGENTS.md`（薄指针 → 本文件）。

### resources/claude-config/CLAUDE.md（§新项目工程地基）

- 目录骨架在 `CLAUDE.md` 旁新增 `AGENTS.md` 行，并标注两者职责（CLAUDE.md = 共享规则 SSOT，AGENTS.md = Codex 入口薄指针）。
- 模板清单加入 `project-agents.template.md`，并新增「CLAUDE.md / AGENTS.md 成对落地」约定行。

## 备注

- `project-agents.template.md` 走 `resources/templates/` 共享模板目录（非 adapter 拆分），与 claude / codex 两端 baseline 引用模板的方式一致。
- 提示词资产维护 5 条硬约束修改前自检（约束 2 兼容/未来、约束 3 模糊副词、约束 5 示例数）已跑，全过。
