# CHANGELOG_33: 综合优化（Hook 鉴权 / Summarizer 超时 / 写放大 / env 白名单 / 死代码清理 等 12 条）

## 概要

针对项目代码扫描后做的综合优化批次，覆盖安全 / 性能 / 可靠性 / 卫生四类共 12 条。
分级按 P0（必修） → P3（卫生）落地：

- **P0**：HookServer 增加 Bearer token 鉴权（修本机进程伪造事件污染 SQLite 的高危漏洞）；Summarizer LLM oneshot 加超时（修单卡死永久占用 inFlight 把整个 Summarizer 锁死的自杀链路）
- **P1**：SettingsSet handler 补 summaryIntervalMs 即改即生效；ingest 写放大 + useEventBridge 联动 IPC 风暴；bypassPermissions 运行时切换弹 confirm 提示重建会话
- **P2**：applyClaudeSettingsEnv 加 env 白名单（防 NODE_OPTIONS/PATH/ELECTRON_RUN_AS_NODE 等危险键污染信任链）；HistoryPanel keyword 加 debounce + 后端短关键词只搜 title；sdk-bridge sendMessage 加字节 / 队列上限
- **P3**：死代码清理（PermissionRequests / AskUserQuestionPanel / AskQuestionForm / QuestionRow / toolInputToDiff 重复定义 / diffCollector / RouteHelpers）；ingest / ensure 不再自动重置 archivedAt（与 CLAUDE.md「正交」约定对齐）；HookInstaller writeSettings 改成 temp+rename 原子写

## 变更内容

### 鉴权与安全

#### `src/shared/types.ts`
- `AppSettings` 加 `hookServerToken: string | null`（HookServer Bearer 鉴权）
- `AppSettings` 加 `summaryTimeoutMs: number`（默认 60s，0=不超时）
- `DEFAULT_SETTINGS` 同步：`hookServerToken: null` + `summaryTimeoutMs: 60_000`

#### `src/main/store/settings-store.ts`
- `ensure()` 在首次启动检测 `hookServerToken`，null/空串/长度不足 → `randomBytes(32).toString('hex')` 生成并 `set` 持久化
- token 一旦生成保持稳定（避免已注入的 hook 命令因 token 变动失效）

#### `src/main/hook-server/server.ts`
- `HookServer` 构造接 `(port, token)`，新增 `bearerToken` getter
- 注册 `app.addHook('onRequest')`：`/hook/*` 路由强制校验 `Authorization: Bearer <token>`，不匹配回 401
- token 异常空时仅 warn 放行（防止 token 系统出错把整个 hook 链路停摆）

#### `src/main/adapters/claude-code/hook-installer.ts`
- 构造接 `(port, token)`；`buildCommand()` 在 curl 命令中嵌入 `-H 'Authorization: Bearer ${token}'`
- `writeSettings()` 改成 **temp+rename 原子写**：先 `writeFileSync(p+'.tmp.<pid>')` 再 `renameSync` —— 避免崩溃 / 断电 / 磁盘满留半个 JSON 把用户多年累积的 hooks/permissions/mcpServers/env 配置弄丢

#### `src/main/adapters/claude-code/index.ts`
- `init()` 从 `ctx.hookServer.bearerToken` 取 token 传给 `new HookInstaller(port, token)`

#### `src/main/index.ts`
- `new HookServer(port, token)` 启动时把持久化 token 传入
- 注释说明：token 在 settings-store ensure() 阶段已确保非空

#### `src/main/adapters/claude-code/settings-env.ts`
- 引入白名单：前缀 `ANTHROPIC_*` / `CLAUDE_*` + 完全匹配 `HTTP_PROXY / HTTPS_PROXY / NO_PROXY / ALL_PROXY`（大小写两份）
- 不在白名单内的键统一拒绝并打 warn（含 key 名），仅放鉴权 / 模型 / 代理三类
- 防止 settings.json 被夹带 `NODE_OPTIONS=--inspect=...` / `NODE_TLS_REJECT_UNAUTHORIZED=0` / `PATH=/tmp/evil:...` / `ELECTRON_RUN_AS_NODE=1` 这些会污染整条 SDK 子进程信任链的危险键

### Summarizer 超时与即改即生效

#### `src/main/session/summarizer.ts`
- 新增 `currentIntervalMs` 字段 + `setIntervalMs(ms)` 方法：clearInterval + setInterval 重启周期，让设置面板修改 `summaryIntervalMs` 即改即生效（之前必须重启应用才生效，违反 CLAUDE.md「即改即生效中转点」约定）
- `summariseViaLlm` 内用 `Promise.race(consumeLoop, timer)` 实现 `summaryTimeoutMs` 超时：
  - 优先 `q.interrupt()` 优雅清 cli.js 子进程
  - 兜底 throw `__summarizer_timeout__` 让外层 catch 走最近一条 assistant / 事件统计降级
  - 超时后 consumeLoop 仍在后台 reject，提前挂 `.catch(() => undefined)` 防 unhandled rejection
- 修底层 cli.js 卡在等 result（代理超时 / 鉴权死锁 / API 限流）时整个 Summarizer 不再产新总结的"自杀链路"

### IPC 写放大与渲染层

#### `src/main/session/manager.ts`
- `ingest()` 把 `record.lastEventAt !== event.ts` 从 if 判定中拿掉（这条几乎必然成立，导致 else 分支几乎是死代码）：
  - 真状态变化（activity / lifecycle 变了）→ 走重 upsert + 广播 session-upserted
  - 仅 lastEventAt 推进 → 走轻量 `setActivity` 单列 UPDATE，**不广播**
  - renderer 通过 agent-event 事件已知有新动作，session-upserted 不再被高频会话刷爆
- `ensure()` + `ingest()` **不再写 `archivedAt: null`**：归档与 lifecycle 严格正交，不能因为后续事件流就自动 unarchive。修用户主动归档 active 会话后下一秒被 hook 事件默默放回实时面板的 bug

#### `src/renderer/hooks/use-event-bridge.ts`
- `onSessionUpserted` 加 `isNew = !sessions.has(s.id)` 判断：仅"之前没见过的会话"才拉一次 `latestSummaries`，避免每条事件都触发一次 IPC + SQL 窗口函数查询
- 新 summary 已通过 `onSummaryAdded` 事件直接推进 `latestSummaryBySession`，不依赖这条 fetch

### 设置即改即生效

#### `src/main/ipc.ts`
- `SettingsSet` handler 在原 4 类（activeWindowMs / closeAfterMs / startOnLogin / alwaysOnTop / permissionTimeoutMs）基础上补：
  - `summaryIntervalMs` → 调 `summarizer.setIntervalMs(ms)`
  - `hookServerPort` → 仅打 warn 提示需重启（监听端口在 server 已 listen 后无法热切换 + 已写到 settings.json 的 hook curl 命令端口也对不上，UI 已用「重启生效」标注）

### bypassPermissions 切换 confirm

#### `src/renderer/components/SessionDetail.tsx`
- `changeMode` 新增分支：当 `next === 'bypassPermissions' && permissionMode !== 'bypassPermissions'` 时弹 `confirmDialog` 警告
- 文案说明：`allowDangerouslySkipPermissions` flag 只在 createSession 时按初始 permissionMode 决定一次，运行时切换可能被 SDK 静默忽略；建议新建会话时直接选

### sdk-bridge 队列上限

#### `src/main/adapters/claude-code/sdk-bridge.ts`
- 顶部新增 `MAX_MESSAGE_BYTES = 100_000` + `MAX_PENDING_MESSAGES = 20`
- `sendMessage` 入口先校验：
  - 单条字节 `Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES` → throw（精简或拆分）
  - 队列长度 `pendingUserMessages.length >= MAX_PENDING_MESSAGES` → throw（先处理 pending）
- 防止 SDK 阻塞在 canUseTool 期间用户连发无限累积 SDKUserMessage 对象 + N 条 message 事件落库 + 一次性 flush 撞 token 计费

### HistoryPanel 关键词搜索

#### `src/main/store/session-repo.ts`
- `listHistory` 的 `opts.keyword` 分支：长度 ≥ 3 才走 events / summaries 全表 LIKE %kw% 子查询；< 3 字符只搜 title

#### `src/renderer/components/HistoryPanel.tsx`
- 引入 `keywordInput` state 与 `filters.keyword` 解耦
- 新增 `KEYWORD_DEBOUNCE_MS = 300` + 桥接 useEffect：用户停止输入 300ms 后才提交查询
- 搜索框 value/onChange 改用 `keywordInput`，原 `filters.keyword` 由 debounce 桥接更新

### 死代码清理

#### `src/renderer/components/SessionDetail.tsx`
- 删 `PermissionRequests`（~100 行 banner 组件，全工程无引用）
- 删 `AskUserQuestionPanel`（~40 行 banner 组件，无引用）
- 删 `AskQuestionForm` + `QuestionRow`（~120 行，无引用 —— 注释里说"仍由 AskRow 复用"是过期信息）
- 删本文件的 `toolInputToDiff`（~40 行，ActivityFeed.tsx:919 已有同名实现且唯一被使用）
- import 同步清掉 `AskUserQuestionItem` / `AskUserQuestionRequest` / `PermissionRequest`（不再被引用）

#### `src/main/session/diff-collector.ts`（已删除）
- `diffCollector` 是 `fileChangeRepo.listForSession / countForSession` 的 1:1 重导出，全工程无人调用 → 整个文件删除

#### `src/main/adapters/types.ts`
- 删 `RouteHelpers` interface（仅自身定义，无任何 import / implements）+ 顶部 `RouteOptions` import 顺带删除

## 关键场景验证

- **HookServer 鉴权**：本机 `curl -X POST http://127.0.0.1:47821/hook/sessionstart -d '{...}'` 返回 401；带正确 `Authorization: Bearer <token>` 才走业务路径
- **Summarizer 超时**：模拟 cli.js 卡死（断网拉 LLM）→ 60s 后 inFlight 槽自动释放，下一会话能继续被总结，整个 Summarizer 不会停摆
- **summaryIntervalMs 即改即生效**：设置面板把 5min 改成 2min → 不重启应用，`[summarizer] interval updated to ...ms` 立刻打印
- **ingest 写放大**：单会话 5 秒内 100 条 tool-use-end → renderer 收到 `session-upserted` 数从 100 降到 1（仅 lifecycle 真变化的那条）
- **archivedAt 不自动重置**：active 会话点归档 → 收到下一条 hook 事件 → 仍然归档，不出现在实时面板
- **bypassPermissions confirm**：default → bypassPermissions 弹 confirm 警告"该模式在已运行的会话上不一定生效"
- **env 白名单**：在 ~/.claude/settings.json env 写 `NODE_OPTIONS: "--inspect=0.0.0.0:9229"` → 启动日志 `[settings-env] reject "NODE_OPTIONS": not in whitelist`
- **HistoryPanel debounce**：连续敲 5 个字符 → 仅触发 1 次 SQL 查询（最后一次输入后 300ms）
- **sendMessage 上限**：sendMessage 100KB+ 文本或在 pending 期间连发 21 条 → IPC handler 抛错，UI 显示红条
- **writeSettings 原子化**：mock 写入中途 kill 进程 → ~/.claude/settings.json 仍是上一版完整 JSON，未被截断

## 没动的地方（已知取舍 / 后续）

- **#13 startInvalidateLoop 5fps invalidate**：CHANGELOG_24 明确取舍（修 macOS pin 残影）；未改
- **#14 preload electronIpc.invoke 任意 channel**：CLAUDE.md 自家约定的"动态 channel 兜底通道"，目前主要用于 `'session:list-history'`；未改
- **HistoryPanel 真正的 FTS5 索引**：debounce + 短关键词限制已经把 80% 痛点解决，FTS5 + trigram tokenizer 牵涉 schema 迁移和中文支持验证，留 P3 后续
- **hookServerPort 改完真正即时生效**：需要 restart server + 重新 install hook 命令两步联动，目前只 warn 提示需重启 + reinstall；UI 已写「（重启生效）」
