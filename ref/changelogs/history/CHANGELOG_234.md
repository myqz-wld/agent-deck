# CHANGELOG_234: hand_off_session failure cleanup and diagnostics

## 概要

修复 `hand_off_session` 在 successor 已 spawn、但 mandatory resource transfer 失败时留下活跃半成功会话的问题，并补齐 handoff 主路径诊断日志。

## 变更内容

- `hand_off_session` 资源转移失败时现在会尝试关闭刚 spawn 出来的 successor session，caller 仍保持 active 且不会被 close。
- 失败返回的 MCP error payload 新增 `successorSessionId`、`successorClosed`、`resourceTransfer`，调用方可直接看到清理是否成功和 transfer 失败细节。
- `mcp-handoff-main` 新增主路径日志：入口、cwd 缺失、spawn 失败、spawn 成功、资源转移失败、失败清理、资源转移成功、caller close 失败。日志只记录 session id、adapter、cwd、prompt 长度和 transfer 状态，不记录完整 prompt。
- 补 handoff handler 单测覆盖 transfer 失败清理成功与清理失败两条路径。

## 验证

- `pnpm exec vitest run src/main/agent-deck-mcp/__tests__/hand-off-session.handler.test.ts src/main/agent-deck-mcp/__tests__/hand-off-session.resource-transfer.test.ts`
- `pnpm typecheck`
