# CHANGELOG_277

## hand_off_session 后原会话续聊消息恢复显示

### 概要

修复 `hand_off_session` 后回到原会话继续发送消息时，用户新消息没有显示在 SessionDetail 的问题。

根因是 `hand_off_session` 为了避免原 SDK turn 的迟到尾包复活 source session，会在 `markClosed(callerSessionId)` 后调用 `markRecentlyDeleted(callerSessionId)`。用户马上回原会话续聊时，recover path 发出的 `source='sdk'` / `kind='message'` / `role='user'` 事件也命中这条 60 秒黑名单，在 `SessionManager.ingest()` 入口被丢弃，导致用户消息和后续恢复事件都不显示。

### 变更内容

- `SessionManager.ingest()` 的 recentlyDeleted 黑名单新增窄放行：只有明确的 SDK user message 可以打穿黑名单。
- 放行时同步清理 application session id 和 `cliSessionId` 两个黑名单 key，确保同一轮恢复里的 assistant/tool 后续事件不再被 60 秒 TTL 误吞。
- assistant / session-end / hook 等非用户显式续聊事件仍按原逻辑被 recentlyDeleted 丢弃，继续挡住 handoff/close 后的迟到尾包。
- 新增回归测试覆盖：
  - handoff 后 source session 立即续聊，SDK user message 复活 closed 原会话并落入 events。
  - 清黑名单后，后续 assistant event 即使从 `cliSessionId` 维度到达也会显示到原 session。
  - 没有用户续聊的迟到 assistant 尾包仍被丢弃，不复活原会话。

### 验证

- `pnpm test src/main/session/__tests__/manager-ingest.test.ts`
- `pnpm typecheck`
