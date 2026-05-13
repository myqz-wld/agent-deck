# CHANGELOG_81

## 拆 tools.ts 1060 → 11 文件 + 顺手修 2 条 REVIEW_32 follow-up MED bug（plan deep-review-and-split-20260513 Phase 2 Step 2.1）

## 概要

`src/main/agent-deck-mcp/tools.ts` 长期是 mcp-server 最大文件（H1 fix 后已涨到 1060 行，超 CLAUDE.md
「单文件 ≤ 500 行护栏」逾倍）。本次按 plan §步骤 checklist Phase 2 Step 2.1 拆为 `tools/` 目录
11 文件，每个 ≤ 500 行；同时按 plan §下一会话第一步「就近修」原则顺手修 2 条 REVIEW_32 §Follow-up
MED bug（fan-out race / send teamId 跨污染）。剩 1 条 MED（placeholder enqueue 失败）真修需要
`agentDeckMessageRepo.insert` 加 `initialStatus` 字段 + `updateToSessionId` helper（store 层 API
演化），scope 较大保留下次评审。typecheck 双端通过。

## 变更内容

### 拆分（src/main/agent-deck-mcp/tools.ts → src/main/agent-deck-mcp/tools/）

- `tools/index.ts` (139 行) — facade `buildAgentDeckTools` + `BuildAgentDeckToolsDeps` interface +
  helpers re-export（`makeCallerContext` / `denyExternalIfNotAllowed` / `_internalOk` / `_internalErr`
  老 export 名向后兼容）。SDK `tool()` 包装 7 个 handler，每个 handler 只接 `(args, ctx)` 两参数，
  上下文从 closure 注入避免下沉一堆 deps。
- `tools/schemas.ts` (236 行) — 7 个 zod schema（SPAWN/SEND/WAIT/REPLY/LIST/GET/SHUTDOWN）+ 各自
  `z.infer` 推断的 args type（`SpawnSessionArgs` / `SendMessageArgs` / ...）。三 transport
  共享同一份 schema。
- `tools/helpers.ts` (154 行) — `makeCallerContext` / `denyExternalIfNotAllowed` /
  `validateExternalCaller` / `ok` / `err` / `projectSession` + 新增 `HandlerContext` /
  `HandlerResult` type。仅依赖 sessionRepo / SessionRecord / EXTERNAL_CALLER_* 常量，不依赖
  zod schema 和 SDK runtime，任何 handler 安全 import。
- `tools/handlers/spawn.ts` (281 行，含详细注释) — spawnSessionHandler。
- `tools/handlers/send.ts` (126 行) — sendMessageHandler。
- `tools/handlers/reply.ts` (85 行) — replyMessageHandler。
- `tools/handlers/wait.ts` (154 行) — waitReplyHandler（含 nudge timer）。
- `tools/handlers/list.ts` (70 行) — listSessionsHandler。
- `tools/handlers/get.ts` (39 行) — getSessionHandler。
- `tools/handlers/shutdown.ts` (54 行) — shutdownSessionHandler。

外部 caller import 路径不变 —— `transport-stdio.ts` / `transport-http.ts` / `server.ts` /
`__tests__/tools.test.ts` 仍用 `from './tools'`，TS module resolution 自动 resolve 到
`tools/index.ts`，零 caller 修改。

### 顺手修 MED-1 (fan-out race) — `tools/handlers/spawn.ts:128-156`

**REVIEW_32 §Follow-up MED-claude(fan-out race)**：旧 spawn 在 `try { sid = await adapter.createSession(...) }
catch { release; return err } finally { fanOutSlot.release() }` 之后才单独跑 `sessionRepo.setSpawnLink(sid, ...)`。
两步之间（finally 跑完 release → setSpawnLink 还没跑）存在 race window：parallel `spawn_session`
调用进 `applySpawnGuards` 时 `inFlightChildren=0`（本调用已 release）+ `listChildren=oldCount`
（新 sid 未 setSpawnLink 还没在 children 列表里）→ effective parallel 比真实少 1，能突破
`maxFanOut + 1`。

**修法**：把 `setSpawnLink` 提到 try 块内 createSession 之后、finally release 之前。同步执行
不会抛错（sessionRepo 操作 SQLite），所以 try 闭合 race window 安全。`fanOutSlot.release()` 仍
走 finally 兜底 idempotent 二次 release。

### 顺手修 MED-3 (send teamId 跨污染) — `tools/handlers/send.ts:84-105`

**REVIEW_32 §Follow-up MED-codex(send reply teamId 跨污染)**：旧 `send_message` 允许手填
`reply_to_message_id` 但只校验 caller/target 共享 team + `args.team_id ⊆ sharedTeams`，**不**反查
`original.teamId` 与 resolved teamId 一致性。错误或恶意 caller 可在 cross-team 投递时把 team A 的
`reply_to_message_id` 挂到 team B 的 reply chain → wait_reply 走 `findRepliesByMessageId` 反查会
拿到错 team 的 reply，污染对话链 + 跨 team 信息泄漏。

**修法**：teamId resolve 完成后，若 `args.reply_to_message_id` 给定 → `agentDeckMessageRepo.get`
反查 original，校验 `original.teamId === teamId` 否则返回 err `cross-team reply not allowed`。
不存在的 reply_to_message_id 同样返回 err（额外捕获 caller 拼错 id 的场景）。

## 测试

- `pnpm typecheck` 双端（node + web）通过
- 不跑 vitest（按 CLAUDE.md「跑 vitest SQLite 真测前后必须保护 better-sqlite3 binding」教训，
  避免污染 binding ABI；H5 完整 smoke 时跑 dev 端到端验证）

## 关联

- plan `~/.claude/plans/piped-fluttering-moth.md` Phase 2 Step 2.1
- REVIEW_32 §Follow-up MED-1 / MED-3（5 MED 中 2 条收口；剩余 3 条：MED-2 placeholder enqueue 失败 /
  MED-D7 ghost / MED-首次 archive 吞 留 H3 拆 scheduler / watcher 时就近修）

## H1 增量提示

H1 commit `80a19d1` 已修：bug 修 + REVIEW_32 R1 9 条 fix。本次拆 tools.ts 行数从 plan 写的 968
涨到 1060（H1 增量）。Phase 2 后续 Step 2.2/2.3 拆 team-repo / session-repo 时同样要先 `wc -l`
重核（H1 manager.ts 加了 ~80 行也会影响 H4 拆分粒度）。
