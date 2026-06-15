# CHANGELOG_260: 资产库 Agents 开关补齐与 Claude Skills/Agents 分离

## 概要

资产库补齐 Agents tab 的 Codex bundled agents 开关，并把 Claude bundled Skills / Agents 从旧的单一 plugin 开关拆成两个独立开关。开关只控制 Agent Deck 内置资源；项目和用户自定义 agents / skills 仍由各 adapter 原生加载链处理。

## 变更内容

- 新增设置项 `injectAgentDeckClaudeSkills`、`injectAgentDeckClaudeAgents`、`injectAgentDeckCodexAgents`，默认开启。
- 旧 `injectAgentDeckPlugin` 进入 settings migration：老用户如果曾关闭 Claude plugin，总开关值会迁移到两个新的 Claude 开关，然后清理旧字段。
- Claude SDK plugin mirror 改为按新开关裁剪 `skills/` / `agents/` 子目录；两者都关时不传 `plugins[]`。
- Claude / Codex `spawn_session(agentName=...)` resolver 在对应 bundled Agents 开关关闭时跳过 Agent Deck bundled root，但仍解析项目 `.claude/agents` / `.codex/agents` 和用户 `~/.claude/agents` / `~/.codex/agents`。
- `bundled-assets` 改读 Claude source path，不再读会话用 filtered mirror，避免关闭注入后资产页误隐藏内置资源。
- 资产库 UI：Skills tab 展示 Claude Skills + Codex Skills 开关；Agents tab 展示 Claude Agents + Codex Agents 开关。
- README 与 resources 说明同步新的注入边界。

## 验证

- `pnpm vitest run src/main/adapters/claude-code/sdk-injection.test.ts src/main/claude-config/custom-agents.test.ts src/main/codex-config/custom-agents.test.ts src/main/store/__tests__/settings-store.test.ts src/main/__tests__/bundled-assets-multi-root.test.ts` 通过（43 tests）。
- `pnpm typecheck` 通过。
- `git diff --check` 通过。
- `pnpm build` 通过。
