# CHANGELOG_273

## Claude tok/s 权威 turn 末校准

### 概要

Claude 生成中 tok/s 继续使用 partial `content_block_delta` 文本估算，以保持 Header 实时跳动；turn 结束时新增一次权威校准：用最终 `result.modelUsage` / `usage.output_tokens` 的 output token 总数除以累计 decode delta 时间窗口。

### 变更内容

- Claude live 状态新增 decode 窗口累计：每段 assistant stream 记录首个/最后一个 `content_block_delta`，多段 tool turn 在 `message_start` 时累计上一段，排除中间工具等待空档。
- 实时估算首个 flush anchor 改为首个文本 delta，避免把 TTFT 算进生成速度分母。
- result 分支从“直接 done tick 清理”改为：正常 result 先用权威 output tokens 发一次校准 tick；拿不到有效窗口或主动关闭时仍发 done tick 清理展示态。
- 补充 `live-token-rate.test` 覆盖 TTFT 排除、turn 末权威校准、多段 assistant 输出累计 decode 窗口。

### 验证

- `pnpm exec vitest run src/main/adapters/claude-code/sdk-bridge/__tests__/live-token-rate.test.ts src/main/adapters/codex-cli/sdk-bridge/__tests__/live-token-rate.test.ts`
