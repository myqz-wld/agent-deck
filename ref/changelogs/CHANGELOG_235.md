# CHANGELOG_235: Claude and Codex SDK version bump

## 概要

升级应用内 Claude / Codex SDK 依赖及其随包 native binary 版本，保持打包时 vendored SDK 与当前 npm registry latest 对齐。

## 变更内容

- `@anthropic-ai/claude-agent-sdk` 从 `^0.3.168` 升级到 `^0.3.169`；lockfile 同步更新所有 Claude Agent SDK 平台子包到 `0.3.169`。
- `@anthropic-ai/sdk` 从 `^0.96.0` 升级到 `^0.102.0`。
- `@openai/codex-sdk` 从 `^0.137.0` 升级到 `^0.138.0`；lockfile 同步更新 `@openai/codex` 及其平台 native 包到 `0.138.0`。
- 本机全局 `pnpm` 是 v9，但当前 `node_modules` 已由 pnpm v10 store 链接；本次更新用 `pnpm@10.34.1` 执行，避免 store major 切换导致重装。

## 验证

- `npx pnpm@10.34.1 typecheck`
