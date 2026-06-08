# CHANGELOG_231: Codex 默认模型占位不再传给 SDK

## 概要

修复 Codex 会话恢复 / 冷重启时把统计占位 `codex-default` 当真实模型传给
`@openai/codex-sdk`，导致 ChatGPT 账号报
`The 'codex-default' model is not supported when using Codex with a ChatGPT account` 的问题。

## 变更内容

- 新增 `toCodexSdkModelOverride()`：统一过滤空 model 与 `codex-default` 占位。
- Codex live thread、recover、restart、jsonl-missing fallback、summary / hand-off oneshot
  全部通过该 helper 生成 SDK `model` override。
- 保留 `codex-default` 作为 token 统计 / UI 展示 bucket；只禁止它进入 Codex SDK 入参。
- 补测试覆盖 ThreadOptions、oneshot、restart 从 DB 读到占位模型的路径。

## 验证

- `pnpm exec vitest run src/main/adapters/codex-cli/sdk-bridge/__tests__/thread-options-builder.test.ts src/main/adapters/codex-cli/__tests__/codex-model-passthrough.test.ts src/main/adapters/codex-cli/__tests__/sdk-bridge.consume-fork.test.ts`
- `pnpm typecheck`
