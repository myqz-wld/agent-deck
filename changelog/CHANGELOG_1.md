# CHANGELOG_1: 项目初始化（M1–M9 + 后续迭代）

## 概要

从零搭建 agent-deck（通用 Coding Agent 驾驶舱），一次性完成 9 个里程碑 + 多轮 UI / 体验迭代。基于 Electron + React 19 + TypeScript + Vite + Tailwind CSS 4 + better-sqlite3。

由于这是项目第一条 changelog，把首批所有改动整合在一起；后续单独的功能 / bug 修复请新建 `CHANGELOG_2.md` 等。

## 变更内容

### 项目骨架与构建（根目录）
- `package.json`：electron 33 / electron-vite 2 / vite 5 / react 19 / typescript 5 / tailwindcss 4
- `electron.vite.config.ts`：main / preload / renderer 三段构建 + path alias `@shared` `@main` `@renderer`
- `tsconfig.{json,node,web}.json`：双 project references，main/preload 用 node tsconfig，renderer 用 web tsconfig
- `postcss.config.mjs`：Tailwind 4 PostCSS plugin
- 启动脚本：`pnpm dev` / `pnpm typecheck` / `pnpm build` / `pnpm dist`（dist 走 electron-builder mac dmg）

### 共享层（src/shared/）
- `types.ts`：
  - `AgentEventKind`（8 种）+ `AgentEvent<P>`（含 `source: 'sdk' | 'hook'` 用于去重）
  - `SessionRecord`：`source`/`lifecycle`/`activity`/`startedAt`/`lastEventAt`/`endedAt`/`archivedAt`
  - `LifecycleState = 'active' | 'dormant' | 'closed'`，归档由 `archivedAt` 单独管，与 lifecycle 正交
  - `PermissionRequest` / `PermissionResponse`（SDK canUseTool 用）
  - `FileChangeRecord` / `DiffPayload<T>` / `SummaryRecord`
  - `AppSettings` + `DEFAULT_SETTINGS`（含 `summaryMaxConcurrent` 全局并发上限等）
- `ipc-channels.ts`：所有 IPC channel 常量集中（含 `SessionLatestSummaries` 批量拿最新总结、`AdapterRespondPermission` / `AdapterSetPermissionMode` 等）

### 主进程入口与窗口（src/main/）
- `index.ts`：bootstrap 顺序 = DB → settings → HookServer → adapters → SessionManager wiring → HookServer.start → scheduler+summarizer → setLoginItemSettings(dev 跳过) → IPC → window → eventBus → ensureFocusableOnActivate → 注册 `Cmd+Alt+P` 全局快捷键。before-quit 清理顺序：unregister shortcut → scheduler.stop → summarizer.stop → adapter.shutdownAll → hookServer.stop
- `window.ts`：FloatingWindow 单例。默认 520×680（之前 380×600 偏小），右上角偏内出现；`transparent + frame: false + alwaysOnTop: 'floating' + vibrancy: 'under-window' + visibleOnAllWorkspaces`；ready-to-show + did-finish-load + 1.5 s 兜底三路保证 show；compact 折叠到 64 px 高度
- `event-bus.ts`：TypedEventBus 包装 NodeEventEmitter，事件类型固定为 4 种（agent-event / session-upserted / session-removed / summary-added）

### IPC 与 preload
- `main/ipc.ts`：所有 invoke handler 集中。`SettingsSet` 是即改即生效中转点：
  - `activeWindowMs` / `closeAfterMs` → `getLifecycleScheduler()?.updateThresholds(...)`
  - `startOnLogin` → `app.setLoginItemSettings(...)`（dev 跳过）
  - `alwaysOnTop` → `getFloatingWindow().setAlwaysOnTop(...)`
- `preload/index.ts`：强类型 `window.api` facade + 动态 channel 兜底 `window.electronIpc.invoke()`

### Hook 通道（src/main/hook-server/ + adapters/claude-code/）
- `hook-server/server.ts` + `route-registry.ts`：共享 fastify 实例，adapter 通过 RouteRegistry 申请挂路由
- `claude-code/hook-routes.ts`：6 条路由（sessionstart / pretooluse / posttooluse / notification / stop / sessionend）。`taggedEmit` 统一给 emit 出门的事件打 `source: 'hook'`
- `claude-code/translate.ts`：payload → AgentEvent。PostToolUse 的 Edit/Write/MultiEdit 翻译时同时 emit `tool-use-end` + `file-changed`（含 before/after，喂给 DiffCollector）
- `claude-code/hook-installer.ts`：写入 / 卸载 `~/.claude/settings.json`，每条命令带 `# agent-deck-hook` 标记便于识别和清理；`status()` 报告已安装的 hook 名

### SDK 通道（src/main/adapters/claude-code/sdk-bridge.ts）
- 用 `new Function('s','return import(s)')` 绕开 Vite 静态分析加载 ESM-only 的 `@anthropic-ai/claude-agent-sdk`
- `createSession`：等第一条带 `session_id` 的 SDKMessage 拿到真实 id 再返回，5 s 兜底；拿到后立即 `sessionManager.claimAsSdk()` 注册到去重集合
- `query()` options 设 `settingSources: ['user', 'project', 'local']`，复用本地 hooks / MCP / agents / permissions
- 鉴权完全交给 SDK：不读不写 ANTHROPIC_API_KEY，让 SDK 自己 fallback 到 `~/.claude/.credentials.json`
- `canUseTool` callback：每次工具调用 → emit `waiting-for-user` (payload = PermissionRequest) → 把 resolver 存入 `pendingPermissions` Map 等用户决定
- `respondPermission(sessionId, requestId, response)`：UI 决定后调用，resolve `PermissionResult`
- `setPermissionMode(sessionId, mode)`：运行时切换权限模式
- `interrupt(sessionId)`：调 `query.interrupt()`
- `consume()` finally：拒掉所有未决 permission（避免上游永远挂）→ emit `session-end` → `releaseSdkClaim`

### 适配器抽象
- `adapters/types.ts`：`AgentAdapter` / `AdapterContext` / `AdapterCapabilities` / `PermissionMode`
- `adapters/registry.ts`：`AdapterRegistry` 单例，`initAll(ctx)` 时把 emit 接进 `SessionManager.ingest`
- `claude-code/index.ts`：完整实现，capabilities 全 true
- `codex-cli/`、`aider/`、`generic-pty/`：占位骨架，capabilities 全 false（UI 自动过滤），源文件注释里写实现指引

### 会话状态机（src/main/session/）
- `manager.ts`：
  - `sdkOwned: Set<string>` 去重；`ingest()` 入口检查 `event.source === 'hook' && sdkOwned.has(...)` → 丢弃
  - `ensure()` 创建新记录时根据 `event.source` 推导 `record.source`（'sdk' / 'cli'）
  - 收到任意事件让 closed/archived 会话复活回 active；`session-end` → closed
  - `markDormant` / `markClosed` 由 LifecycleScheduler 调用
  - `archive` / `unarchive`（取消归档保留原 lifecycle）/ `reactivate` / `delete`
- `lifecycle-scheduler.ts`：每分钟扫描，按 `activeWindowMs` / `closeAfterMs` 阈值推进；归档不参与衰减；暴露 `setLifecycleScheduler` / `getLifecycleScheduler` 单例 hook 给 IPC 层热更新阈值
- `summarizer.ts`：调度 + 三层降级
  - 触发条件：`!inFlight` && `eventsSince > 0` && (时间到 || 数量到) && 全局并发未超 `summaryMaxConcurrent`
  - 优先：SDK oneshot query (`settingSources: []` 避免 hook 回环 + `permissionMode: 'plan'` 禁工具调用)
  - 失败：取最近一条 assistant 文字（截 100 字）
  - 再失败：事件 kind 统计兜底
  - inFlight Set 防同会话并发；MAX_CONCURRENT 防全局打爆
- `diff-collector.ts`：薄封装

### 持久化（src/main/store/）
- `db.ts`：better-sqlite3 + 手写迁移系统
  - V1：sessions / events / file_changes / summaries / app_meta
  - V2：sessions 加 `source` 列
  - V3：sessions 的 `lifecycle='archived'` 行迁移成 `closed` + 补 `archived_at`，从此 archived 与 lifecycle 正交
- `session-repo.ts`：`upsert` / `get` / `listActiveAndDormant`（排除 archived）/ `listHistory`（含 archivedOnly + 全文模糊关键字）/ `setLifecycle` / `setArchived` / `setActivity` / `delete` / `findActiveExpiring` / `findDormantExpiring`
- `event-repo.ts` / `file-change-repo.ts` / `summary-repo.ts`
- `summary-repo.ts` 的 `latestForSessions(ids[])`：用 SQL 窗口函数一次拿 N 个会话各自最新一条总结
- `settings-store.ts`：electron-store v8（CJS 兼容）；启动时执行 `REMOVED_KEYS` 清理（如 `anthropicApiKey` 旧字段）

### 通知系统（src/main/notify/）
- `sound.ts`：跨平台播放（macOS afplay / Linux paplay+aplay / Windows powershell SoundPlayer），失败回退系统提示音
- `visual.ts`：根据 `enableSound` + `silentWhenFocused` + `enableSystemNotification` 决定播放 / 弹 Notification / Dock bounce / 窗口 flash

### 渲染端（src/renderer/）
- `main.tsx`：React 挂载 + ErrorBoundary（render error 全屏显示）+ window error/unhandledrejection 兜底（写到 root，方便诊断）+ resource error / cross-origin script error 单独处理避免遮 UI
- `index.html`：CSP 含 `'unsafe-eval'`（Vite HMR 必须）+ 加载前 fallback 文字（确认 React 是否挂载）
- `App.tsx`：header 一行布局（标题+统计 / ＋按钮 / 实时-历史 tab / pin / 折叠 / ⚙）+ main 区域（SessionDetail / SessionList / HistoryPanel）+ 两个 dialog
- `components/FloatingFrame.tsx`：纯毛玻璃容器，按 pinned 切样式
- `components/SessionList.tsx`：active / dormant 分段展示
- `components/SessionCard.tsx`：状态徽标 + title + 来源徽标（内/外）+ agentId + 实时活动行（白文，从 recent events 抠）+ 总结行（灰文，最新 LLM 总结 / 缺失时回退 cwd）+ 右键菜单
- `components/SessionDetail.tsx`：头部 + 权限请求面板（SDK 会话能允许/始终允许/拒绝；CLI 会话只展示）+ 3 Tab + 底部输入区（SDK = 输入框 + Cmd/Ctrl+Enter 发送 + 中断；CLI = 灰条提示）
- `components/HistoryPanel.tsx`：搜索 / 仅归档筛选 / 归档|取消归档|删除
- `components/NewSessionDialog.tsx`：＋ 按钮的弹窗（agent / cwd + 选择目录 / 首条消息 / 模型 / 权限模式 / system prompt）
- `components/SettingsDialog.tsx`：用 `DEFAULT_SETTINGS` 兜底（避免 main 旧 schema 缺字段时空白）；含 Hook 安装/卸载 / 提醒开关 / 生命周期阈值 / 间歇总结（含并发上限）/ 窗口（开机自启）/ HookServer 端口
- `components/StatusBadge.tsx`：activity/lifecycle/archived 联合判断，颜色与脉冲动画
- `components/ActivityFeed.tsx` / `SummaryView.tsx`：Tab 内的列表
- `components/diff/`：DiffViewer 入口 → DiffRegistry 单例 → 内置 TextDiffRenderer (Monaco lazy)、ImageDiffRenderer / PdfDiffRenderer 占位；`install.ts` 启动时注册
- `stores/session-store.ts` (Zustand)：sessions / recentEvents / summaries / latestSummary / pendingPermissions Maps；`pushEvent` 检测 `waiting-for-user + permission-request` payload 自动加入 pending；`pushSummary` 同步更新 latest
- `hooks/use-event-bridge.ts`：onSessionUpserted / onAgentEvent / onSummaryAdded 桥接到 store；初始化时 + 新 session 出现时拉 `latestSummaries` 写入 store
- `lib/ipc.ts`：动态 channel 兜底 invoker
- `styles/globals.css`：Tailwind 4 + Acrylic frosted-frame（背景径向+线性渐变 + `backdrop-filter: blur(36px) saturate(260%) brightness(1.12) contrast(1.05)` + 多向 inset shadow + SVG turbulence 噪点 mix-blend overlay + pin 模式更通透样式）+ `.frosted-frame > *:not(.absolute):not(.fixed)` 抬到噪点之上但不破坏 dialog overlay

### 资源与配置文件
- `resources/sounds/`：waiting.mp3 / done.mp3（缺失时回退到 macOS 系统提示音）
- `resources/icons/`：4 个 adapter 图标占位
- `.gitignore`：node_modules / out / release / dist / .DS_Store / *.log / .vite

### 文档
- `README.md`：所有功能总览 + 项目结构 + 开发流程
- `CLAUDE.md`：本仓库的 Claude 工作约定（中文 / 不主动建 md / 改动后判断更新 README / changelog 机制 / 项目特定设计要点速查 / 验证流程）
- `changelog/INDEX.md` + `changelog/CHANGELOG_1.md`（本文件）

### 依赖
- 运行时：`@anthropic-ai/claude-agent-sdk` `@electron-toolkit/preload` `@electron-toolkit/utils` `@monaco-editor/react` `better-sqlite3` `electron-store@8.2.0`(CJS 兼容) `fastify` `react@19` `react-dom@19` `zustand`
- 开发：`@electron-toolkit/tsconfig` `@tailwindcss/postcss` `@types/better-sqlite3` `@types/node` `@types/react` `@types/react-dom` `@vitejs/plugin-react` `autoprefixer` `electron@33` `electron-builder@25` `electron-vite@2` `postcss` `tailwindcss@4` `typescript@5` `vite@5`
