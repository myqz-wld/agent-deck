# REVIEW_114 — reviewer-claude send_message 缺失与 issue adapter 记忆

## 触发场景

用户要求处理 issue `658bcf85-712d-42a7-8bac-922e57285ede`：deep-review rebuttal 中 `reviewer-claude` 报告 Agent Deck MCP `send_message` 不可用，导致 wait-boundary reply path 断开。用户同时指出 Issues 页面不会记忆 adapter 选择。

## Scope

- `resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md`
- `src/main/claude-config/custom-agents.ts`
- `src/main/claude-config/custom-agents.test.ts`
- `src/renderer/hooks/useLastSessionDefaults.ts`
- `src/renderer/hooks/__tests__/useLastSessionDefaults.test.ts`
- `src/renderer/components/NewSessionDialog.tsx`
- `src/renderer/components/ResolveInNewSessionDialog.tsx`

## 裁决

### [MEDIUM ✅] reviewer-claude agent 工具白名单漏掉消息 MCP 工具

**证据**：`reviewer-claude.md` frontmatter 原为 `tools: Read, Grep, Glob, Bash`。Claude custom agent 的 `tools` 字段会限制该 agent 可见工具，即使 SDK session 已挂载 Agent Deck MCP server，agent 自身也看不到 `mcp__agent-deck__send_message` / `list_sessions`。

**修法**：frontmatter 补齐 `mcp__agent-deck__send_message`、`mcp__agent-deck__list_sessions`；同时在 Claude custom-agent resolver 中对 `reviewer-claude` 的非空 tools 白名单追加这两个必需工具，防止未来资产字段漂移再次打断 delivery path。

### [LOW ✅] issue 解决弹窗不记忆 adapter

**证据**：`ResolveInNewSessionDialog` 每次 mount 都从 `useState('claude-code')` 开始，只共享 permission / sandbox last-used，不共享 adapter。Issue detail 里的弹窗会被关闭后卸载，因此用户切到 Codex/Deepseek 后重开又回到 Claude。

**修法**：`useLastSessionDefaults` 增加 module-level last adapter；`NewSessionDialog` 和 `ResolveInNewSessionDialog` 都用它作为初始值，并在用户切换 adapter 或可用 adapter 回退时写回。

## 验证

```bash
pnpm vitest run src/main/claude-config/custom-agents.test.ts src/renderer/hooks/__tests__/useLastSessionDefaults.test.ts
pnpm typecheck
```

结果：

- 2 test files passed，9 tests passed。
- `pnpm typecheck` passed。

## 关联 changelog

- [`CHANGELOG_257.md`](../changelogs/CHANGELOG_257.md)
