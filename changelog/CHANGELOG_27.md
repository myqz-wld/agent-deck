# CHANGELOG_27: 修复 header 会话计数 + MessageBubble Markdown 切换

## 概要

修两件事：(1) 顶部「N 会话 · X 等待 · Y 进行中」会把当前运行时归档（archived_at 标记）和 lifecycle 转 closed 的会话算进去，与下方 SessionList 实际可见数对不上；(2) user/assistant 消息气泡支持 Markdown 渲染，每条头部右侧加 MD/TXT 切换按钮，偏好走 localStorage 全局生效。

## 变更内容

### header 计数口径统一（src/renderer/lib/session-selectors.ts 新建 + App.tsx + SessionList.tsx）

- 新建 `selectLiveSessions(sessions)` pure helper：`archivedAt === null && lifecycle ∈ {active, dormant}`，按 `lastEventAt` 倒序
- 与 main 端 `sessionRepo.listActiveAndDormant` 的 SQL 口径完全对齐
- `App.tsx` stats useMemo 改用该 helper 算 total/waiting/working
- `SessionList.tsx` grouped useMemo 替换原来的内联过滤，复用同一份 helper
- 修复后：
  - 当前会话内归档一条 active，header N 立刻 -1（修复前要等重启 setSessions 才掉）
  - 一条会话被 LifecycleScheduler 推到 closed，header N 立刻 -1（修复前一直留在 store Map 里被算）

### 消息气泡 Markdown 渲染（src/renderer/components/{MarkdownText.tsx, ActivityFeed.tsx}, src/renderer/lib/render-mode.ts）

- 装 `react-markdown@^10` + `remark-gfm@^4`（GFM：表格、任务列表、删除线、自动链接）
- 新建 `MarkdownText` 组件（src/renderer/components/MarkdownText.tsx）：受限渲染器
  - 不挂 rehype-raw → react-markdown 默认 escape 原始 HTML，安全
  - 链接强制 `target="_blank" rel="noopener noreferrer"`，Electron webContents 默认拦给系统浏览器
  - p/h1-3/ul/ol/blockquote/code/pre/table/th/td 全部套 Tailwind className，控制在 MessageBubble 的窄列宽度内
  - pre/table 加 `overflow-x-auto`，避免代码块/表格撑爆气泡
- 新建 `useGlobalRenderMode` hook（src/renderer/lib/render-mode.ts）：
  - localStorage 单值 `'plaintext' | 'markdown'`，默认 plaintext
  - 写入时 dispatch CustomEvent `agent-deck:render-mode-changed`，同窗口内多个 hook 实例同步刷新
  - 同时监听 `storage` 事件兜底多窗口（理论上桌面 app 单窗口）
- `ActivityFeed.tsx` 的 `MessageBubble` 改造：
  - 头部「Claude · 时间」右侧加 MD/TXT 切换按钮（文案 9px，opacity 60% → hover 100%）
  - 单条本地 mode state 跟随 globalMode；toggle 同时改本地 + 写全局，所有 bubble 一起翻面
  - error 消息和空消息不显示按钮，错误消息强制 plaintext 保留堆栈结构
  - markdown 模式下移除 `whitespace-pre-wrap`（让 markdown 自己控制换行），plaintext 保留

### 不做的事

- 不持久化「单条偏离全局」状态——切单条 = 切全局，避免按 message id 存 map
- 不装代码高亮库（shiki/highlight.js）——气泡窄，等宽字体足够；后续按需独立加
- 不动 PermissionRow / AskRow / ToolEndRow 渲染（结构化交互 / JSON 输出 markdown 化无收益）
- 不加 AppSettings 持久化项——用 localStorage 而非 electron-store，避免主进程 IPC 链路噪音
