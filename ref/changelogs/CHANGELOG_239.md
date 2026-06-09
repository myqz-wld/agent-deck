# CHANGELOG_239: Codex runtime 全量切到 app-server

## 概要

Codex 侧不再保留 `@openai/codex-sdk` runtime 路径。live session 继续使用
`codex app-server --stdio`，summary / handoff oneshot 也改为复用 app-server client。
同时 Codex tok/s 展示只使用 app-server `thread/tokenUsage/updated` 的权威 delta，
不再混入文本估算。

## 变更内容

- `codex-instance-pool` 从 SDK `Codex` 工厂切到 `CodexAppServerClient` oneshot pool；
  `runCodexOneshot()` 改为 `startThread(...).run(appServerInput, { signal })`。
- `CodexAppServerThread` 新增 `run()`，保留 callers 需要的 `finalResponse` contract。
- `modelReasoningEffort` 写入 app-server thread config，保留 summary / handoff 既有推理档位。
- Codex live tok/s 改为按 `tokenUsage.last.outputTokens + reasoningOutputTokens`
  作为本次权威输出增量，并除以上一条 usage 通知到当前通知的耗时。
- 删除旧 SDK `ThreadEvent` translator、旧 SDK live-rate 文本估算 fallback、旧 `sdk-loader`，
  依赖从 `@openai/codex-sdk` 改为直接依赖 `@openai/codex`。
- 测试更新为 app-server event/input 形态，覆盖 usage delta tok/s、app-server translator、
  oneshot model passthrough、createSession rollback/earlyErr cleanup 等路径。

## 验证

- `pnpm typecheck`
- `pnpm exec vitest run src/main/adapters/codex-cli/app-server/translate.test.ts src/main/adapters/codex-cli/sdk-bridge/__tests__/live-token-rate.test.ts src/main/adapters/codex-cli/__tests__/codex-model-passthrough.test.ts src/main/adapters/codex-cli/sdk-bridge/__tests__/create-session-thread-id-init.test.ts src/main/adapters/codex-cli/__tests__/sdk-bridge.early-err-cleanup.test.ts src/main/adapters/codex-cli/__tests__/sdk-bridge.consume-fork.test.ts src/main/adapters/codex-cli/__tests__/wire-prefix-e2e.test.ts src/main/adapters/codex-cli/__tests__/per-session-codex-env.test.ts src/main/adapters/codex-cli/__tests__/sdk-bridge.recovery.test.ts`
