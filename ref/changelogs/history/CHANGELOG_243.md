# CHANGELOG_243

## reviewer-codex sandbox follows normal spawn inheritance

## 概要

移除 reviewer-* Codex spawn 对 `codexSandbox = 'workspace-write'` 的强制覆盖。reviewer-codex 现在与普通 Codex teammate 一样遵循 `spawn_session` 的沙盒选择链：caller 显式参数优先，其次同 adapter caller 的持久化沙盒，最后使用 Codex adapter 默认值。

## 变更内容

- `options-builder` 的 reviewer-* 分支不再改写 `codexSandbox`，只保留 reviewer 必需的 `approvalPolicy: 'never'`、`networkAccessEnabled: true` 和 `additionalDirectories: ['~/.claude', '~/.codex', '/tmp']` 注入。
- `spawn_session` handler 继续在进入 adapter 前计算 effective sandbox，确保显式覆盖和 same-adapter 继承仍按统一规则生效。
- 更新 MCP `spawn_session.codexSandbox` tool description、Codex 应用约定和内置 `reviewer-codex` 文案，移除“reviewer 默认/固定 workspace-write”的旧描述。
- 更新 reviewer spawn 单测：覆盖无显式 sandbox 时不强塞、显式 `danger-full-access` 时保持透传。
- 同步当前源码注释，避免后续维护者继续按旧的 “4 字段 unsafe default” 理解 reviewer 沙盒行为。

## 验证

- `pnpm vitest run src/main/adapters/codex-cli/__tests__/teammate-spawn-defaults.test.ts src/main/agent-deck-mcp/__tests__/tools.test.ts`
- `pnpm typecheck`
- `git diff --check`
- `pnpm dist`
