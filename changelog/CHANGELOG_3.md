# CHANGELOG_3: AskUserQuestion 工具适配

## 概要

Claude Code 的 `AskUserQuestion` 工具是 Claude 主动征询用户（不是危险操作需要批准），原先在 SDK 通道里会被通用 canUseTool 路径拦下来，UI 显示成「⚠️ 等待你的决定」+ 一坨 JSON，体验差。本次为它做独立的 UI 通路：

1. SDK 通道 canUseTool 识别 `AskUserQuestion`，发独立事件 payload `type: 'ask-user-question'`
2. UI 弹独立「❓ Claude 在询问你」面板，把每个 question 渲染成可点击选项 + 「其他」输入框
3. 用户提交答案 → 主进程把答案拼成可读文本塞进 SDK 的 `deny.message` 反馈给 Claude；Claude 看到 tool_result 含答案就能继续对话
4. 单选：点击 option 立即提交；多选：checkbox + 提交按钮；多题：每题独立状态，统一提交
5. 外部 CLI 会话只展示问题，不允许操作（hook 通道没有 canUseTool 通路，技术上做不到）

## 变更内容

### 共享类型（src/shared/）
- `types.ts` 新增：
  - `AskUserOption { label; description? }`
  - `AskUserQuestionItem { question; header?; multiSelect?; options[] }`
  - `AskUserQuestionRequest { type: 'ask-user-question'; requestId; toolUseId?; questions[] }`
  - `AskUserQuestionAnswer { answers: { question; selected[]; other? }[] }`
- `ipc-channels.ts` 新增 `AdapterRespondAskUserQuestion: 'adapter:respond-ask-user-question'`

### Adapter 抽象（src/main/adapters/types.ts）
- `AgentAdapter.respondAskUserQuestion?(sessionId, requestId, answer)` 可选方法
- 占位 adapter（codex-cli/aider/generic-pty）capabilities 不变（false 即可，本来 canRespondPermission 也是 false）

### Claude Code 适配器
- `claude-code/sdk-bridge.ts`：
  - `InternalSession` 新增 `pendingAskUserQuestions: Map<requestId, callback>`
  - `canUseTool` 加 `if (toolName === 'AskUserQuestion')` 分支：解析 input.questions → emit `waiting-for-user` 带 `type: 'ask-user-question'` payload → 把 resolver 存进 pendingAskUserQuestions Map → 等用户答完再 resolve `{ behavior: 'deny', message: '用户已通过 UI 选择...\n\n${formatAskAnswers}' }`
  - 新增 `respondAskUserQuestion(sessionId, requestId, answer)` 方法
  - `consume()` finally 清空时同时拒掉所有未决 AskUserQuestion 回调（标记会话已结束）
  - 新增 `formatAskAnswers(questions, answer)` helper：拼成 `Q1: ... \nA: 选项A, 选项B | 其他：xxx` 多行文本
- `claude-code/index.ts`：转发 `respondAskUserQuestion` 到 bridge

### IPC + preload
- `main/ipc.ts`：注册 `AdapterRespondAskUserQuestion` handler，调用 adapter.respondAskUserQuestion
- `preload/index.ts`：暴露 `window.api.respondAskUserQuestion(agentId, sessionId, requestId, answer)`

### Renderer
- `stores/session-store.ts`：
  - 新增 `pendingAskQuestionsBySession: Map<sessionId, AskUserQuestionRequest[]>`
  - 新增 `EMPTY_ASK_QUESTIONS` 常量、`isAskUserQuestion()` 类型守卫
  - `pushEvent` 在 `waiting-for-user + type='ask-user-question'` 时加入 askMap
  - `removeSession` 同步清掉 askMap
  - 新增 `resolveAskQuestion(sessionId, requestId)` action（用户提交后从 map 移除）
- `components/SessionDetail.tsx`：
  - 头部下方新增 `<AskUserQuestionPanel>`（在权限请求面板之上，更醒目）
  - 新增三个内部组件：
    - `AskUserQuestionPanel` —— 容器，遍历 pending requests
    - `AskQuestionForm` —— 单条 request，维护多题状态；单选立即提交，多选/多题用「提交所有答案」
    - `QuestionRow` —— 单题渲染（header + question + options 按钮 + 「其他」输入框）

### Summarizer 上下文修复（src/main/session/summarizer.ts）
- `formatEventsForPrompt`：把所有事件前缀统一改成「[Claude 说]」「[Claude 调用工具]」「[Claude 改动文件]」「[Claude 主动询问用户]」「[Claude 请求工具权限]」「[Claude 等待用户输入]」
- 之前用「[assistant]」「[tool]」会让 LLM 把「Claude 调用 AskUserQuestion 询问用户」误总结成「用户在询问」；明确把主语标成 Claude 后，模型生成的总结主语正确

### 文档
- `README.md`「工具权限请求」section 之后插入「Claude 主动询问（AskUserQuestion）」一节
- 本文件 + `INDEX.md` 同步

## 备注
- 数据流：Claude tool_use AskUserQuestion → SDK canUseTool callback → emit event → UI 渲染 → 用户点选 → respondAskUserQuestion IPC → resolve callback → SDK 把 `{ behavior: 'deny', message: 用户答案文本 }` 当 tool_result 喂给 Claude → Claude 基于答案继续
- 用 `deny + message` 而不是 `allow + updatedInput` 是因为 PermissionResult 的 allow 不能直接产出 tool result；deny 的 message 字段会作为 tool_result 的 content 传回模型，正好可以承载答案
- 提交按钮的显示规则：任意一题是 multiSelect → 显示「提交所有答案」；全部单选则点 option 立即提交，没有提交按钮
