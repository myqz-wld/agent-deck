# CHANGELOG_257: reviewer-claude 消息 MCP 工具与 issue adapter 记忆

## 概要

修复 issue `658bcf85-712d-42a7-8bac-922e57285ede`：`reviewer-claude` 通过 Agent Deck spawn 后必须能调用 `send_message` 回传 review / rebuttal，不再因为 Claude custom agent `tools` 白名单缺少 Agent Deck MCP 工具而只能把结果留在 SessionDetail。

同时修复 Issues 页面「起新会话解决问题」弹窗不记忆 adapter 选择的问题。新建会话弹窗和 issue 解决弹窗现在共享同一个 last-used adapter 记忆。

## 变更内容

- `resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md` 的 `tools:` frontmatter 补 `mcp__agent-deck__send_message` 与 `mcp__agent-deck__list_sessions`。
- `src/main/claude-config/custom-agents.ts` 对 `reviewer-claude` 的非空工具白名单追加这两个必需 MCP 工具，作为 runtime 防线。
- `src/renderer/hooks/useLastSessionDefaults.ts` 新增 `getLastAdapter` / `setLastAdapter`。
- `NewSessionDialog` 与 `ResolveInNewSessionDialog` 初始化、adapter 切换、可用 adapter 回退都读写同一个 last-used adapter。

## 验证

- `pnpm vitest run src/main/claude-config/custom-agents.test.ts src/renderer/hooks/__tests__/useLastSessionDefaults.test.ts`
- `pnpm typecheck`

## 关联

- Review 记录：[`REVIEW_114.md`](../../reviews/history/REVIEW_114.md)
