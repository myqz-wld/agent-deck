# resources/

应用运行时资源的源目录。`package.json` 的 `build.extraResources` 会把本目录复制到 `.app/Contents/Resources/`，主进程再按 adapter 读取并注入 SDK 会话。

本文只记录资源路径、加载方式和对偶关系；项目维护流程不写进打包资源说明。

## 打包路径

| 源目录 | 打包后目录 | 用途 |
|---|---|---|
| `resources/bin` | `.app/Contents/Resources/bin` | CLI wrapper 与辅助脚本 |
| `resources/claude-config` | `.app/Contents/Resources/claude-config` | Claude Code / Deepseek（Claude Code）侧应用约定与 plugin 资源 |
| `resources/codex-config` | `.app/Contents/Resources/codex-config` | Codex 侧应用约定、agent body 与 skill 资源 |
| `resources/sounds` | `.app/Contents/Resources/sounds` | 应用提示音 |

不要手动改打包后的 `.app/Contents/Resources/*` 文件；改本目录源文件后重新 build 或重启 dev。

## claude-config/

Claude Code adapter 使用这个资源根。Deepseek（Claude Code）复用同一套 agents / skills / `CLAUDE.md`，并通过 `~/.agent_deck/.deepseek/settings.json` 叠加 provider env。

- `CLAUDE.md`：通过 Claude SDK `systemPrompt.append` 追加到 preset system prompt 末尾，位置在 user / project / local `CLAUDE.md` 之后。设置面板保存的用户副本落 `<userData>/agent-deck-claude.md`，存在时覆盖内置文件。
- `agent-deck-plugin/`：Claude SDK `plugins` 字段使用的本地 plugin 源。运行时会镜像到 `<userData>/agent-deck-plugin/` 并替换资源占位符，再交给 SDK 扫描。
- `agent-deck-plugin/agents/reviewer-claude.md`：Claude Code reviewer teammate body。
- `agent-deck-plugin/skills/*/SKILL.md`：Claude Code 侧 `agent-deck:*` skills。

## codex-config/

Codex adapter 使用这个资源根。Codex CLI 没有 Claude SDK 的 `plugins[]` 扫描机制，所以注入路径和 Claude 侧不同。

- `CODEX_AGENTS.md`：由 `src/main/codex-config/agents-md-installer.ts` 同步进 `~/.codex/AGENTS.md` 的应用 marker 段。
- `agent-deck-plugin/agents/reviewer-codex.md`：Codex reviewer teammate body，由 bundled-assets scan 后供 `spawn_session(agentName)` 路由。
- `agent-deck-plugin/skills/*/SKILL.md`：由 `src/main/codex-config/skills-installer.ts` 安装到 `~/.codex/skills/agent-deck/<skill>/SKILL.md`。

## 对偶关系

- 应用环境约定成对维护：`resources/claude-config/CLAUDE.md` 与 `resources/codex-config/CODEX_AGENTS.md` 的协议语义必须对齐；adapter 工具差异按各自运行方式写。
- Reviewer body 成对维护：`reviewer-claude.md` 和 `reviewer-codex.md` 要对齐角色、输入契约、输出格式和失败处理；不要为了镜像同步复制另一端的工具说明。
- Skills 按同名文件成对维护：Claude skills 在 `resources/claude-config/agent-deck-plugin/skills/`，Codex skills 在 `resources/codex-config/agent-deck-plugin/skills/`。同名 skill 的触发条件和目标行为要对齐，执行步骤按 adapter 工具能力分别写。
- 打包资源必须自闭环：应用约定、reviewer agents 与 skills 在没有用户自定义 agents / skills 时仍要完整可用。
