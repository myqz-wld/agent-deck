# CHANGELOG_278

## hand_off_session 后原会话收尾输出继续展示

### 概要

调整 `hand_off_session` caller 关闭语义：handoff 成功后原会话仍标记为 closed，但不再加入 `recentlyDeleted` 尾包黑名单。这样原 turn 在 handoff tool 返回之后继续产生的 assistant / session-end / tool 事件会保留在 SessionDetail 中，用户可以审计完整收尾输出。

### 变更内容

- `handOffSessionHandler` 默认 caller close 从 `markClosed + markRecentlyDeleted + token release` 改为 `markClosed + token release`。
- 保留“不 abort active SDK turn”的行为，确保 MCP tool result 能返回给原会话模型。
- 依赖现有 `SessionManager.advanceState()` closed-session 防线：事件先落 `events` 并 emit 给 ActivityFeed，但 closed session 不更新 lifecycle / lastEventAt，也不会被 assistant/session-end 尾包复活。
- 普通 close / pending cancellation 路径的 `markRecentlyDeleted` 不变，仍挡住非 handoff 的迟到尾包。
- 新增回归测试覆盖：
  - `hand_off_session` 默认 close 不调用 `markRecentlyDeleted`。
  - closed 且未 recentlyDeleted 的原会话收到 assistant 尾包会落库展示，但 lifecycle 保持 closed。

### 验证

- `pnpm test src/main/agent-deck-mcp/__tests__/hand-off-session.handler.test.ts src/main/session/__tests__/manager-ingest.test.ts`
- `pnpm typecheck`
