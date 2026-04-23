# CHANGELOG_2: 工具适配（AskUserQuestion + ExitPlanMode 独立 UI）

## 概要

合并原 CHANGELOG_3（AskUserQuestion）+ CHANGELOG_28（ExitPlanMode）。Claude Code 这两类工具原本会落到通用 `canUseTool` / `PermissionRow`，UI 渲染成 JSON 体验差。本次为它们各自做独立通路：独立类型 + 独立 IPC + 独立 store map + 专用 UI（AskUserQuestion 选项按钮 + 「其他」输入框；ExitPlanMode 绿色按钮 + markdown 渲染 + 可选反馈）。

## 变更内容

### 共享类型（src/shared/）

- `types.ts` 新增：
  - `AskUserOption / AskUserQuestionItem / AskUserQuestionRequest{type:'ask-user-question'} / AskUserQuestionAnswer`
  - `ExitPlanModeRequest{type:'exit-plan-mode'} / ExitPlanModeResponse{decision:'approve'|'keep-planning'; feedback?}`
- `ipc-channels.ts` 新增 `AdapterRespondAskUserQuestion` / `AdapterRespondExitPlanMode`

### Adapter 抽象（src/main/adapters/types.ts）

- `AgentAdapter.respondAskUserQuestion?` / `respondExitPlanMode?` 可选方法
- `listPending / listAllPending` 返回值结构加 `exitPlanModes: ExitPlanModeRequest[]`

### Claude Code 适配器（claude-code/sdk-bridge.ts）

- `InternalSession` 加 `pendingAskUserQuestions` / `pendingExitPlanModes` Map
- `canUseTool` 加 `if (toolName === 'AskUserQuestion')` / `'ExitPlanMode'` 分支：emit `waiting-for-user` 带 type → 存 resolver 到对应 Map
- AskUserQuestion 答案塞进 SDK 的 `deny.message` 反馈给 Claude（用 deny+message 而不是 allow+updatedInput，因为 PermissionResult 的 allow 不能直接产出 tool result，deny.message 字段会作为 tool_result.content 传回模型）
- ExitPlanMode：approve → `{behavior:'allow', updatedInput:原 input}`（CLI 收到 tool_result 自动退出 plan mode）；keep-planning → `{behavior:'deny', message:'用户希望继续完善...\n反馈：xxx', interrupt:false}`（留在 plan mode）
- 新增 `respondAskUserQuestion` / `respondExitPlanMode` 方法
- `consume()` finally 清空时拒掉所有未决回调
- ExitPlanMode 超时按「继续规划+反馈：用户超时未响应」处理（区别于 permission timeout 的 deny+interrupt，避免打断 turn）

### IPC + preload + Renderer

- `ipc.ts`：注册两个 handler；preload 暴露 `respondAskUserQuestion` / `respondExitPlanMode`
- `stores/session-store.ts`：新增 `pendingAskQuestionsBySession` / `pendingExitPlanModesBySession` Map + `EMPTY_*` + 类型守卫；`pushEvent` 按 `payload.type` 加入对应 map；`removeSession` / `renameSession` 同步清理；`setPendingRequests` 第 4 参数扩展 exitPlanModes
- `components/SessionDetail.tsx`：头部下方挂 `<AskUserQuestionPanel>`（顶部 banner 模式，后被 CHANGELOG_3 / CHANGELOG_6 改为活动流内嵌）
- `components/ActivityFeed.tsx`：`AskRow` / `ExitPlanRow` 两个新组件
  - `AskRow`：按题目渲染 option 按钮 + 「其他」输入框，单选立即提交 / 多选+多题用「提交所有答案」
  - `ExitPlanRow`：绿边卡片 + header「Claude 提议了一个执行计划」+ 「批准计划，开始执行」（status-working 实色）+ 「继续规划」（首点展开反馈 textarea）+ plan 用 `<MarkdownText>` 渲染（复用 CHANGELOG_3 引入的 markdown 组件，零新依赖）
  - 外部 CLI 会话：按钮置灰，提示「请回到对应终端窗口操作」
- `ToolStartRow` 加 ExitPlanMode 分支（hook 通道走这条）：直接展开 plan markdown 让外部 CLI 也能看到 plan 全文（只读）

### Summarizer 上下文修复（src/main/session/summarizer.ts）

- `formatEventsForPrompt` 把所有事件前缀改成「[Claude 说]」「[Claude 调用工具]」「[Claude 改动文件]」「[Claude 主动询问用户]」「[Claude 提议执行计划]」「[Claude 请求工具权限]」「[Claude 等待用户输入]」
- 之前用「[assistant]」「[tool]」会让 LLM 把「Claude 调用 AskUserQuestion」误总结成「用户在询问」；明确主语标成 Claude 后，模型生成的总结主语正确

## 备注

- AskUserQuestion 数据流：Claude tool_use → SDK canUseTool → emit event → UI → 用户点选 → respondAskUserQuestion IPC → SDK 把 deny.message 当 tool_result 喂给 Claude → Claude 基于答案继续
- ExitPlanMode 不持久化到 DB（同 AskUserQuestion）：pending 状态临时，事件本身已存进 events 表足够；重启重新拉 listAdapterPending 重建
- 不显示 ExitPlanMode 的「始终允许」按钮：plan 不是权限策略，没有重复利用价值
