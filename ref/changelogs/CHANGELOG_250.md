# CHANGELOG_250: Claude/Codex native agents 与 Codex 会话级注入

## 概要

`spawn_session(agentName)` 改为按 adapter 原生能力启动：Claude-family 使用 SDK `agent` / `agents`，Codex 解析官方 custom-agent TOML 并映射到 app-server 支持的 thread/config 字段。Codex 应用约定和内置 skills 不再写入用户级 `~/.codex/AGENTS.md` / `~/.codex/skills/agent-deck/`，改为 in-app 会话级注入。

## 变更内容

- 新增 Codex TOML agent parser / loader，支持 bundled、项目 `.codex/agents/*.toml`、用户 `~/.codex/agents/*.toml`，以 TOML `name` 为 source of truth。
- 新增 Claude agent loader，支持 bundled、项目 `.claude/agents/<name>.md`、用户 `~/.claude/agents/<name>.md`，并通过 Claude SDK `agent` / `agents` 启动。
- `reviewer-codex` 从 markdown body 转为官方 TOML custom agent；`spawn_session` 不再把 agent body 前缀拼进首条 prompt。
- Codex custom agent 的 `developer_instructions`、`model`、`model_reasoning_effort`、`sandbox_mode`、`skills.config` / `mcp_servers` 等 config 层透传到 app-server thread/config。
- Codex `CODEX_AGENTS.md` 改为 app-server `developerInstructions` 会话级注入；历史 `~/.codex/AGENTS.md` Agent Deck marker 只做清理，不再追加。
- Codex 内置 skills 改为 app userData mirror + `skills/extraRoots/set`，并清理历史 `~/.codex/skills/agent-deck/` 托管目录。
- 资产库支持新增/编辑/删除 Codex custom-agent TOML；Codex agent 正文对应 `developer_instructions`。
- MCP `spawn_session` / `agentName` 描述更新为 bundled/project/user native agent source，明确不设置 `agentName` 就走通用会话。

## 验证

- `pnpm typecheck` 通过。
- `pnpm vitest run src/main/agent-deck-mcp/__tests__/spawn-agent-name-routing.test.ts src/main/agent-deck-mcp/__tests__/tools.test.ts src/main/adapters/codex-cli/app-server/client.test.ts src/main/adapters/codex-cli/sdk-bridge/__tests__/thread-options-builder.test.ts src/main/adapters/claude-code/sdk-bridge/__tests__/query-options-builder.test.ts src/main/codex-config/custom-agents.test.ts src/main/__tests__/bundled-assets-multi-root.test.ts` 通过（104 tests）。
- `pnpm test:node` 通过（SQLite 真测因本机 better-sqlite3 Electron ABI 与系统 Node ABI 不匹配按既有 guard 跳过）。
- `pnpm build` 通过。
- `git diff --check` 通过。
