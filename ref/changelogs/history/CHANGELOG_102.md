# CHANGELOG_102

## 概要

REVIEW_35 deep-review-and-refactor-20260514 plan 落地：12 文件热点综合 3 轮异构对抗（4 batch × 3 文件，8 reviewer 并发）共挖 49+ finding，3 commit 落地 36 真问题修复（9 HIGH + 20 MED + 7 LOW），不引入新功能纯改 bug + 加 capability + 测试改进。详见 [reviews/REVIEW_35.md](../../reviews/history/REVIEW_35.md)。

## 关联 commit

- `cd1af8c` Wave 1 fix (15 真问题：Batch A team-backend + Batch B session-subsystem)
- `d2c9e68` Wave 2 fix (12 真问题：Batch C adapter/pty + Batch D renderer/未审热点)
- `4a85f68` R2 fix (9 真问题：5 个新 HIGH 含 2 fix-to-fix 衍生 race + 4 关键 MED)

## 变更内容

### Universal team backend 修复
- backpressure 死锁修复（`universal-message-watcher.ts:413` `inflight - 1 > maxInflight` + starvation guard 强制 deliver candidates[0]）
- dispatcher cache 漏 runtime created team 修复（首先加 `agent-deck-team-created` listener，R2 又发现单 listener fix 半解 → 改 dispatcher `team-updated` handler 防御方案：「未见 team 但已 archived」当 archive transition fan-out）
- `resolveFromDisplayName` 改用 PK lookup（新增 `findActiveMembershipIn` helper，避免每条 dispatch 全表扫）
- `spawn/cli/ipc.adapters` 三处补 emit `agent-deck-team-member-changed` 让 dispatcher 收到 member-joined
- `listActiveMembers` JOIN sessions.archived_at 与其他 helper 一致
- `member-crud` 缓存 `countActiveLeads` 避免 throw 路径 2x SQL
- `backoffMs()` 加 SSOT 警告 docstring（JS / SQL 双侧）

### Session 子系统修复
- summarizer codex-cli 路径加 `Promise.race` timeout 防 codex 卡死占死 inFlight 槽
- summarizer LLM 错误诊断在 fallback 成功时不被吞（`set/delete` 收口在 summarize 内部）
- summarizer 加 `session-renamed` listener 迁移 `lastSummarizedAt` + `lastErrorBySession`
- **R2 衍生 race 修复**：summarizer in-flight `.then() / .catch()` 加 `sessionRepo.get` 预检防 rename 后 FK constraint failed + orphan diagnostics
- summarizer 删 `if (timedOut) throw` 死代码 + 删 `let timedOut` 变量
- 删 `preload electronIpc` raw 通道 + 删 `src/renderer/lib/ipc.ts`（0 消费方）
- preload `listFileChanges/getSettings/setSettings` 改强类型 `FileChangeRecord` / `AppSettings`
- 删 `session-store.view` + `setView` 死代码（与 App.tsx 真实 View 类型不符）
- `setLatestSummaries` 加 ts 比较守门防启动窗口 stale 覆盖

### Adapter / PTY / 安全护栏修复
- `IdleDetector` 加 `disposed` flag 防 dispose 后 onData 仍能注册新 timer
- `READ_ONLY_TOOLS` 加 `TaskOutput` + 删 `LS`（SDK 0.2.118 已删）
- `can-use-tool` 优先读 `toolUseID` 兼容老 `tool_use_id`（SDK 类型 typo 修法）
- **R2 衍生 fix**：`makeCtx({ toolUseID })` 测试 typo 修法（修前测试与生产分道扬镳）
- **R2 新发现**：`ctx.signal.aborted` 同步预检（3 处 abort listener）防 already-aborted signal `addEventListener('abort')` 不触发 entry 挂到 timeout

### Renderer + 资源管理修复
- `useImageAttachments` add 30MB 总额度 race 修复（rG-claude Node sim 实测 47MB → 把 limit check + `fullBase64Ref.set` 都移到 `setAttachments` updater 内防 React 18 batching 闭包陷阱）
- `useImageAttachments` `makeThumbnail` 加白底（`globalCompositeOperation: 'destination-over'` + fillRect）防 png 透明区缩略图变黑底
- `useImageAttachments` 成功 add 清旧错误（仅 `errors.length === 0` 时 `setError(null)`）
- `AdapterCapabilities.canAcceptAttachments` 新 capability + ComposerSdk gate 入口（textarea paste/drop/dragover + 文件按钮 + send 拦截）
- **R2 codex H1**：IPC layer 加 last-line defense（sendMessage / createSession 两个 IPC handler 在 `persistAttachments` 之前 reject 不支持 attachments 的 adapter）防 NewSessionDialog / 测试 / 直接 IPC 绕过 ComposerSdk gate
- ComposerSdk `supportsPermissionMode` 改 `agentId === 'claude-code'`（修前 `!== 'codex-cli'` 错误归 generic-pty/aider 进有权限模式 adapter）
- ComposerSdk 加 `busyRef` 同步锁防超快连点（< 16ms）双 send race
- `main/index.ts` `requestSingleInstanceLock` 失败后所有 listener 移到 `if (gotLock) { ... }` 分支防第二实例脏初始化
- `main/index.ts` `second-instance` handler 等 `bootstrappedPromise` 完成防 cold-start race
- `main/index.ts` `before-quit` cleanup 加 race-with-timeout 10s + `process.exit(1)` 强退（**R2 修法**：`closeDb` 移到 race **外** 总是跑保证 SQLite WAL checkpoint）
- **R2 codex H2**：`bootstrappedPromise.catch` 加 `dialog.showErrorBox` + `app.exit(1)` 让用户看到 fatal error + 释放单实例锁

## 测试与构建

- typecheck: 0 errors
- vitest: 467 passed + 59 skipped (better-sqlite3 binding ABI mismatch SOP 跳过) / 0 failed

## Follow-up

详 [reviews/REVIEW_35.md §Follow-up plan 候选](../../reviews/history/REVIEW_35.md#follow-up-plan-候选) — 18 MED + 25+ LOW/INFO follow-up 覆盖：starvation guard 公平排队架构改动 / pty listener 时序 / chokidar 复用 / 多个文件超 500 LOC 拆分（`universal-message-watcher.ts` 539 / `summarizer.ts` 613 / `preload/index.ts` 524 / `ComposerSdk.tsx` 512）/ main bootstrap 230 行 setupX 抽象 / 整批 fix 缺 stateful regression test / 多条优化 / cosmetic。
