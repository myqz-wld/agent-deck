# REVIEW_118 — hand_off_session 后原会话收尾输出也要展示

- 触发：用户确认 `hand_off_session` 后原会话并不一定马上结束，原 turn 后续消息也需要展示。
- 范围：`hand_off_session` caller close 语义、`recentlyDeleted` 尾包黑名单、closed session ingest/advanceState 行为。
- 方法：现场确定性读码 + 定向 handler / ingest 回归测试。窄范围生命周期语义调整，未起异构对抗。
- 关联 changelog：[CHANGELOG_278.md](../../changelogs/history/CHANGELOG_278.md)。

## 结论

1. **MED ✅ handoff caller 不应使用 recentlyDeleted 黑名单**
   - 证据：`advanceState()` 对 closed session 已经是“先落 events，再短路 lifecycle 更新”，因此 handoff 后原 turn 的 assistant/session-end/tool 事件可以被展示，又不会复活 caller。
   - 风险：继续调用 `markRecentlyDeleted` 会把用户希望审计的 handoff 后收尾输出吞掉。
   - 修复：`handOffSessionHandler` 默认 caller close 删除 `markRecentlyDeleted`，保留 `markClosed` 和 `mcpSessionTokenMap.release`。

2. **LOW ✅ 普通 close 尾包防线仍需保留**
   - 证据：`pending-cancellation` / close path 仍依赖 `markRecentlyDeleted` 丢弃迟到尾包，避免用户刚关掉的 session 被旧事件干扰。
   - 修复边界：只移除 handoff handler 的这一次调用；`SessionManager` 中 SDK user message 清黑名单的续聊防线保留，非 user 尾包仍会被普通 close 黑名单丢弃。

## 回归测试

- `src/main/agent-deck-mcp/__tests__/hand-off-session.handler.test.ts`
  - 默认 caller close 调 `markClosed` 和 token release。
  - 不调用 `markRecentlyDeleted`。
- `src/main/session/__tests__/manager-ingest.test.ts`
  - closed 原会话未被 recentlyDeleted 时，assistant 尾包落入 events。
  - lifecycle 保持 closed，lastEventAt 不推进。

## 验证

- `pnpm test src/main/agent-deck-mcp/__tests__/hand-off-session.handler.test.ts src/main/session/__tests__/manager-ingest.test.ts` ✅。
- `pnpm typecheck` ✅。
