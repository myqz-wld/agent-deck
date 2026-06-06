# CHANGELOG_228: 拆出弱相关提示词并保持 Agent Deck 内置资产自闭环

## 概要

清理 Agent Deck 应用环境提示词中的通用工程地基内容，避免把弱相关方法论继续打包进
Agent Deck baseline。内置资源保持自闭环，不通过 `$skill` 指针依赖外部 skill；用户可在
本地安装自己的 skill 来增强新建项目、review 记录、文件护栏等行为。

## 变更内容

### resources/claude-config / resources/codex-config

- 移除 `新项目工程地基` 长章节，保留 Agent Deck 协议、plan/worktree/handoff、plantUML、
  prompt 资产维护等与应用环境强相关内容。
- 将 Claude 侧 `复杂 plan` 长章节压缩为 Agent Deck baseline 最小协议，只保留 plan 文件、
  worktree、cold-start、handoff、archive/abandon cleanup 的自闭环规则。
- 修正压缩后残留的旧 `§Step N` / `复杂 plan workflow` 章节引用，改指当前 `Worktree`、
  `Handoff`、`完成 / 中止` 与 `Review Gate` 标题。
- 将 plantUML / flow-architecture diagram 工作流移出 Agent Deck bundle；baseline 不再声明
  内置 `agent-deck:flow-arch-plantuml` 能力，也不规定图产物布局。
- plan 收口里的 changelog 描述改为“关联已有变更记录编号”；变更记录文件如何组织交给
  当前项目 skill。
- 恢复 `提示词资产维护` 为内置自闭环规则，继续服务 Agent Deck 自身 prompt 资产维护。
- 去掉对已拆出 standalone skills 的指针，避免内置资产依赖用户侧 skill 安装状态。

### resources/templates / resources/SOPs

- 从 Agent Deck 打包资源删除 `resources/templates/` 与 `resources/SOPs/`；project entry、
  changelog、review、convention 模板、file-size guardrail 和 review expiry helper 改由
  本地 `project-engineering-foundation` skill 管理。
- 从 Agent Deck plugin bundle 删除 Claude / Codex 两份 `flow-arch-plantuml` 内置 skill；
  本机 standalone `flow-arch-plantuml` skill 承接 flow/architecture diagram 触发、确认、
  `.puml` 与 INDEX 维护。
- 移除 `package.json` extraResources 中的 SOP/templates 打包项，并更新 resources 说明与
  placeholder 注释。

### 项目提示词

- 根 `CLAUDE.md` 新增“内置资产自闭环原则（重要）”，明确 Agent Deck 内部资产不得依赖
  用户侧 skill 指针；用户 skills 只能作为增强层。
- 根 `CLAUDE.md` / `AGENTS.md` 不再规定 changelog / review / convention / flow-architecture
  diagram 产物格式，只保留读取已有上下文与调用用户 skills 的最低入口。

### 本地 skill 管理

- 本机新增 standalone skills：`project-engineering-foundation` 与
  `prompt-asset-maintenance`，并登记到 `~/.skill-market/managed-skills.json`。
- `project-engineering-foundation` 承接 project templates、changelog/review/convention 组织、
  file-size guardrail 和 review expiry helper；Agent Deck simple/deep-review 只产出 findings，
  durable review record 的位置由该 skill 规定。
- `prompt-asset-maintenance` 规则强化“不保留旧结构兼容、历史迁移、过渡说明”；仍影响
  当前动作的旧行为必须改写成当前可执行规则。
- 本机新增 `complex-plan-workflow` standalone skill，承载通用复杂 plan / RFC / spike /
  review gate / handoff 方法论；Agent Deck baseline 不引用该 skill。
- 本机新增 `flow-arch-plantuml` standalone skill；Claude 版保留 AskUserQuestion / Bash /
  Claude 文件工具语义，Codex 版保留 turn boundary / shell / apply_patch 语义。
- 同步镜像到 `~/.claude/skills/`，供本机 Claude / Codex 用户环境按需增强；Claude / Codex
  skill 按各自工具能力写法维护，不追求 byte-identical。

## 验证

- `bash -n` 校验本地 Claude / Codex `project-engineering-foundation`
  `file-level-review-expiry.sh` 通过。
- 手写 frontmatter 校验确认八份本地 standalone skill
  `name` / `description` 合法。
- `python3 -m json.tool ~/.skill-market/managed-skills.json` 通过，并确认 managed state
  包含 `flow-arch-plantuml`。
- `test ! -e resources/templates && test ! -e resources/SOPs` 通过；两端内置
  `agent-deck-plugin/skills/flow-arch-plantuml` 目录也已删除。
- `cmp` 确认 Claude / Codex `flow-arch-plantuml` 与本地 `project-engineering-foundation`
  skill 都保留 adapter-specific 写法，不是 byte-identical。
- `rg` 确认应用运行资源无旧 `resources/templates` / `resources/SOPs` 指针、旧内置
  `agent-deck:flow-arch-plantuml` 指针、旧 flow-arch “位置规则由应用约定规定”指针、
  旧 `§Step 3 §选项 A` 暴露文案。
- `git diff --check` 通过。
- `pnpm typecheck` 通过。
- 独立 Codex reviewer 复查后确认 0 CRITICAL / 0 HIGH / 0 MEDIUM；发现的 LOW
  旧章节引用已修复。
