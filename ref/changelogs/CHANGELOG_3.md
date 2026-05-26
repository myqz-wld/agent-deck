# CHANGELOG_3: 对话气泡 / 内部会话演进（user message + Markdown + AskRow 优化）

## 概要

合并原 CHANGELOG_4（内部会话能看完整对话）+ CHANGELOG_11（AskRow 提交按钮显眼化 + 毛玻璃底色加深）+ CHANGELOG_27（header 计数对齐 + MD/TXT 全局切换）+ CHANGELOG_34（MD/TXT 改单条独立，推翻 CHANGELOG_27 全局级联）。从「应用内会话看不到 user message + assistant 文字被截 60 字」演进到「对话气泡 + Markdown 渲染 + 单条独立切换」的最终形态。

## 变更内容

### 内部会话能看完整对话（来自原 CHANGELOG_4）

- `sdk-bridge.ts sendMessage` 在推消息给 SDK 后**额外 emit 一条 message event**：`payload: {text, role:'user'}`
- `translate` 处理 assistant text block 时给 payload 加 `role:'assistant'` 区分主语
- `ActivityFeed.tsx` 重写：拉取上限 50 → 100；新增 `MessageBubble` 组件
  - **user**：右对齐，绿色背景（`bg-status-working/15`），标签「你」
  - **assistant**：左对齐，灰边框背景，标签「Claude」
  - **error**（payload.error=true）：红框
  - 容器宽度 max-88%，`whitespace-pre-wrap break-words` 完整保留长消息
- 其他事件类型仍单行简述但补 detail（路径 / Bash 命令前 80 字）+ emoji（🔧 📝 ⚠ ❓ ✅ ⏹）

### AskRow 提交按钮显眼化（原 CHANGELOG_11）

- `ActivityFeed.tsx AskRow`：暴露 `answeredCount / canSubmit`；header 右侧加「已选 N/M」+ 醒目「提交回答」按钮（`bg-status-working` 实色 + `text-black font-semibold`），与 `PermissionRow` header 风格一致；底部按钮也升级同款实色 + 旁边一行进度提示
- 取消「单选立即提交」逻辑：所有题型统一一种交互更可预期

### 毛玻璃默认底色加深（原 CHANGELOG_11）

- `globals.css .frosted-frame` 默认态：底色 `rgba(22,24,32,0.55)` → `rgba(12,14,20,0.78)`；`backdrop-filter` 的 `brightness(1.12)→0.92`、`saturate(260%)→220%`；顶部 radial / 135° 高光的白色透明度都减半
- pin 模式（`[data-pinned='true']`）保持不变 —— 那是「看穿到下方应用」的特意设计

### header 会话计数对齐（原 CHANGELOG_27）

- 新建 `src/renderer/lib/session-selectors.ts`：`selectLiveSessions(sessions)` pure helper —— `archivedAt === null && lifecycle ∈ {active, dormant}`，按 `lastEventAt` 倒序，与 main 端 `sessionRepo.listActiveAndDormant` SQL 口径完全对齐
- `App.tsx` stats useMemo 改用该 helper 算 total/waiting/working
- `SessionList.tsx` grouped useMemo 替换原内联过滤复用同一份 helper
- 修复后：当前会话内归档一条 active → header N 立刻 -1（修复前要等重启才掉）

### 消息气泡 Markdown 渲染（原 CHANGELOG_27 引入 + CHANGELOG_34 改单条独立）

- 装 `react-markdown@^10` + `remark-gfm@^4`（GFM：表格、任务列表、删除线、自动链接）
- 新建 `MarkdownText` 组件（`src/renderer/components/MarkdownText.tsx`）：受限渲染器；不挂 rehype-raw（默认 escape HTML 安全）；链接强制 `target="_blank" rel="noopener noreferrer"`；p/h1-3/ul/ol/blockquote/code/pre/table 全部套 Tailwind className，控制在 MessageBubble 窄列宽度内；pre/table 加 `overflow-x-auto`
- `MessageBubble`：头部「Claude · 时间」右侧加 MD/TXT 切换按钮（9px、opacity 60% → hover 100%）；error 消息和空消息不显示按钮，错误消息强制 plaintext；markdown 模式下移除 `whitespace-pre-wrap` 让 markdown 自己控制换行
- **CHANGELOG_27 → CHANGELOG_34 取舍翻转**：原版 CHANGELOG_27 用 `useGlobalRenderMode` hook 把切换写 localStorage 全局广播 →「切单条 = 切全局，所有 bubble 一起翻面」。用户反馈这反人类，CHANGELOG_34 改回**单条独立**：每条 bubble 自己 useState，不写 localStorage、不广播；切单条只改本条，互不级联
- `useGlobalRenderMode` hook + `EVENT_NAME` + storage 监听全删；保留 `RenderMode` 类型，内部 `read()` 改为 `readInitialRenderMode()`，命名表达「仅作初始默认」语义
- 副作用接受：切过的 bubble 卸载（切会话 / 应用重启）后回到默认 plaintext，要再切。这是**有意为之**，避免按 message id 存偏好 map 的复杂度

## 备注

- store `recentEventsBySession` 仍只保留 30 条；活动 Tab 打开时从 IPC 拉 100 条覆盖
- 用户消息只在 SDK 通道 emit；外部 CLI 会话的用户输入由用户自己在终端看，hook 通道没有 user input 事件
- 不引入「按 message id 存偏好 map」：复杂度不值得；未来如要全局默认 markdown 再独立加 SettingsDialog 入口
