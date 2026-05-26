# CHANGELOG_1: 项目初始化（M1-M9）+ 应用图标

## 概要

合并原 CHANGELOG_1（M1-M9 项目骨架）与 CHANGELOG_2（应用图标）。从零搭建 agent-deck 通用 Coding Agent 驾驶舱，一次性完成 9 个里程碑，基于 Electron 33 + React 19 + TypeScript 5 + Vite 5 + Tailwind 4 + better-sqlite3。

## 变更内容

### 项目骨架与构建

- `package.json`：electron 33 / electron-vite 2 / vite 5 / react 19 / tailwindcss 4
- `electron.vite.config.ts`：main / preload / renderer 三段构建 + path alias `@shared` `@main` `@renderer`
- `tsconfig.{json,node,web}.json`：双 project references；启动脚本 `pnpm dev / typecheck / build / dist`

### 共享层（src/shared/）

- `types.ts`：`AgentEventKind`(8 种) + `AgentEvent<P>`（含 `source: 'sdk'|'hook'`）+ `SessionRecord` + `LifecycleState`（active/dormant/closed，与 `archivedAt` **正交**）+ `PermissionRequest/Response` + `FileChangeRecord` + `DiffPayload<T>` + `SummaryRecord` + `AppSettings` + `DEFAULT_SETTINGS`
- `ipc-channels.ts`：所有 IPC channel 常量集中

### 主进程（src/main/）

- `index.ts`：bootstrap 顺序 = DB → settings → HookServer → adapters → SessionManager → HookServer.start → scheduler+summarizer → IPC → window → eventBus → Cmd+Alt+P 全局快捷键。before-quit 反向清理
- `window.ts`：FloatingWindow 单例。520×680，`transparent + frame:false + alwaysOnTop:'floating' + vibrancy:'under-window'`；compact 折叠 64px
- `event-bus.ts`：TypedEventBus 包装 NodeEventEmitter，4 种事件
- `ipc.ts`：所有 invoke handler 集中。`SettingsSet` 是即改即生效中转点
- `hook-server/`：fastify + `RouteRegistry`，adapter 通过 registry 申请挂路由
- `adapters/claude-code/`：`hook-routes.ts`（6 条路由 + `taggedEmit` 打 `source:'hook'`）+ `translate.ts`（PostToolUse Edit/Write/MultiEdit 同时 emit `tool-use-end + file-changed`）+ `hook-installer.ts`（写 `~/.claude/settings.json`，每条命令带 `# agent-deck-hook` 标记）+ `sdk-bridge.ts`（`new Function('s','return import(s)')` 绕 Vite 静态分析；`createSession` 等第一条 `session_id` 5s 兜底；`canUseTool` 把 resolver 存 `pendingPermissions`；`settingSources:['user','project','local']` 复用本地配置；不读不写 API Key）
- `adapters/registry.ts`：单例，`initAll(ctx)` 把 emit 接进 `SessionManager.ingest`
- 占位 adapter：`codex-cli` / `aider` / `generic-pty`，capabilities 全 false（UI 自动过滤）

### 会话状态机（src/main/session/）

- `manager.ts`：`sdkOwned` 去重；事件复活 closed/archived 会话回 active；`session-end` → closed
- `lifecycle-scheduler.ts`：每分钟扫描，按 `activeWindowMs` / `closeAfterMs` 推进；归档不参与衰减
- `summarizer.ts`：三层降级（LLM oneshot → 最近 assistant 文字 → 事件 kind 统计）；`eventsSince === 0` 跳过；全局 `summaryMaxConcurrent`（默认 2）+ `inFlight` 防同会话并发
- `diff-collector.ts`：薄封装

### 持久化（src/main/store/）

- `db.ts`：better-sqlite3 + 手写迁移系统。V1 init / V2 加 `source` / V3 把 `lifecycle='archived'` 行迁移成 `closed + archived_at`，**从此 archived 与 lifecycle 正交**
- `session-repo.ts` / `event-repo.ts` / `file-change-repo.ts` / `summary-repo.ts`：`summary-repo.latestForSessions(ids[])` 用 SQL 窗口函数一次拿 N 个会话最新总结
- `settings-store.ts`：electron-store v8（CJS 兼容），启动时执行 `REMOVED_KEYS` 清理孤儿字段

### 通知（src/main/notify/）

- `sound.ts`：跨平台播放（macOS afplay / Linux paplay+aplay / Windows powershell）
- `visual.ts`：按 `enableSound` + `silentWhenFocused` + `enableSystemNotification` 决定播放 / 弹 Notification / Dock bounce / 窗口 flash

### 渲染端（src/renderer/）

- `App.tsx`：header 一行（标题+统计 / ＋ / 实时-历史 tab / pin / 折叠 / ⚙）+ main 区（SessionDetail / SessionList / HistoryPanel）
- `components/`：`FloatingFrame` / `SessionList`（active/dormant 分段）/ `SessionCard`（状态徽标+title+来源徽标+实时活动+总结+右键菜单）/ `SessionDetail`（头部+权限请求面板+3 Tab+底部输入区）/ `HistoryPanel` / `NewSessionDialog` / `SettingsDialog`（用 `DEFAULT_SETTINGS` 兜底防 schema 缺字段）/ `StatusBadge` / `ActivityFeed` / `SummaryView` / `diff/`（DiffViewer→DiffRegistry 单例+TextDiffRenderer/Image/Pdf 占位）
- `stores/session-store.ts`（Zustand）：sessions/recentEvents/summaries/latestSummary/pendingPermissions Maps
- `hooks/use-event-bridge.ts`：onSessionUpserted/onAgentEvent/onSummaryAdded 桥接到 store
- `styles/globals.css`：Tailwind 4 + Acrylic frosted-frame（径向+线性渐变 + `backdrop-filter: blur(36px) saturate(260%) brightness(1.12)` + SVG turbulence 噪点 mix-blend overlay + pin 模式更通透）

### 应用图标（resources/icon.png）

- 新增 1024×1024 png（由 Wakaba_Mutsumi_icon.webp `sips -s format png` 转换 + 放大），约 635 KB
- `window.ts` 加 `resolveIconPath()` + `BrowserWindow.icon: nativeImage.createFromPath(...)` + macOS dev 显式 `app.dock.setIcon(img)`（生产由 .icns 接管）
- electron-builder 已配 `directories.buildResources = "resources"`，打包时自动从此处生成 `.icns`

## 备注

- 透明 + frameless 悬浮窗本身不显示图标，主要影响 macOS Dock / 任务切换器 / 通知中心
- 后续单独的功能 / bug 修复请新建后续 CHANGELOG
