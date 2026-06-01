# CHANGELOG_192 — 删「决策对抗」节 + 新建 simple-review SKILL 替代 + 提示词资产维护章节归位

## 概要

用户三合一诉求（原会话 `facb8f92` 承接，channel 坏后 hand-off 仅交接了日志查看子任务 → 见 [CHANGELOG_191](CHANGELOG_191.md)；本条收口被遗漏的「提示词资产重构」主体）:

1. **删「决策对抗」章节**（user 级 `~/.claude/CLAUDE.md` + 应用打包 `claude-config/CLAUDE.md` + `codex-config/CODEX_AGENTS.md`），新建 **`simple-review` SKILL** 替代「下结论/出 plan/升级约定前的单次对抗评审」能力 —— 改用 `spawn_session` 起异构 reviewer 对（UI 实时可观测），区别于此前 Bash oneshot 起外部 CLI 的不可观测路径。
2. **提示词资产维护章节归位**：从 user 级 CLAUDE.md 删除「提示词资产维护」节，下沉到应用打包的 `claude-config/CLAUDE.md` + `codex-config/CODEX_AGENTS.md`（codex 端按 shell / `~/.codex/AGENTS.md` 视角适配）。
3. **清理无用资源**：删 `reviewer-claude.sh.tmpl` / `reviewer-codex.sh.tmpl`（外部 CLI 模板，simple-review 改走 spawn 不再需要）+ `codex-cli-stuck-lessons.md`（项目内 + user 级）+ 过时 convention `01-reviewer-claude-oneshot-disallow-exitplanmode.md`（整条讲已删的 .sh.tmpl）。

> 注：本条为 .md 提示词资产 + 3 处注释 repoint 的重构，无运行时逻辑变更。原会话标「组 A completed」但未写 changelog / 未验证 / 未提交，本会话从 SQLite 还原其上下文后收口。

## 变更内容

### A1 — 重写两份 deep-review SKILL

- `resources/{claude,codex}-config/agent-deck-plugin/skills/deep-review/SKILL.md`：inline 三态裁决 + Finding 输出契约（原依赖已删的「决策对抗」节作 SSOT）；**失败兜底改纯 spawn**（去掉 `.sh.tmpl` 外部 CLI 路径）；重命名「与决策对抗关系」节。两端独立 SSOT 各改（claude / codex 视角措辞不同）。

### A2 — 新建两份 simple-review SKILL（本次重构核心）

- `resources/claude-config/agent-deck-plugin/skills/simple-review/SKILL.md`（新建，15.5KB）
- `resources/codex-config/agent-deck-plugin/skills/simple-review/SKILL.md`（新建，15.6KB，codex 视角：`shell cat`/`grep`、`~/.codex/AGENTS.md`）
- 定位：**单次**异构对抗评审（比 deep-review 轻，不强制多轮挖深），spawn `reviewer-claude` + `reviewer-codex` 各跑一遍 full_review → lead 三态裁决 → 有 HIGH/MED 才 fix + 可选复用同对再来一轮。reviewer 走 SDK in-process teammate，UI 实时可见。
- frontmatter 触发词覆盖「review 一下」/「简单 review」/「决策评审」/「对抗一下」/「约定升级评审」等。

### A3 — 修 reviewer body 悬空指针

- `reviewer-claude.md` / `reviewer-codex.md`：指向 `§Finding 输出契约` 的 cross-ref（enum 本体已 inline，仅 1 句悬空指针）repoint。

### A4 — 删「决策对抗」节 + 修内部 dangling

- **user `~/.claude/CLAUDE.md`**：删「决策对抗」整节 → 文件收敛到仅「输出 + 运行时」两节。
- **`claude-config/CLAUDE.md`**：删「决策对抗」整节 + 6 处内部 dangling（self-ref / RFC / spike / Step1.5 / 收口 / 反复反馈引用）repoint 到 `agent-deck:simple-review`；reviewer-codex 失败兜底节改纯 spawn。
- **`codex-config/CODEX_AGENTS.md`**：对称删节 + 修 dangling + reviewer-claude 失败兜底改纯 spawn。

### A5 — 提示词资产维护章节归位

- user CLAUDE.md 删「提示词资产维护」节；`claude-config/CLAUDE.md:531` + `CODEX_AGENTS.md:117` 新增该节（插在 §新项目工程地基 末 / §plantUML 末，§Universal Team Backend 之前）。

### A6 — 清周边 dangling

- `resources/SOPs/file-size-guardrail.md` / `file-level-review-expiry.sh`、`resources/templates/{review,conventions-index,conventions-tally,project-claude}.template.md`、项目根 `CLAUDE.md:115` gate 引用、`resources/claude-config/README.md:33` 真 dangling、`ref/conventions/INDEX.md`（删行 + 修流程引用）+ `tally.md`（header repoint）：全部「走决策对抗三态裁决」→「走 `agent-deck:simple-review` 评审」。
- **3 处 src/*.ts 注释 repoint**（comment-only，零逻辑变更）：`agents-md-installer.ts` / `schemas.ts` / `codex-recoverer-messages.ts`。

### A7 — 删无用资源文件

- `resources/templates/reviewer-claude.sh.tmpl` + `reviewer-codex.sh.tmpl`
- `resources/SOPs/codex-cli-stuck-lessons.md`（项目内 + user 级）
- `ref/conventions/01-reviewer-claude-oneshot-disallow-exitplanmode.md`（整条讲被删的 .sh.tmpl）

## 验证

- ✅ **simple-review SKILL ×2 真建好**：frontmatter `name`/`description` 合法，格式与 sibling deep-review 一致；plugin 按目录自动发现（plugin.json 不枚举 skill，无需改 manifest）。
- ✅ **grep 自检无活 dangling**：`resources/` + `src/` 内「决策对抗」仅剩 `plan §决策对抗 Round N` 历史 plan/review 轮次锚点（正确保留）；`.sh.tmpl` / `codex-cli-stuck-lessons` 0 残留引用；「提示词资产维护」残留均为新增节自身 + 按名引用约定的注释（重定位非删除，符合预期）。`ref/` 下历史 plan/changelog 归档按约定保留不动。
- ✅ **3 处 src/*.ts 为 comment-only repoint**，无逻辑变更 → 已被 CHANGELOG_191 的 `pnpm typecheck` + `pnpm build` 双绿覆盖（同一工作树）。
- ✅ **deep-review SKILL ×2 失败兜底已去 .sh.tmpl**，改纯 spawn。

## 备注

本条与 [CHANGELOG_191](CHANGELOG_191.md)（日志查看改造）同属用户三合一诉求，因原会话 hand-off 仅交接日志子任务而分裂为两条 changelog。本会话通过从 SQLite (`agent-deck.db`) 还原原会话 `facb8f92` 完整上下文后，识别并收口被遗漏的提示词资产重构主体。
