# CHANGELOG_212

## Header 按 tok/s 排名 + Claude 流式估算实时化

### 概要

Header / 数据页的 token rate 从“今日输出总量选模型 + 60s 平均值”改为“当前 tok/s 选模型”。Claude 会话生成中通过 `stream_event` 文本增量估算 tok/s，turn 结束后回到 `token_usage` 精确窗口统计；Codex 仍按 `turn.completed` usage 走 60s poll。

### 变更内容

- 新增 `token-rate-tick` display-only 通道：`sdk-message-translate` 处理 Claude `stream_event(content_block_delta)`，`live-token-rate` 按 CJK/ASCII 字符估 token，节流后经 `eventBus -> IPC -> preload -> renderer` 推送。
- 打开 Claude `includePartialMessages`，让 SDK 生成中发 `stream_event`。
- `token_usage` 精确统计保持不变：估算值不入库、不进 `AgentEvent`；result / stream end 发 `done` tick 清掉 live 展示态。
- Header 和 DataPanel 共用 `renderer/lib/live-rate` 排名 helper：fresh live bucket 与 60s poll bucket 取并集，按当前 tok/s 排序。
- `useTokenRatesPoll` 订阅 live tick，并在 `token-usage-changed` 后 500ms debounce 拉取 rates/topToday 做 turn 末校准。
- 新增 `live-token-rate.test`，锁定 CJK/ASCII 估算、节流 emit 和 done tick 清理。
- 新增流程图 `ref/flows/token-rate-live-flow.puml`（该旧图集后续已退役），记录流式估算到 renderer 展示的数据流。

### Codex 说明

当前 Codex 翻译层只转发 `item.updated` 的工具执行类增量；普通 `agent_message/reasoning` 增量没有接入 UI 文本流，且准确 usage 只在 `turn.completed` 到达。本轮不把 Codex 普通文本增量纳入估算，避免引入去重/重组风险。

### 验证

- `pnpm typecheck`
- `pnpm exec vitest run src/main/adapters/claude-code/sdk-bridge/__tests__/live-token-rate.test.ts`
