# CHANGELOG_217 — Codex tok/s 完成态校准

## 变更类型
Bug fix

## 背景
用户反馈 Codex 侧 tok/s 无法正常展示。现场用 `@openai/codex-sdk` 0.135.0 采样普通回答事件流，实际序列为：

```text
thread.started
turn.started
item.completed(agent_message)
turn.completed(usage)
```

没有 `item.updated(agent_message/reasoning)`。`CHANGELOG_216` 的 Codex 实时估算依赖这个事件，因此当前 SDK 下等不到输入源。

## 修复
- `src/main/adapters/codex-cli/sdk-bridge/live-token-rate.ts`
  - `turn.started` 记录 turn 起点。
  - `item.completed(agent_message/reasoning)` 也走累积文本差值估算，兼容当前 SDK 只发 completed 的普通回答。
  - `turn.completed` 用权威 usage 的 `output_tokens + reasoning_output_tokens` 除以 turn 耗时发完成态校准 tick，并让 renderer 通过 freshness 自然回落到既有 60s `token_usage` 窗口。
  - `turn.failed` / 中断仍发 `done:true` 清理 live 展示态。
- `src/shared/types/token-usage.ts` / `src/main/event-bus.ts` 注释从 Claude-only / 生成中-only 改为通用 tok/s tick。
- `src/renderer/components/HeaderTokenRates.tsx` tooltip 文案改为“实时估算”，避免把 Codex 完成态校准误标为“生成中估算”。

## 验证
- `pnpm exec vitest run src/main/adapters/codex-cli/sdk-bridge/__tests__/live-token-rate.test.ts`
- `pnpm typecheck`
