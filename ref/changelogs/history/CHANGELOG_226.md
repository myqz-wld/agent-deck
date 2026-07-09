# CHANGELOG_226 — 新项目工程地基补 Codex 入口模板（CLAUDE.md + AGENTS.md 成对落地）

## 概要

新项目工程地基此前只 scaffold Claude 入口（`CLAUDE.md` + `project-claude.template.md`），Codex 视角没有项目入口文件，靠 agent 临时自拼。

补齐 Codex 对偶模板，并把「CLAUDE.md / AGENTS.md 成对落地」写进 Claude / Codex 两端新项目工程地基：项目约定写全在 `CLAUDE.md`（Claude / Codex 共用 SSOT），`AGENTS.md` 只放 Codex 入口差异（必读顺序 + Codex 工具差异）并指回 `CLAUDE.md`，避免两份项目约定双写漂移——与本仓库自身 `CLAUDE.md` ↔ `AGENTS.md` 的关系一致。

## 变更内容

### resources/templates/

- 新增 `project-agents.template.md`：Codex 项目入口薄指针模板。含必读顺序（先读 CLAUDE.md → 应用内 Codex SDK/MCP/skill 再读 `CODEX_AGENTS.md` → 对照 Claude 对偶资产）、Codex 操作要点（`rg`/`apply_patch`、worktree 走 MCP、turn-based、prompt 资产成对审计）、「项目特定 Codex 差异（如有）」占位。
- `project-claude.template.md`：顶部 note 标注它是 Claude / Codex 共享仓库规则 SSOT，且 Codex 对偶入口是 `AGENTS.md`（薄指针 → 本文件）。
- `project-claude.template.md` / `project-agents.template.md` / conventions 模板：去掉跨项目会失效的仓库内 `resources/...` 路径，改为「应用环境自动注入」表述，避免新仓库复制模板后出现悬空路径。

### resources/claude-config/CLAUDE.md（§新项目工程地基）

- 目录骨架在 `CLAUDE.md` 旁新增 `AGENTS.md` 行，并标注两者职责（CLAUDE.md = 共享规则 SSOT，AGENTS.md = Codex 入口薄指针）。
- 模板清单加入 `project-agents.template.md`，并新增「CLAUDE.md / AGENTS.md 成对落地」约定行。

### resources/codex-config/CODEX_AGENTS.md（§新项目工程地基）

- 补齐 Codex 端独立可读的新项目工程地基：目录骨架、模板清单、`CLAUDE.md / AGENTS.md` 成对落地、src/build、.gitignore、README、changelog/review、review 过期、单文件大小护栏、反馈升级流程。
- Codex 端使用 `{{AGENT_DECK_RESOURCES}}/templates/` 与 SOPs 占位符，保持应用注入后可直接 `shell: cat` / `bash` 使用。

### resources/README.md

- 打包路径表补 `resources/SOPs` 与 `resources/templates`，对齐 `package.json build.extraResources`，让新增模板目录有维护入口说明。

## 备注

- `project-agents.template.md` 走 `resources/templates/` 共享模板目录（非 adapter 拆分），与 claude / codex 两端 baseline 引用模板的方式一致。
- 提示词资产维护 5 条硬约束修改前自检已跑；后续修订同步跑同款 grep 自检。
