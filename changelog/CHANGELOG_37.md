# CHANGELOG_37: 优化批次（10 条）+ 历史会话超期自动清理

## 概要

按对抗式 code review 三态裁决清单的优先级，一次清扫多个高 / 中优先级问题：renderer 内存泄漏、CLI 与 IPC 入口语义飘移、HookServer 鉴权时序攻击面、SQL 子查询全表扫、Lifecycle scheduler N+1 SQL、SessionRecord 与 upsert 字段集错位、IPC 协议碎片化、SDK loader 重复实现、Summarizer 单调增长 Map、Bearer token 长度阈值与生成长度脱节。

新增「历史会话超过 N 天自动清理」（默认 30 天，0 = 禁用），由 LifecycleScheduler 在每轮扫描末尾批量删除（CASCADE 一并清子表）。

所有改动通过 `pnpm typecheck`。

## 变更内容

### renderer / store（src/renderer/stores/session-store.ts）
- `removeSession` 加清 `recentEventsBySession` / `summariesBySession` / `latestSummaryBySession` 三张 by-session Map，否则删会话后这三张 Map 的 key 永远成孤儿（`renameSession` 已枚举全表 7 张 Map，remove 路径必须对齐）

### CLI 与 IPC 入口对齐（src/main/session/manager.ts、src/main/cli.ts、src/main/ipc.ts）
- `SessionManagerClass` 加 `recordCreatedPermissionMode(sid, mode)` helper：把「createSession 后持久化用户选过的 permissionMode」抽成单一真值
- `cli.ts applyCliInvocation` 调用 helper（之前漏写 → CLI 路径起的会话 UI 显示 default 但 SDK 实际是 plan）
- `ipc.ts AdapterCreateSession` 也改用同一 helper，删掉重复逻辑

### HookServer 鉴权（src/main/hook-server/server.ts）
- Bearer 比较从 `auth !== expected` 改为 `crypto.timingSafeEqual(authBuf, expectedBuf)`，先做长度短路绕开 `timingSafeEqual` 在长度不等时 throw 的限制
- 预分配 `expectedAuthBuf`（构造时一次）省每请求一次 `Buffer.from`

### session-repo（src/main/store/session-repo.ts）
- `upsert` 的 INSERT/UPDATE 列表加上 `permission_mode`，与 `SessionRecord.permissionMode` 字段对齐 —— 之前 spread `{...existing, lifecycle:'active'}` 调 upsert 时 permissionMode 被静默丢弃
- 历史搜索的 `id IN (SELECT ...)` 子查询改为 `EXISTS (SELECT 1 ... LIMIT 1)`，匹配第一条就短路，不再物化整个子查询集合（不上 FTS5 前的最低成本优化）
- 新增 `batchSetLifecycle(ids, lifecycle, ts)`：单事务多次 run prepared statement + WHERE lifecycle != 目标态，返回真正变化的行（让 scheduler 一次推进一批，不再 N+1）
- 新增 `findHistoryOlderThan(threshold, limit=500)` / `batchDelete(ids)`：历史超期清理基础 SQL（CASCADE 自动清 events / file_changes / summaries）

### Lifecycle scheduler（src/main/session/lifecycle-scheduler.ts）
- 重写 `scan()`：active→dormant、dormant→closed 都改用 `sessionRepo.batchSetLifecycle` 单事务，事务内拿到真正变化的行后批量 emit `session-upserted`，避免每会话「get → set → get → emit」共 3 次 SQL + 1 次广播
- 不再依赖 `sessionManager.markDormant/markClosed`，eventBus emit 直接做（去掉中间一层 SQL）
- 加第三步：`historyRetentionDays > 0` 时调 `findHistoryOlderThan` + `batchDelete` 清理超期历史，每轮最多 500 条避免一次扫描卡死主线程

### settings 字段（src/shared/types.ts）
- `AppSettings` 加 `historyRetentionDays: number`（默认 30；0 = 不清理）
- `index.ts` bootstrap 时把该值传给 `LifecycleScheduler`
- `ipc.ts SettingsSet` 把 `historyRetentionDays` 接入即改即生效分发

### IPC 协议收编（src/shared/ipc-channels.ts、src/preload/index.ts、src/main/ipc.ts、src/renderer/components/HistoryPanel.tsx）
- `IpcInvoke` 加 `SessionListHistory`，`session:list-history` 不再走裸字符串
- `preload/index.ts` 加 `listSessionHistory(filters)` 强类型 facade
- `HistoryPanel` 删除 `ipcInvokeRaw('session:list-history', ...)`，改用 `window.api.listSessionHistory(filters)`，channel 名只剩一处真值

### SDK 动态加载（src/main/adapters/claude-code/sdk-loader.ts、sdk-bridge.ts、src/main/session/summarizer.ts）
- 新增 `sdk-loader.ts`：`loadSdk()` + `SdkModule` 类型，单例 `sdkPromise`
- `sdk-bridge.ts` 与 `summarizer.ts` 删除各自的 `dynamicImport` / `loadSdk` 副本，改为 `import { loadSdk } from '@main/adapters/claude-code/sdk-loader'`，避免两份 promise 状态分裂

### Summarizer 内存清理（src/main/session/summarizer.ts）
- `start()` 在事件总线挂 `session-removed` listener，删会话时同步 `lastSummarizedAt.delete(sid)`，否则这张 Map 单调增长（结合新增的历史超期清理后会更明显）
- `stop()` 同步解绑 listener，避免应用退出后残留监听

### settings-store（src/main/store/settings-store.ts）
- token 长度阈值 `< 32` 改为 `< 64`，与 `randomBytes(32).toString('hex')` 真实生成长度（64 字符 = 256-bit）对齐 —— 之前 32-63 字符的弱 token（半截 token）也能蒙混过关

### header pending 计数补 ExitPlanMode（src/renderer/App.tsx、README.md）
- App.tsx 的 pending useMemo 只 select 了 `pendingPermissionsBySession` + `pendingAskQuestionsBySession`，漏了 `pendingExitPlanModesBySession`；store / 状态机 / ActivityFeed 内嵌 ExitPlanRow / cancelled toast 这几路都已正确处理 ExitPlanMode，只有 header 「⚠ N 待处理」chip **不计入也不能跳转**到含 ExitPlan 待处理的会话
- 加 `pendingExitsMap` select + useMemo 多一个循环 + deps 同步加，三类 pending 一视同仁
- README「工具权限请求」节文案补「权限/提问/计划批准」对齐
- 不动 SessionCard / SessionDetail / Toast：那几路本来就正确（SessionCard 走 `activity='waiting'`、ActivityFeed 直接 select `pendingExitPlanModesBySession`、`exit-plan-cancelled` 已被 toast 识别）

### 设置面板暴露历史保留天数（src/renderer/components/SettingsDialog.tsx）
- 「生命周期」section 加 NumberInput「历史会话保留（天，0 = 永久保留）」绑 `historyRetentionDays`
- 之前只有改 settings.json 才能调，现在 UI 直接改且即改即生效（`ipc.ts SettingsSet` 已分发到 LifecycleScheduler）
