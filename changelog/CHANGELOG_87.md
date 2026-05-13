# CHANGELOG_87: J bug fix（lead detail 重复显示 reply）+ check_reply mcp tool

**plan**: mcp-bug-and-feature-batch-20260513 Phase 1（H1 Step 1.1-1.7）

## 概要

修一条 production bug J + 加一个 mcp tool B，两者协同：

1. **J fix**：`universal-message-watcher.deliver` 对 reply message 短路跳过 `adapter.receiveTeammateMessage`，防 lead SessionDetail 重复显示同份 reply（一条来自 wait_reply tool_result、一条来自 SDK echo user message）+ 防 lead Claude 把 reply 当 user input 跑空 agent loop。
2. **B check_reply tool**：wait_reply 的非阻塞配对版（lead 等期间能继续处理其他 user input）；与 J fix 协同 — reply 不再 inject 给 sender SDK 后，sender 通过 wait_reply（阻塞等）/ check_reply（poll 模式）两种姿势从 messages 表主动拿 reply。

2 atomic commit + 47 tests 全过（3 watcher + 44 tools，含 3 个新 check_reply test）。typecheck 双端通过。

## 变更内容

### J fix（commit 1）：`universal-message-watcher.deliver` 加 reply 短路分支

**铁证根因**（plan mode 内 grep + read 锁定）：

`adapter.receiveTeammateMessage` 接口契约 = `adapter.sendMessage(wireBody)`（4 个 adapter codex/claude/generic-pty/aider 全部 delegate），sendMessage at `claude-code/sdk-bridge/index.ts:324-335` emit `'message'` kind `role: 'user'` event 把消息当 user input echo 到 SessionDetail。

**完整重复链**（reply 路径）：
1. lead `send_message` → enqueue → `wait_reply(message_id=X)` 阻塞等
2. watcher tick → `adapter.receiveTeammateMessage(teammate, lead, wireBody)` = teammate.sendMessage → teammate SDK echo user message → teammate detail 显示
3. teammate 处理 → `reply_message(reply_to_message_id=X, text=...)` → enqueue
4. lead wait_reply listener 拿 reply → resolve → mcp tool_result return → **lead detail 显示 tool_result（含 replyText）**
5. watcher tick → `adapter.receiveTeammateMessage(lead, teammate, replyWireBody)` = lead.sendMessage → **lead SDK echo user message → lead detail 显示「user message: [from teammate][msg X]\nreplyText」**

→ 步骤 4 + 5 同份 reply 在 lead detail 显示两次；且步骤 5 把 reply 当 user input inject 给 lead SDK，lead Claude 可能 act on reply 跑空 agent loop。

**修法**：`universal-message-watcher.deliver` 在 `claimed.replyToMessageId != null` 时短路 — 只 `markDelivered + emitStatus`，跳过 `adapter.receiveTeammateMessage`。reply 完全不再 inject 给 sender SDK；sender 通过 `wait_reply` / `check_reply` 主动从 messages 表拿。短路位置在 `claim` 之后立即（target / adapter check 之前），因为 reply 行为不依赖 target session / adapter 状态：reply markDelivered 仅推进 status 状态机，sender 拿 reply 走 messages 表查询，adapter 不存在 / canCollaborate=false 也不影响。

**风险点**：lead 没主动 wait/check 时 reply 不在 SessionDetail 可见。**缓解**：(a) 已有 `TeamDetail/MessagesSection` 展示 messages 表所有 reply；(b) Phase 5 (A HIGH 10) 将 SessionDetail 加 "Cross-session messages" tab 兜底。

### B check_reply mcp tool（commit 2）：wait_reply 的非阻塞配对版

**形态**（决策 §决策 2 方案 A — 独立 tool）：
- tool 名: `mcp__agent_deck__check_reply`
- schema: `{ message_id: string, caller_session_id?: string }`（与 wait_reply 同款，但**无** nudge / timeout）
- handler: 同步 `findRepliesByMessageId + isLegitReply` filter，立即返回 `{ reply: { messageId, text, sentAt, fromSessionId } | null, timedOut: false }`（`timedOut` 字段保留与 wait_reply 同 shape 让 caller 用同一套消费代码）
- `EXTERNAL_CALLER_ALLOWED.check_reply = true`（read-only，与 wait_reply 一致）
- `readOnlyHint: true`（不像 wait_reply 可能 enqueue nudge）

**helper 抽出**（wait.ts 与 check.ts 共用）：把原 wait.ts 内 inline 定义的 `isLegitReply` + `replyProj` 两个 closure 抽到 `tools/helpers.ts` module-level export：
- `isLegitReply(reply, original)` — REVIEW_32 HIGH-3 方向校验（reply.fromSessionId === original.toSessionId && reply.toSessionId === original.fromSessionId），排除 nudge 自循环
- `replyProj(msg) → { messageId, text, sentAt, fromSessionId }` — 投影 caller 关心的字段，不泄漏 status/attemptCount/teamId 内部 schema

wait.ts 改用 helper（删 inline），check.ts 直接用，保证两 tool reply 方向校验 + 投影格式 100% 一致。

### 文件变更清单

**main 端**：
- `src/main/teams/universal-message-watcher.ts` — `deliver` 加 reply 短路分支 + 长 jsdoc 写明根因 / 修法 / 不依赖 target / adapter 的理由
- `src/main/agent-deck-mcp/types.ts` — `AGENT_DECK_TOOL_NAMES.checkReply: 'check_reply'` + `EXTERNAL_CALLER_ALLOWED.check_reply: true`
- `src/main/agent-deck-mcp/tools/schemas.ts` — `CHECK_REPLY_SCHEMA` + `CheckReplyArgs` z.infer 类型
- `src/main/agent-deck-mcp/tools/helpers.ts` — export `isLegitReply` / `replyProj` module-level（从 wait.ts 抽出）
- `src/main/agent-deck-mcp/tools/handlers/check.ts`（新）— `checkReplyHandler` 实现
- `src/main/agent-deck-mcp/tools/handlers/wait.ts` — 改用 helper（删 inline isLegitReply / replyProj，2 callsite 改写）+ jsdoc 顶部记 abstraction history
- `src/main/agent-deck-mcp/tools/index.ts` — 注册第 8 个 tool `checkReply`（readOnlyHint: true）

**测试**：
- `src/main/teams/__tests__/universal-message-watcher.test.ts`（新文件）— 3 it：reply 短路 / non-reply 走原 dispatch 回归 / reply 即使 target 已删也 markDelivered（J fix 副作用边界）
- `src/main/agent-deck-mcp/__tests__/tools.test.ts` — 加 3 it for check_reply：命中已有 reply / 未命中返回 null + 验证 < 100ms 立即返回 / unknown msg_id 拒绝

## 验证

- `pnpm typecheck` 双端通过
- `pnpm test src/main/teams/__tests__/universal-message-watcher.test.ts src/main/agent-deck-mcp/__tests__/tools.test.ts` — **47 tests 全过**（3 watcher + 44 tools）
- dev smoke 留 Phase 6 H6 收口完整冒烟（J fix 是行为变更，必须 smoke）
