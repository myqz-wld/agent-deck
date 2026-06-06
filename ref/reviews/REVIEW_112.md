# REVIEW_112 - universal-message dispatch + prompt assets deep-review

> 用户主动触发 deep review，聚焦 BUG 排查、代码优化和提示词资产优化。本轮按风险收敛到 universal-message dispatch / watcher 状态机、codex recover 相关边界、send_message 协议说明、reviewer prompt 资产和 PlantUML SSOT。

## scope

初始 mixed review scope（10 文件）：

```review-scope
resources/claude-config/CLAUDE.md
resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md
resources/claude-config/agent-deck-plugin/skills/deep-review/SKILL.md
resources/codex-config/CODEX_AGENTS.md
resources/codex-config/agent-deck-plugin/agents/reviewer-codex.md
resources/codex-config/agent-deck-plugin/skills/deep-review/SKILL.md
src/main/adapters/codex-cli/sdk-bridge/recoverer/recover-and-send-impl.ts
src/main/agent-deck-mcp/tools/handlers/send.ts
src/main/teams/universal-message-watcher/enqueue.ts
src/main/teams/universal-message-watcher/index.ts
```

Round 2 / Round 3 增量 scope：

```review-scope
ref/flows/universal-message-dispatch-flow.puml
ref/architecture/universal-message-status-state-machine.puml
resources/claude-config/CLAUDE.md
resources/codex-config/CODEX_AGENTS.md
src/main/adapters/types/agent-adapter.ts
src/main/teams/universal-message-watcher/index.ts
```

## 方法

- `agent-deck:deep-review` 三轮异构对抗：reviewer-claude（claude-code）`9821ab6b-6834-46d4-ab6f-a3a071c6c0b3` + reviewer-codex（codex-cli）`019e98ba-dfe6-7a71-a6c6-56792fb30cde`，teamId `b9395874-956a-44f8-be5c-c9edab7b6f4d`。
- lead 三态裁决：CRITICAL/HIGH 无；单方 MED 全部现场读码验证后采纳；LOW/INFO 顺手修正。
- 因 watcher dispatch 属核心流程，用户确认后同步维护 PlantUML flow / state-machine SSOT。

## R1 裁决

### ✅ MED - stop() 后 in-flight batch 继续投递

reviewer-codex 单方提出，lead 读码验证成立。`process()` 入口有 `running` guard，但 `stop()` 若发生在 `await this.deliver(...)` 期间，await 返回后旧代码仍会继续遍历后续 candidates、per-target rescue 和 fair candidate。`before-quit` 顺序是先 stop watcher 再 shutdown adapters，旧行为会和 adapter teardown 竞争。

修复：`src/main/teams/universal-message-watcher/index.ts` 在 4 个 awaited deliver 返回后都加 `if (!this.running) return`，覆盖主 candidate loop / per-target rescue / defensive fallback / fair-candidate dispatch。新增回归测试模拟第一条 deliver 阻塞期间 stop，解锁后不再 claim 第二条 message。

### ✅ MED - adapter 已接收后 markDelivered 失败会重投

reviewer-codex 单方提出，lead 读码验证成立。旧 `adapter.receiveTeammateMessage` 和 `markDelivered` 共用 catch；adapter resolve 后若 DB `markDelivered` 抛错，旧代码会 `retryAfterFail` 把同一消息退回 pending，下一轮重复注入 receiver SDK。

修复：`deliver()` 拆成两段错误处理。adapter submit 失败才 retry；adapter accepted 后 `markDelivered` 失败只 log，并尝试 `markFailed(...post-delivery...)` 终态，不再退回 pending。新增测试断言 `retryAfterFailCalls=0`、`markFailedCalls=1`。

### ✅ LOW - reviewer prompt 误称 teamId 来自 wire prefix

reviewer-codex 单方提出，lead grep 验证成立。`reviewer-codex.md` / `reviewer-claude.md` 原文把 `sessionId + teamId` 都说成来自 `[msg][sid]` prefix，但 prefix 不含 teamId。

修复：两端 reviewer prompt 改为 `replyToMessageId` 从 `[msg]` 提取、`sessionId` 从 `[sid]` 提取、`teamId` 从 lead context block 或 `list_sessions` 反查。

### ✅ LOW - wire invariant 把 senderSessionId 误称 v4 randomUUID

reviewer-claude 单方提出，lead 结合真实 sid/version 和测试验证成立。messageId 是 app 侧 `crypto.randomUUID()` v4；senderSessionId 是 SDK / CLI 分配的 session id，codex thread id 为 v7。旧文档和测试把 sender sid 收紧到 v4，后续维护者可能误把 regex 改成 version-specific。

修复：`CLAUDE.md` / `CODEX_AGENTS.md` 改成 messageId v4、senderSessionId SDK/CLI assigned（codex v7）。`wire-prefix-e2e.test.ts` 只对 messageId 断言 v4，对 senderSid 断言 lowercase hex + hyphen 36 chars。

### ✅ INFO - send_message 字段表缺 teamless DM 一句

reviewer-claude INFO。两端字段表 `teamId` 行补充：零 shared team 且省略则走 teamless DM。

## PlantUML 维护

用户确认本次 watcher dispatch 属核心流程后，保留并更新两份 PlantUML SSOT：

- `ref/flows/universal-message-dispatch-flow.puml`：补 stop-after-await 边界、post-submit markDelivered failure no-retry、teamless rate key、watcher 构造 wireBody、adapter receiver-first 3 参数调用、rescue/fair query 的真实顺序。
- `ref/architecture/universal-message-status-state-machine.puml`：补 post-submit markDelivered failure -> terminal failed，明确 adapter accepted 后不 retry。

同步更新 `ref/flows/INDEX.md` 与 `ref/architecture/INDEX.md` 关联本 REVIEW。

## R2 / R3 裁决

### ✅ LOW - dispatch flow 图把 wire prefix 归到 adapter，且 rescue/fair 仍在 candidate loop 内

reviewer-codex 与 reviewer-claude R2 独立命中同一问题。图与实现不一致：实现中 watcher 先 `buildWireBody(claimed)`，再调用 `receiveTeammateMessage(claimed.toSessionId, claimed.fromSessionId, wireBody)`；adapter 只投递 wireBody。实现中 per-target rescue / defensive fallback / fairCandidate 均在 candidate loop 之后。

修复：flow 图改为 watcher 自调用 `buildWireBody(claimed)`，adapter 调用 `receiveTeammateMessage(toSid, fromSid, wireBody)`，去掉 phantom `messageId/replyToMessageId` 参数；candidate loop 闭合后再画 rescue / fallback / fairCandidate。

### ✅ INFO - flow 图参数命名与行号引用

reviewer-claude R2 INFO：图中 `send_message` invoke 用 snake_case，实际 schema 是 camelCase；batch-full 旧行号引用偏移。修复：invoke 改 `sessionId/teamId/replyToMessageId`，删除偏移行号引用。

### ✅ INFO - prose 文档仍写 adapter 给消息加 wire prefix

reviewer-claude R2 INFO。`CLAUDE.md` / `CODEX_AGENTS.md` 同步改为：universal-message-watcher 构造含 wire prefix 的 wireBody，receiver adapter 把 wireBody 喂给 SDK。

### ✅ R3 收口

Round 3 窄范围回归（flow puml + CLAUDE/CODEX prose + watcher/adapter signature 对照）：

- reviewer-codex：0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW / 0 INFO，can close。
- reviewer-claude：0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW / 0 INFO，can close。

## 修复文件

- `src/main/teams/universal-message-watcher/index.ts`
- `src/main/teams/__tests__/universal-message-watcher.test.ts`
- `src/main/adapters/codex-cli/__tests__/wire-prefix-e2e.test.ts`
- `src/main/agent-deck-mcp/tools/handlers/lead-context-block.ts`
- `resources/claude-config/CLAUDE.md`
- `resources/codex-config/CODEX_AGENTS.md`
- `resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md`
- `resources/codex-config/agent-deck-plugin/agents/reviewer-codex.md`
- `ref/flows/universal-message-dispatch-flow.puml`
- `ref/architecture/universal-message-status-state-machine.puml`
- `ref/flows/INDEX.md`
- `ref/architecture/INDEX.md`

## 验证

```bash
plantuml --check-syntax --stop-on-error ref/flows/universal-message-dispatch-flow.puml ref/architecture/universal-message-status-state-machine.puml
pnpm exec vitest run src/main/teams/__tests__/universal-message-watcher.test.ts src/main/adapters/codex-cli/__tests__/wire-prefix-e2e.test.ts
pnpm typecheck
```

结果：

- PlantUML syntax check passed。
- 2 test files passed，36 tests passed。
- `pnpm typecheck` passed。

提示词资产自检：旧 `adapter 给消息加 wire prefix`、snake_case invoke、v4-specific sender sid 断言均已清掉；剩余 grep 命中为 meta-rule 文本或字段名 false positive。

## 收口

- 严重度分布：R1 `2 MED ✅ + 2 LOW ✅ + 1 INFO ✅`；R2 `1 LOW ✅ + 2 INFO ✅`；R3 `0`。
- 0 CRITICAL / 0 HIGH；所有 MED 均已修且有回归测试或语法验证。
- 关联 changelog：无（review 内直接落地）。
