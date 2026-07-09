# CHANGELOG_182 — Phase D 方案 C：删 sync-codex-skills + claude/codex skills 两端独立 SSOT

> plan deep-review-and-asset-polish-20260530 §Phase D。推翻原「claude 单 SSOT + codex build-time 镜像」机制，改为 claude / codex 两端 skills 各自独立 SSOT，不再 sync。

## 背景

codex-config skills 此前由 `scripts/sync-codex-skills.mjs`（build-time cpSync）从 claude-config 镜像生成（`.gitignore` 忽略不入 git）。两个根本问题：

- **flow-arch-plantuml 在 SKIP_SKILLS 黑名单**（含 claude builtin `AskUserQuestion`/`Read`/`Write`，codex 端不可执行）→ codex 端长期缺 flow-arch SKILL
- **skills-installer.ts 从 claude-config 读源**装到 `~/.codex/skills/`，与 sync 黑名单不一致 → codex runtime 一直装 claude 版坏流程（HIGH bug）

adapter 工具差异（claude `Read`/`Write`/`AskUserQuestion` vs codex `shell cat`/`apply_patch`/turn 边界）决定 SKILL 措辞本质不同，「写一份再同步」必然漂移。方案 C 删 sync，两端各写独立 SSOT。

## 变更内容

### 删 sync 机制
- 删 `scripts/sync-codex-skills.mjs`
- `package.json` 删 6 处 sync hook（`predev` / `prebuild` / `predist` / `predist:mac` / `predist:win` / `predist:linux`）
- `.gitignore` 删 `resources/codex-config/agent-deck-plugin/skills/` 忽略段 → codex skills 入 git

### 核心代码
- `src/main/codex-config/skills-installer.ts` `getBuiltinSkillsSourceDir()` 源目录 `claude-config` → `codex-config`（dev + packaged 两处）+ jsdoc 改「从 codex-config 两端独立 SSOT 读」。**修复 HIGH bug**：codex runtime 不再装 claude 版 flow-arch
- `bundled-assets.ts` 不改（已正确 dual-root scan，删 sync 后 codex skills 入 git，资产面板显示 3 个 codex skill）

### codex skills 固化入 git（两端独立 SSOT）
- `skills/deep-review/SKILL.md`：删 mirror 注释；L217 去 home 文件 `user CLAUDE.md` 引用（codex 端无）改 repo 路径 `resources/claude-config/CLAUDE.md` + 「双 Bash」→「双外部 CLI」；保留 `{{AGENT_DECK_RESOURCES}}` 占位符
- `skills/hello-from-deck/SKILL.md`：已 adapter-neutral，无改动直接入 git
- **新建** `skills/flow-arch-plantuml/SKILL.md`（codex 适配，非 cp）：工具 `shell cat`/`apply_patch`（替代 claude Read/Write）；与 user 确认机制写 codex turn 边界硬约束（输出问题后结束 turn 等回复，严禁同 turn 继续生成图 — 补 codex 无 AskUserQuestion 阻塞语义）；cross-ref CODEX_AGENTS.md；严禁 plantuml -tpng/-tsvg

### claude 端文档
- claude `deep-review` / `flow-arch-plantuml` SKILL.md 删第 6 行 mirror 注释
- `resources/claude-config/CLAUDE.md` §核心流程必走 plantUML「codex 端走法」bullet 改写：删「codex 无 SKILL 入口 / 手工编辑」，改「codex 有独立 flow-arch SKILL，画图技术见该 SKILL，位置/INDEX 见 CODEX_AGENTS.md」

### codex 端文档
- `resources/codex-config/CODEX_AGENTS.md` 补 §核心流程 / 架构变更必走 plantUML 节（之前缺）：触发条件 + 文件位置（ref/flows、ref/architecture）+ INDEX 4 列 + 与 user 确认机制（codex turn 边界 + 严禁静默生成图 baseline）+ 与 deep-review 互斥 + codex shell 工具用法

### README
- `resources/claude-config/README.md`：删 sync 机制描述（L19）；3 skill + reviewer agent 描述改「两端独立 SSOT 各自维护」（删「codex 镜像」/「仅 claude 端」/「sync 不同步」）；§设计 SSOT 补「SKILL 两端独立 SSOT」policy 条

## 验证

- `pnpm typecheck` 清
- `pnpm test` 全量通过（`bundled-assets-multi-root.test.ts` 用 fixture tmp dir + mock path helper，不依赖真实 codex-config skills；无 skills-installer 单元测试）
- 历史 changelog / review / completed-plan 内「仅 claude 端」/「sync 镜像」表述是冻结历史，不 retro 改
