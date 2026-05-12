# resources/claude-config/

应用打包时会把这两个目录的内容一起塞进 `.app/Contents/Resources/claude-config/`，运行时由主进程注入到每个应用内 SDK 会话的环境（system prompt / settings / plugin）。

## CLAUDE.md（应用环境约定）

`resources/claude-config/CLAUDE.md` —— 应用打包注入到每个 SDK 会话 system prompt 末尾，**位置在 user / project / local CLAUDE.md 之后**。

设计原则（REVIEW_30 决议）：

- **只放 agent-deck 应用专属差异（Δ user CLAUDE.md）**，绝不复制 user CLAUDE.md 任何通用约定（输出 / 运行时 / 决策对抗 / 复杂 plan / 工程地基 / 模板）—— 这些通用内容由 `~/.claude/CLAUDE.md` 在 user scope 提供，CLI 加载顺序保证它已先入 system prompt
- 当前文件只含两节：
  - `§应用环境差异（Δ user CLAUDE.md）` —— 协议覆盖 / SKILL 失败兜底分支等仅在 agent-deck 应用环境生效的差异
  - `§Agent Deck Universal Team Backend` —— 应用专属的 mcp 7 tool 协议（其他环境无此节）
- 历史的「除本打包文件专属节外，其余通用约定需与 ~/.claude/CLAUDE.md 保持一致；改一处必须同步另一处」**人工同步约定已废弃**（机器无法执行已发生漂移，详 REVIEW_30 H1）

### 改动维护

- 改 `resources/claude-config/CLAUDE.md` → 应用 build → 装新 .app（或 dev 模式重启），不要手动改打包后版本
- 改通用约定（输出 / 运行时 / 决策对抗等）→ 改 `~/.claude/CLAUDE.md`，**不要**在本文件复制粘贴 —— SDK 会话会从 user scope 自动加载

## agent-deck-plugin/

应用打包注入的 plugin 包（agents / skills / commands）：

- `agents/reviewer-claude.md` / `agents/reviewer-codex.md` —— deep-code-review SKILL 用的两 reviewer teammate body
- `skills/deep-code-review/SKILL.md` —— 多轮异构 review × fix 收口的 SKILL
- `skills/hello-from-deck/SKILL.md` —— plugin 自检 SKILL

设计 SSOT：

- `~/.claude/CLAUDE.md` §决策对抗 节定义「单次决策对抗」走双 Bash 起外部 CLI 主路径
- `resources/claude-config/CLAUDE.md` §Agent Deck Universal Team Backend 定义 mcp 7 tool 协议
- `agent-deck-plugin/skills/deep-code-review/SKILL.md` 定义「多轮深度 review」走 teammate 模式
- `agent-deck-plugin/agents/reviewer-{claude,codex}.md` 是两 reviewer teammate 行为契约

reviewer agent body 引用上述 SSOT，**不复述协议细节**（避免维护漂移）。

## 历史

- 2026-05-13：REVIEW_30 异构对抗 review 决议把 5 大通用节从 `resources/claude-config/CLAUDE.md` 删除，改为引用 `~/.claude/CLAUDE.md` SSOT；6 markdown 模板 + 2 个 reviewer bash 模板移到 `~/.claude/templates/`；3 个 SOP 移到 `~/.claude/SOPs/`；本 README 取代历史 HTML 注释里的同步约定（详 CHANGELOG_79）
