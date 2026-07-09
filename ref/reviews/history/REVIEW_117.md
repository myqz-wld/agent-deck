# REVIEW_117 — hand_off_session 后原会话续聊消息不展示

- 触发：用户澄清问题不是 successor 详情页看不到 handoff prompt，而是 `hand_off_session` 后回到原会话继续聊，新发消息没有展示出来。
- 范围：MCP `hand_off_session` caller close 路径、`SessionManager` recentlyDeleted 黑名单、adapter recover path 的 SDK user message emit、SessionDetail Activity 的事件来源。
- 方法：现场确定性读码 + 定向 `SessionManager.ingest` 回归测试。窄范围生命周期 bug，未起异构对抗。
- 关联 changelog：[CHANGELOG_277.md](../../changelogs/history/CHANGELOG_277.md)。

## 结论

1. **MED ✅ `markRecentlyDeleted` 误吞用户显式续聊消息**
   - 证据：`hand_off_session` 成功 transfer 后对 caller 执行 `markClosed(callerSessionId)`，再执行 `markRecentlyDeleted(callerSessionId)`。用户立即回原会话发送消息时，recover path 会先 emit `source='sdk'`、`kind='message'`、`payload.role='user'`，但 `SessionManager.ingest()` 在 `isRecentlyDeleted(event.sessionId)` 处直接 return。
   - 风险：原会话虽然可以继续发到 adapter/recover path，但用户消息不落 `events`，ActivityFeed 看不到；黑名单未清时，后续 assistant/tool 事件也可能继续被 TTL 误吞。
   - 修复：recentlyDeleted 命中时，只有明确的 SDK user message 放行；放行前清掉 application sid 和 `cliSessionId` 的黑名单 key，然后走原有 `ensureRecord()` closed→active revive 和 persist pipeline。

2. **LOW ✅ 不能放开全部黑名单事件**
   - 证据：`markRecentlyDeleted` 的原始目的仍成立：handoff/close 后原 SDK turn 的 assistant、session-end、hook 尾包不应复活或推进 source session。
   - 修复：放行条件限定为 `source === 'sdk' && kind === 'message' && payload.role === 'user'`；assistant 尾包测试保持丢弃。

## 回归测试

- 扩展 `src/main/session/__tests__/manager-ingest.test.ts`：
  - handoff 后原会话处于 `closed + recentlyDeleted`，SDK user message 能复活并落库。
  - 清理黑名单后，后续 assistant event 从 `cliSessionId` 维度到达也会写回 application session id。
  - 没有用户续聊的迟到 assistant 尾包仍被 recentlyDeleted 丢弃。

## 验证

- `pnpm test src/main/session/__tests__/manager-ingest.test.ts` ✅ 21 passed。
- `pnpm typecheck` ✅。
