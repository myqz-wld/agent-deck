# CHANGELOG_13: 综合优化批次（haiku 模型 + 12 条 + 10 条）

## 概要

合并原 CHANGELOG_15（间歇总结优先用 haiku 模型）+ CHANGELOG_33（综合优化 12 条）+ CHANGELOG_37（优化批次 10 条 + 历史会话超期清理）。三轮综合 cleanup / 优化批次共 23 条，覆盖鉴权、性能、可靠性、卫生、内存、IPC 协议收编。

## 变更内容

### 间歇总结优先用 haiku 模型（原 CHANGELOG_15）

- `summariseViaLlm` 之前没传 `model`，按 `~/.claude/settings.json` 的 `ANTHROPIC_MODEL`（往往 sonnet 4.5 / opus 4.7）跑。一段一句话总结调最贵的模型不划算
- `src/main/session/summarizer.ts`：`sdk.query({options})` 加 `model: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || process.env.ANTHROPIC_MODEL || 'haiku'`（三层优先级，用户在 settings.json 升级 haiku 版本时不用改代码）

### 综合优化 12 条（原 CHANGELOG_33）

P0 必修：

- **HookServer Bearer token 鉴权**：`AppSettings` 加 `hookServerToken: string|null`；`settings-store.ensure()` 首次启动用 `randomBytes(32).toString('hex')` 生成；`HookServer` 构造接 `(port, token)`，`/hook/*` 路由强制校验 `Authorization: Bearer <token>`，不匹配回 401；`hook-installer` `buildCommand()` 在 curl 命令中嵌入 `-H 'Authorization: Bearer ${token}'`；`writeSettings()` 改 **temp+rename 原子写**避免崩溃留半个 JSON 把用户 hooks/permissions/mcpServers 弄丢
- **Summarizer LLM oneshot 加超时**：`AppSettings` 加 `summaryTimeoutMs`（默认 60s，0=不超时）；`summariseViaLlm` 用 `Promise.race(consumeLoop, timer)`：优先 `q.interrupt()` 优雅清子进程，兜底 throw `__summarizer_timeout__` 让外层 catch 走降级；修底层 cli.js 卡死时整个 Summarizer 不再产新总结的"自杀链路"

P1：

- **`summaryIntervalMs` 即改即生效**：summarizer 新增 `currentIntervalMs` + `setIntervalMs(ms)` 方法（clearInterval + setInterval 重启）；`SettingsSet` handler 接入分发
- **ingest 写放大修复**：`manager.ts ingest()` 把 `record.lastEventAt !== event.ts` 从 if 判定中拿掉（这条几乎必然成立导致 else 分支几乎是死代码）；真状态变化（activity / lifecycle）→ 走重 upsert + 广播 session-upserted；仅 lastEventAt 推进 → 走轻量 `setActivity` 单列 UPDATE，**不广播**
- **ingest/ensure 不再写 `archivedAt: null`**：归档与 lifecycle 严格正交，不能因为后续事件流就自动 unarchive
- **`use-event-bridge.ts onSessionUpserted` 加 `isNew = !sessions.has(s.id)` 判断**：仅"之前没见过的会话"才拉一次 `latestSummaries`，避免每条事件都触发 IPC + SQL 窗口函数
- **bypassPermissions 切换 confirm**：`SessionDetail.tsx changeMode` 当 `next === 'bypassPermissions'` 时弹 confirm 警告（运行时切换可能被 SDK 静默忽略）
- **sdk-bridge 队列上限**：`MAX_MESSAGE_BYTES = 100_000` + `MAX_PENDING_MESSAGES = 20`；超出 throw

P2：

- **`applyClaudeSettingsEnv` 加 env 白名单**：前缀 `ANTHROPIC_*` / `CLAUDE_*` + 完全匹配 `HTTP_PROXY/HTTPS_PROXY/NO_PROXY/ALL_PROXY`；防 settings.json 夹带 `NODE_OPTIONS=--inspect=...` / `NODE_TLS_REJECT_UNAUTHORIZED=0` / `PATH=/tmp/evil:...` / `ELECTRON_RUN_AS_NODE=1` 这些会污染 SDK 子进程信任链的危险键
- **HistoryPanel 关键词搜索 debounce + 短关键词只搜 title**：`KEYWORD_DEBOUNCE_MS = 300`；后端长度 ≥ 3 才走 events / summaries 全表 LIKE %kw% 子查询

P3：

- **死代码清理**：删 `PermissionRequests`（~100 行 banner）/ `AskUserQuestionPanel`（~40 行）/ `AskQuestionForm + QuestionRow`（~120 行）/ `toolInputToDiff` 重复定义（~40 行）/ `diff-collector.ts`（无人调用）/ `RouteHelpers` interface

### 优化批次 10 条（原 CHANGELOG_37）

按对抗式 code review 三态裁决一次清扫：

- **renderer / store**：`removeSession` 加清 `recentEventsBySession` / `summariesBySession` / `latestSummaryBySession` 三张 by-session Map（之前永远成孤儿）
- **CLI 与 IPC 入口对齐**：`SessionManagerClass` 加 `recordCreatedPermissionMode(sid, mode)` helper；`cli.ts applyCliInvocation` 调用 helper（之前漏写 → CLI 路径起的会话 UI 显示 default 但 SDK 实际是 plan）；`ipc.ts AdapterCreateSession` 也改用同一 helper
- **HookServer 鉴权时序攻击面**：Bearer 比较从 `auth !== expected` 改为 `crypto.timingSafeEqual(authBuf, expectedBuf)`，先做长度短路绕开 `timingSafeEqual` 在长度不等时 throw
- **session-repo upsert 列表加 `permission_mode`**：之前 spread `{...existing, lifecycle:'active'}` 调 upsert 时 permissionMode 被静默丢弃；历史搜索 `id IN (SELECT ...)` 改为 `EXISTS (SELECT 1 ... LIMIT 1)`
- **lifecycle scheduler 重写 `scan()`**：active→dormant、dormant→closed 改用 `sessionRepo.batchSetLifecycle` 单事务，避免每会话 3 次 SQL + 1 次广播；不再依赖 `sessionManager.markDormant/markClosed`
- **历史会话超期自动清理**（新功能）：`AppSettings.historyRetentionDays`（默认 30，0=禁用）；scheduler 第三步调 `findHistoryOlderThan` + `batchDelete` 清理超期历史（CASCADE 自动清子表），每轮最多 500 条
- **IPC 协议收编**：`SessionListHistory` 不再走裸字符串；preload 加 `listSessionHistory(filters)` 强类型 facade
- **SDK 动态加载**：新增 `sdk-loader.ts` 单例 `sdkPromise`；`sdk-bridge.ts` 与 `summarizer.ts` 删各自 `dynamicImport` / `loadSdk` 副本
- **Summarizer 内存清理**：`start()` 在事件总线挂 `session-removed` listener，删会话时同步 `lastSummarizedAt.delete(sid)`
- **settings-store token 长度阈值** `< 32` → `< 64`（与 `randomBytes(32).toString('hex')` 真实生成长度 64 字符 = 256-bit 对齐）
- **header pending 计数补 ExitPlanMode**：`App.tsx pending` useMemo 漏了 `pendingExitPlanModesBySession`；加 select + useMemo 多一个循环
- **设置面板暴露 `historyRetentionDays`**：「生命周期」section 加 NumberInput

## 备注

- 已知取舍：`startInvalidateLoop` 5fps invalidate（CHANGELOG_11 取舍） / `preload electronIpc.invoke` 任意 channel 兜底通道 / HistoryPanel 真正的 FTS5 索引（debounce 已解 80%） / `hookServerPort` 改完真正即时生效（需 restart server + reinstall hook 联动）—— 均未改
- HookServer 鉴权验证：`curl -X POST http://127.0.0.1:47821/hook/sessionstart -d '{...}'` 返回 401；带正确 Bearer 才走业务路径
