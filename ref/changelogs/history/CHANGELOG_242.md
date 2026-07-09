# CHANGELOG_242

## Claude / Codex CLI and SDK version bump

## 概要

升级应用内打包使用的 Claude / Codex 依赖到当前稳定版本，覆盖 Codex CLI/native 包、Claude Agent SDK 平台包和 Anthropic TypeScript SDK。

## 变更内容

- `@openai/codex` 从 `^0.138.0` 升级到 `^0.139.0`，lockfile 同步更新所有 Codex 平台 native 包到 `0.139.0`。
- `@anthropic-ai/claude-agent-sdk` 从 `^0.3.169` 升级到 `^0.3.170`，lockfile 同步更新所有 Claude Agent SDK 平台 native 包到 `0.3.170`。
- `@anthropic-ai/sdk` 从 `^0.102.0` 升级到 `^0.104.1`。
- `@modelcontextprotocol/sdk` registry latest 仍是 `1.29.0`，本次保持不变。
- 本机全局 `pnpm` 是 v9，但当前 `node_modules` 使用 pnpm v10 store；本次更新用 `npx pnpm@10.34.1` 执行，避免 store major 切换导致重装。

## 验证

- `node -p "require('./node_modules/@openai/codex/package.json').version"` → `0.139.0`
- `node -p "require('./node_modules/@anthropic-ai/claude-agent-sdk/package.json').version"` → `0.3.170`
- `node -p "require('./node_modules/@anthropic-ai/sdk/package.json').version"` → `0.104.1`
- `./node_modules/.bin/codex --version` → `codex-cli 0.139.0`
- `npx pnpm@10.34.1 exec vitest run src/main/adapters/codex-cli/__tests__/codex-binary-layout.test.ts src/main/adapters/codex-cli/__tests__/teammate-spawn-defaults.test.ts src/main/adapters/codex-cli/sdk-bridge/__tests__/thread-options-builder.test.ts src/main/adapters/claude-code/__tests__/resolve-claude-binary.test.ts src/main/adapters/claude-code/__tests__/sandbox-config.test.ts`
- `npx pnpm@10.34.1 typecheck`
- `npx pnpm@10.34.1 build`
