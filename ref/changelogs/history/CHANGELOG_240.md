# CHANGELOG_240: 业务日志打印补强

## 概要

补齐 main 端几处仍使用 `console.*` 的业务路径，统一迁到 `electron-log` scoped logger。
这次不改日志架构、日志文件位置、日志级别设置或 UI，仅提升现有日志落盘的一致性和排查上下文。

## 变更内容

- `issue-repo` 的 JSON 解析失败兜底改走 `log.scope('issue-repo').warn`，保留原始错误对象，避免只拼成字符串丢 stack / cause。
- `IssueLifecycleScheduler` 改用 `issue-gc` scope：
  - 单条 hardDelete 失败记录 `issueId` 和错误对象。
  - 批量硬删成功记录 `deletedCount`、resolved/soft-deleted 候选数、`limit`、`hitLimit`。
- `MessageLifecycleScheduler` 改用 `message-gc` scope：
  - scan 失败记录 retention / limit 上下文和错误对象。
  - purge 成功记录候选数、实际删除数、retention、limit、catch-up 命中状态。
- `IssuesResolveInNewSession` 增加 `ipc-issues` scope 诊断：
  - in-flight dedupe 复用。
  - 起解决会话前记录 adapter / cwd / sandbox / permissionMode / promptLength（不落 prompt 内容）。
  - spawn 成功、race 消失、link 成功各自记录 issueId / sid / status 上下文。
- `session-repo/types` 的 `parseStringArrayJson` 增加 `session-repo` scope 诊断：
  - `extra_allow_write` / `additional_directories` malformed JSON、非数组、混入非 string 项时记录 `sessionId`、字段名和条目计数。
  - `NULL` / 空字符串仍静默视为未设置，避免正常 unset 场景刷日志。
- `event-repo` 增加 `event-repo` scope 诊断：
  - tool-use dedup 合并旧 row 时，历史 `payload_json` 解析失败会记录 `eventId`、`sessionId`、kind、`toolUseId` 后按原先 null payload 兜底继续合并。
  - list 投影读到脏 `payload_json` 时先记录上下文，再保持原抛错语义。
  - `findLatestAssistantMessage` read-side parse catch 记录上下文后保持原 `null` 兜底。
- 对应单测从 `console.warn` spy 改为 scoped logger spy，并新增 session-repo/event-repo 日志回归用例，钉住业务源码不回退到裸 `console.*`。

## 验证

- `pnpm logger:check` 通过，`src/main` + `src/renderer` 业务源码 0 个 `console.log/warn/error/info/debug` 残留。
- `pnpm exec vitest run src/main/store/__tests__/message-lifecycle-scheduler.test.ts src/main/store/__tests__/issue-lifecycle-scheduler.test.ts src/main/ipc/__tests__/issues.test.ts src/main/store/__tests__/issue-repo.test.ts` 通过；普通 Node 下 `issue-repo` SQLite 真测按既有 ABI 守门 skip。
- `pnpm exec vitest run src/main/store/session-repo/__tests__/types.test.ts src/main/store/__tests__/v025-migration.test.ts src/main/store/__tests__/repo-tiebreaker.test.ts src/main/store/__tests__/event-repo-recent-messages.test.ts` 通过；普通 Node 下 SQLite 真测按既有 ABI 守门 skip。
- `pnpm typecheck` 通过。
- `pnpm build` 通过。
- `pnpm test` 通过：140 files / 1762 tests。
