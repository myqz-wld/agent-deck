# resources/

应用打包资源的维护入口。`package.json` 的 `build.extraResources` 会把这里的运行时资源复制到 `.app/Contents/Resources/` 下，主进程再按 adapter 注入到 SDK 会话。

## 打包路径

| 源目录 | 打包后目录 | 用途 |
|---|---|---|
| `resources/bin` | `.app/Contents/Resources/bin` | CLI wrapper 与辅助脚本 |
| `resources/claude-config` | `.app/Contents/Resources/claude-config` | Claude Code / Deepseek(Claude Code) 侧应用约定与 plugin |
| `resources/codex-config` | `.app/Contents/Resources/codex-config` | Codex 侧应用约定、agent body 与 skills 源 |
| `resources/sounds` | `.app/Contents/Resources/sounds` | 应用提示音 |

不要手动改打包后的 `.app/Contents/Resources/*` 文件；改本目录源文件后重新 build / 重启 dev。

## claude-config/

Claude Code adapter 使用的资源根，Deepseek(Claude Code) 复用这套 agents / skills / CLAUDE.md，只叠加 provider 配置。

- `CLAUDE.md`：通过 Claude SDK `systemPrompt.append` 追加到 preset system prompt 末尾，位置在 user / project / local `CLAUDE.md` 之后。设置面板保存的用户副本落 `<userData>/agent-deck-claude.md`，优先于内置文件。
- `agent-deck-plugin/`：Claude SDK `plugins` 字段使用的本地 plugin 源。运行时会镜像到 `<userData>/agent-deck-plugin/` 并替换资源占位符，再交给 SDK 扫描。
- `agent-deck-plugin/agents/reviewer-claude.md`：Claude Code 原生 reviewer teammate body。
- `agent-deck-plugin/skills/*/SKILL.md`：Claude Code 侧 `agent-deck:*` skills。

## codex-config/

Codex adapter 使用的资源根。Codex CLI 没有 Claude SDK 的 `plugins[]` 扫描机制，所以注入路径和 Claude 侧不同。

- `CODEX_AGENTS.md`：由 `src/main/codex-config/agents-md-installer.ts` 同步进 `~/.codex/AGENTS.md` 的 Agent Deck marker 段。
- `agent-deck-plugin/agents/reviewer-codex.md`：Codex 原生 reviewer teammate body，由 bundled-assets scan 后供 `spawn_session(agentName)` 路由。
- `agent-deck-plugin/skills/*/SKILL.md`：由 `src/main/codex-config/skills-installer.ts` 安装到 `~/.codex/skills/agent-deck/<skill>/SKILL.md`。

## 设计 SSOT

- 协议层与应用环境约定分别在 `resources/claude-config/CLAUDE.md` 与 `resources/codex-config/CODEX_AGENTS.md`。两端语义必须对齐；adapter 工具差异允许措辞不同。
- Reviewer body 两端独立维护：`reviewer-claude.md` 只在 Claude 侧，`reviewer-codex.md` 只在 Codex 侧。不要为了“镜像同步”复制到另一端。
- Skills 两端独立 SSOT：Claude skills 在 `resources/claude-config/agent-deck-plugin/skills/`，Codex skills 在 `resources/codex-config/agent-deck-plugin/skills/`。同名 skill 的目标行为要对齐，但实现说明按 adapter 工具能力分别写。
- project templates、changelog/review/convention 组织规则、flow/architecture diagram 维护、file-size guardrail 与 review expiry 脚本由用户环境里的 skills 管理；Agent Deck 打包资源只保留应用流程与内置能力。
- 改长生命周期 prompt 资产前，按 `resources/claude-config/CLAUDE.md` / `resources/codex-config/CODEX_AGENTS.md` 的“提示词资产维护”章节做自检。
