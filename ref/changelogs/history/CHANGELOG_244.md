# CHANGELOG_244

## 项目级 review 修复：spawn 孤儿会话 / codex turn 中断挂起 / 迟到 turn/completed 关错队列 / event 坏行毒化批量读取

## 概要

一轮项目级代码 review（main 主进程核心路径）发现 4 个潜在缺陷，本次全部修复。均为低概率但有真实用户后果的边角问题：误导性报错引发重复 spawn、中断链路在 RPC 失败时永久挂起、新 turn 事件被上一 turn 尾包静默吞掉、单行脏数据让会话活动流永久打不开。

## 变更内容

- **spawn_session：`setSpawnLink` 失败不再泄漏孤儿会话**（`agent-deck-mcp/tools/handlers/spawn.ts`）。修前 `setSpawnLink`（DB 写）与 `createSession` 共用一个 try，createSession 成功后 setSpawnLink 抛错（SQLITE_BUSY 等）会走外层 catch 返回「createSession failed; no session created」—— 但 SDK 子进程已起且未关闭，caller 被误导重试产生重复会话。修后单独 try/catch 降级（spawnedBy 留 NULL 仅 warn，与 recordCreatedPermissionMode REVIEW_85 MED-B 同款），仍在 finally release 前完成（保 MED-1 fan-out race 顺序保证）。
- **codex app-server：turn 中断不再依赖 interrupt RPC 成功**（`adapters/codex-cli/app-server/client.ts`）。修前 `turn/start` 响应后 abort 仅触发 `turn/interrupt` RPC + reject 一个已无人 await 的 race promise；RPC 失败时服务端不再发 terminal 通知 → `for await (queue)` 永久挂起。修后 interrupt 失败时主动 `queue.throw` 让 generator 抛出，thread-loop 按 `signal.aborted` 走 `finished:interrupted`。同时 `Thread.interrupt` 加 `isProcessAlive` guard：进程已死时静默返回（handleExit synthetic error 已终结队列），不再经 `ensureProcess` 为一条无意义 interrupt 重新拉起全新 app-server 进程。
- **codex app-server：上一 turn 迟到的 `turn/completed` 不再提前关闭新 turn 队列**（同文件）。修前 `activeTurnId` 未知时（turn/start 响应与 turn/started 通知都未到）任何 completed 都判 terminal → interrupt 后快速发下一条消息时，旧 turn 尾包会 close 新 turn 队列，新 turn 在服务端继续跑但 UI 一条事件都看不到。修后按 stdout FIFO 时序判别：本 turn 的 completed 不可能先于自己的 started 到达，未见 `turn/started` 的 completed 视为上一 turn 尾包不关队列（`isTerminalForTurn` 加 `turnStartSeen` 参数）。`error` 通知 terminal 语义不变（进程退出兜底保留）。
- **event-repo：单行 payload 损坏不再毒化整批查询**（`store/event-repo.ts`）。修前 `rowToEvent` 对 JSON.parse 失败 re-throw，`rows.map` 批量转换让一行坏数据使 `listForSession` / `findTeamEvents` / `listRecentMessages` / `listForSessionRange` 整个抛错 → 该会话活动流永久打不开。修后 skip + warn（与同文件 `parsePayloadJson` merge 路径降级策略对齐）。另外 `listRecentMessages` / `findLatestAssistantMessage` / `hasToolUseStartWithFilePath` 的 `json_extract` 对 malformed JSON 是 SQL 级 runtime error（同根因第二层），加 `CASE WHEN json_valid(...)` 守卫（CASE 保证条件求值序；裸 `json_valid AND json_extract` 的 AND 项 SQLite 不保证求值序）。
- 测试：`event-repo-recent-messages.test.ts` 新增 2 条坏行隔离回归（listForSession / listRecentMessages 各一）；`v025-migration.test.ts` 原「保持原抛错语义」断言更新为新「skip + warn + 正常行保留」语义。

## 验证

- `pnpm test`（Electron-as-node，SQLite 真测全跑）：141 文件 / 1787 测试全过
- `pnpm typecheck`
