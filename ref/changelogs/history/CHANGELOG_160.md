# CHANGELOG_160

Settings UI 重构 — 三 tab 切换(通用 / claude code / codex cli)+ AgentDeckMcpSection 简化 + 删 CodexMcpServersSection 引用 + mcpStdioEnabled 默认 ON。

## 概要

User 三个 settings UI 改动诉求一次性收口:
1. **Transport 子开关从设置面板去掉,默认都开启,留段介绍** (AgentDeckMcpSection 简化)
2. **删 CodexMcpServersSection 引用** (User: "不管 mcp 也去掉 codex mcp" — settings.codexMcpServers 字段保留持久化,UI 不暴露)
3. **三 tab 切换** (通用 / claude code / codex cli)

## 变更内容

### `src/renderer/components/SettingsDialog.tsx` 加三 tab 切换

- 加 `activeTab` state(`'general' | 'claude' | 'codex'`),每次打开 settings reset 到 `'general'`
- `<nav role="tablist">` 三按钮(通用 / claude code / codex cli),active 态高亮 + hover 态
- 删 `CodexMcpServersSection` import + usage
- 各 tab 独立 conditional render:
  - **通用 tab** (9 section / 4 SectionGroup):「会话」LifecycleSection + SummarySection;「提醒与外观」NotifySection + WindowSection + KeyboardShortcutsSection;「集成与运行环境」HookServerSection + ExternalToolsSection + ExperimentalSection;「跨工具协作 (MCP)」AgentDeckMcpSection
  - **claude code tab** (1 section + placeholder):HookSection(Claude Code Hook 系统钩子,安装到 `~/.claude/settings.json`)+ Claude 端 MCP servers 说明段(由 user 直接编辑 `~/.claude/settings.json` 或 project-level `.mcp.json`)
  - **codex cli tab** (0 section + placeholder):Codex 端配置说明段(model / sandbox / approval / MCP servers / agents registry 等由 user 直接编辑 `~/.codex/config.toml` + `~/.codex/AGENTS.md`;通用 codex 字段 `codexSummaryModel` / `codexHandOffModel` 在通用 tab 「会话」段)

### `src/renderer/components/settings/sections/AgentDeckMcpSection.tsx` 简化

- 删 L74-105 "Transport 子开关" 整块(`mcpHttpEnabled` + `mcpStdioEnabled` 两个 Toggle + hint)
- 替换为「三 transport 并存(默认全启)」table(3 行:in-process / HTTP / stdio,各含技术细节 + endpoint + auth 要求)
- jsdoc 更新说明 CHANGELOG_160 简化(transport 子开关 toggle 删,字段持久化保留但 UI 不暴露 — user 想关单 transport 编辑 `settings.json`)

### `src/shared/types/settings.ts` 默认值更新

- `mcpStdioEnabled: false` → `mcpStdioEnabled: true` (对齐 User 「默认都开启」要求;`mcpHttpEnabled` 原本就 true 不动)

### `src/renderer/components/settings/sections/CodexMcpServersSection.tsx` 文件保留

文件不删 — 仅从 SettingsDialog 引用移除。`settings.codexMcpServers` 字段 + IPC 路径 + `~/.codex/config.toml` marker 段同步逻辑全部保留(未来若需 UI 再接回 import + render 一行)。

## 不影响

- `settings.mcpHttpEnabled` / `mcpStdioEnabled` 字段保留,运行时仍 honor(user 想细调单 transport 编辑 `~/Library/Application Support/Agent Deck/agent-deck-settings.json`)
- `settings.codexMcpServers` 字段保留,`~/.codex/config.toml` marker 段同步仍生效
- 三 tab 间共享同一 `settings` state + `update()` 函数,user 在 tab 间切换不丢未保存 draft(各 section 内 commit on blur)

## 验证

- `pnpm typecheck` GREEN
