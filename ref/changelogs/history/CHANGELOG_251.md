# CHANGELOG_251: reviewer 双侧 thinking 升至 xhigh 与 Claude agent effort 支持

## 概要

内置 reviewer 异构对的推理档位统一升至 `xhigh`：`reviewer-codex` TOML 加 `model_reasoning_effort = "xhigh"`（既有透传链路）；Claude agent loader 新增 frontmatter `effort` 支持（SDK `AgentDefinition.effort`，0.3.175 起支持 `low`–`max`），`reviewer-claude` 设 `effort: xhigh`。

## 变更内容

- `resources/codex-config/agent-deck-plugin/agents/reviewer-codex.toml`：新增 `model_reasoning_effort = "xhigh"`，经既有 `modelReasoningEffort` → thread config 链路生效。
- `resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md`：frontmatter 新增 `effort: xhigh`。
- `src/main/claude-config/custom-agents.ts`：解析并校验 frontmatter `effort`（`low`/`medium`/`high`/`xhigh`/`max`），非法值直接 resolve 失败（不静默丢弃）；effort 同时写入 SDK `AgentDefinition.effort` 与 `ClaudeCustomAgentContent.effortLevel`。
- `spawn_session`：Claude-family agent 的 effort 经 `claudeCodeEffortLevel` 透传到 SDK 顶层 `options.effort`（双保险，避免仅靠 AgentDefinition.effort 在 main-thread agent 场景静默不生效）；显式 `thinking` 参数仍最高优先级，schema 描述同步注明。
- 已知限制（沿既有设计）：资产库编辑器保存 user 副本只回写 name/description/tools/model + body，agent 级 effort 字段不经 UI round-trip；bundled agent 解析优先级最高，不受 user 副本影响。

## 验证

- `pnpm typecheck` 通过。
- `pnpm vitest run src/main/claude-config/custom-agents.test.ts src/main/codex-config/custom-agents.test.ts src/main/agent-deck-mcp/__tests__/spawn-agent-name-routing.test.ts src/main/agent-deck-mcp/__tests__/tools.test.ts` 通过。
