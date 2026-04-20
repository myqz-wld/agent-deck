# CHANGELOG_4: 内部会话能看到完整对话消息

## 概要

应用内（SDK 通道）创建的会话之前在「活动」Tab 看不到具体消息内容：
- 用户在 composer 里发的消息根本没 emit 成 event，详情面板里完全消失
- Claude 的 assistant 文字消息被 `describe()` 截到 60 字、单行 truncate，长消息看不全

本次把活动流改成对话气泡式 UI，用户/Claude 区分明显，长消息完整保留。

## 变更内容

### SDK 通道（src/main/adapters/claude-code/sdk-bridge.ts）
- `sendMessage` 在把消息推给 SDK 后**额外 emit 一条 message event**：`payload: { text, role: 'user' }`，让前端能看到用户输入
- `translate` 处理 assistant text block 时给 payload 加 `role: 'assistant'` 标记，区分主语

### 活动流（src/renderer/components/ActivityFeed.tsx 重写）
- 拉取上限 50 → 100，多对话场景能看到更长历史
- 新增 `MessageBubble` 组件渲染 message 事件：
  - **user**：右对齐，绿色背景（`bg-status-working/15`），标签「你」
  - **assistant**：左对齐，灰边框背景，标签「Claude」
  - **error**（payload.error=true）：红框警告样式
  - 容器宽度 max-88%，`whitespace-pre-wrap break-words` 保留换行不截断
  - 时间戳放到气泡上方小字
- 其他事件类型（tool-use-start / tool-use-end / file-changed / waiting-for-user / finished / session-end）保留原来的单行简述，但补充：
  - 工具调用显示 detail（路径 / Bash 命令前 80 字 / 正则 pattern）
  - waiting-for-user 区分 `permission-request` / `ask-user-question` / 普通通知
  - 加 emoji（🔧 📝 ⚠ ❓ ✅ ⏹）
- 用 `flex-col gap-1.5` 一组渲染，气泡和单行项目混排自然

### 文档
- `README.md` SessionDetail「活动」Tab 描述更新，强调消息气泡 + 用户/Claude 区分
- 本文件 + `INDEX.md` 同步

## 备注
- store 的 `recentEventsBySession` 仍然只保留 30 条（pushEvent 的 RECENT_LIMIT），但活动 Tab 打开时会从 IPC 拉 100 条覆盖；HMR 推送的实时事件继续按 30 条滑窗
- 用户消息只在 SDK 通道 emit；外部 CLI 会话的用户输入由用户自己在终端里看，应用拿不到（hook 通道没有 user input 事件）
