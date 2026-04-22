# CHANGELOG_28: ExitPlanMode 工具适配（活动页面兼容）

## 概要

Claude Code 的 `ExitPlanMode` 是 plan mode 下 Claude 完成规划后向用户「提议执行计划」的工具。原先在 SDK 通道里没特殊处理，会 fallback 到通用 PermissionRow，把 plan 内容显示成一坨 JSON、按钮文案「允许本次/始终允许/拒绝」语义不对（plan 不是危险权限）。

本次仿 CHANGELOG_3 的 AskUserQuestion 模式给 ExitPlanMode 做完整的独立通路：独立类型 + 独立 IPC + 独立 store map + 专用 UI（绿色按钮 + markdown 渲染 + 可选反馈输入框）。Hook 通道（外部 CLI 会话）也通过 ToolStartRow 展开 plan markdown 让用户能看到内容（只读，必须回终端批准）。零新依赖，复用 CHANGELOG_27 引入的 `MarkdownText`。

## 变更内容

### 共享类型（src/shared/）
- `types.ts` 新增：
  - `ExitPlanModeRequest { type: 'exit-plan-mode'; requestId; toolUseId?; plan }`
  - `ExitPlanModeResponse { decision: 'approve' | 'keep-planning'; feedback? }`
- `ipc-channels.ts` 新增 `AdapterRespondExitPlanMode: 'adapter:respond-exit-plan-mode'`

### Adapter 抽象（src/main/adapters/types.ts）
- `AgentAdapter.respondExitPlanMode?(sessionId, requestId, response)` 可选方法
- `listPending` / `listAllPending` 返回值结构加 `exitPlanModes: ExitPlanModeRequest[]`

### Claude Code 适配器
- `claude-code/sdk-bridge.ts`：
  - `InternalSession` 新增 `pendingExitPlanModes: Map<requestId, PendingExitPlanModeEntry>`
  - `canUseTool` 加 `if (toolName === 'ExitPlanMode')` 分支：解析 `input.plan` → emit `waiting-for-user` 带 `type: 'exit-plan-mode'` payload → 把 resolver 存进 pending Map
    - approve → resolve `{ behavior: 'allow', updatedInput: 原 input }`，CLI 收到 tool_result 自动退出 plan mode 开始执行
    - keep-planning → resolve `{ behavior: 'deny', message: '用户希望继续完善计划...\n反馈：xxx', interrupt: false }`，Claude 留在 plan mode 修
  - 新增 `respondExitPlanMode(sessionId, requestId, response)` 方法
  - 新增 `timeoutExitPlanMode(sessionId, requestId)` 私有方法：超时按「继续规划 + 反馈：用户超时未响应」处理（区别于 permission timeout 的 deny+interrupt，避免打断 turn）
  - `consume()` finally 清空时同时拒掉所有未决 ExitPlanMode 回调（按「会话已结束」反馈）
  - `sendMessage` 的 pending 警告把 ExitPlanMode 也算进来
  - `listPending` / `listAllPending` 加上 exitPlanModes
- `claude-code/index.ts`：转发 `respondExitPlanMode` 到 bridge；listPending / listAllPending 返回值同步

### IPC + preload
- `main/ipc.ts`：注册 `AdapterRespondExitPlanMode` handler；`AdapterListPending` 默认返回值加上 `exitPlanModes: []`
- `preload/index.ts`：暴露 `window.api.respondExitPlanMode(agentId, sessionId, requestId, response)`；`listAdapterPending` / `listAdapterPendingAll` 返回类型同步

### Renderer
- `stores/session-store.ts`：
  - 新增 `pendingExitPlanModesBySession: Map<sessionId, ExitPlanModeRequest[]>`
  - 新增 `EMPTY_EXIT_PLAN_MODES` 常量、`isExitPlanMode()` / `isExitPlanCancelled()` 类型守卫
  - `pushEvent` 在 `waiting-for-user + type='exit-plan-mode'` 时加入 map；`type='exit-plan-cancelled'` 时移除
  - `removeSession` / `renameSession` 同步处理 ExitPlanMode map
  - `setPendingRequests` 签名扩展第 4 个参数（exitPlanModes）；`setPendingRequestsAll` 同步
  - 新增 `resolveExitPlanMode(sessionId, requestId)` action
- `components/ActivityFeed.tsx`：
  - ActivityFeed 加 `pendingExitPlanModes` selector + `resolveExitPlan` 转发；`setPending` 调用补第 4 参数 `res.exitPlanModes`
  - ActivityRow 加 `type === 'exit-plan-mode'` 分支 → 渲染 `<ExitPlanRow>`
  - **新增 `ExitPlanRow` 组件**：绿边卡片 + header「📋 Claude 提议了一个执行计划」 + header 右侧两按钮：
    - 「批准计划，开始执行」（status-working 实色）→ 调 `respondExitPlanMode({ decision: 'approve' })`
    - 「继续规划」（次按钮）→ 第一次点击展开「可选反馈」输入框（避免每次强制弹）；输入框里有 textarea + 「取消 / 发送反馈，继续规划」按钮组；feedback 留空也能提交
  - plan 用 `<MarkdownText>` 渲染（复用 CHANGELOG_27 给 MessageBubble 引入的 markdown 组件，零新依赖）
  - cancelled / 已处理 状态切到 opacity-70 灰色样式
  - 外部 CLI 会话：按钮置灰，提示「请回到对应终端窗口操作」
  - **`ToolStartRow` 加 ExitPlanMode 分支**（hook 通道走这条路）：直接展开 plan markdown 让外部 CLI 会话也能看到 plan 全文（只读，无按钮）
  - `describe` / `describeToolInput` 加 ExitPlanMode 分支：SimpleRow fallback 显示「📋 Claude 提议了一个执行计划」+ plan 第一行简述
- `components/SessionDetail.tsx`：
  - 加 `pendingExitPlanModes` selector + `void` 标记（跟现有 PermissionRow / AskRow 一致，不渲染顶部 banner）
  - 取消 toast 兼容 `exit-plan-cancelled` 事件 → 显示「Claude 自动取消了一次计划批准请求」5s 灰带

### Summarizer 上下文（src/main/session/summarizer.ts）
- `formatEventsForPrompt` 加 `[Claude 提议执行计划]` 前缀（取 plan 第一行作为 hint）；不展开整段 plan 避免 prompt 撑爆 token

### 文档
- `README.md`：
  - 「Claude 主动询问（AskUserQuestion）」节后插入「执行计划批准（ExitPlanMode，plan mode 下）」节
  - SessionDetail Tab 列表加 `waiting-for-user (exit-plan-mode)` 行 + ToolStartRow 备注 ExitPlanMode hook 通道展开 plan
  - 自动取消 toast 描述加上「计划批准请求」
  - 项目结构 ActivityFeed.tsx / MarkdownText.tsx / session-store.ts 行同步
- 本文件 + `INDEX.md`

## 设计要点 / 决策记录

- **复用 MarkdownText 而不是新建 MarkdownView**：CHANGELOG_27 已经为 MessageBubble 引入了 react-markdown + remark-gfm，把 MarkdownText 直接复用过来零新组件、零新依赖
- **「批准计划」用 `behavior: 'allow' + updatedInput 原样透传`**：不是 deny.message 反馈。allow 让 ExitPlanMode 工具调用「成功」，CLI 内部按设计退出 plan mode。如果用 deny，CLI 不会切 mode，后续工具调用还会被 plan mode 拦
- **「继续规划」可选反馈输入框**：第一次点按钮展开输入框，第二次/已写反馈则提交。不强制每次弹，但提供「写明白哪儿不满意」入口；反馈拼进 deny.message，让 Claude 知道改哪里
- **超时按「继续规划」而不是「拒绝并 interrupt」**：plan mode 下 turn 通常很长（Claude 在调研），interrupt 会浪费已做的调研。超时温和 deny + 默认反馈让 Claude 留在 plan mode，用户回来后可以追加新指令继续
- **Hook 通道（外部 CLI）只读**：hook 没有 canUseTool 通路，只能通过 PreToolUse 收到 tool-use-start 事件。在 ToolStartRow 里识别 ExitPlanMode 工具名展开 plan markdown，让用户在应用里也能看到计划内容（不能批准——必须回终端做）
- **不显示「始终允许」按钮**：plan 不是权限策略，没有重复利用价值
- **不持久化 ExitPlanMode 到 DB**：跟 AskUserQuestion 一样，pending 状态是临时的，事件本身已经存进 events 表足够；列表里关闭/重启重新拉 listAdapterPending 重建
