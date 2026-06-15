# CHANGELOG_264: 升级 Claude Agent SDK 到 0.3.177

## 概要

同步检查 Claude / Codex 相关 npm 依赖版本：`@anthropic-ai/claude-agent-sdk` 升级到 `0.3.177`；`@openai/codex` 和 `@anthropic-ai/sdk` 的 registry latest 稳定版与当前依赖一致，保持不变。

## 变更内容

- `@anthropic-ai/claude-agent-sdk`: `^0.3.175` -> `^0.3.177`。
- `pnpm-lock.yaml` 同步更新 Claude Agent SDK 及其 darwin / linux / win32 平台 native 子包到 `0.3.177`。
- `@openai/codex`: registry `latest` 仍为 `0.139.0`，未采用 `0.140.0-alpha.19`。
- `@anthropic-ai/sdk`: registry `latest` 仍为 `0.104.1`，不变。

## 验证

- `pnpm typecheck`
- `pnpm build`
