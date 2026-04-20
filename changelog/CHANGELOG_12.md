# CHANGELOG_12: README 与代码现状再次同步（PermissionRow/AskRow 内嵌、resume 路径、session-end 拆分等）

## 概要

完整阅读了一遍代码，把 README.md 上落后的描述统一拉齐到当前实现。重点是几条「写过但还没回流到 README」的设计取舍，以及 CHANGELOG_11 改了 AskRow 但当时显式说「README 不变」、回头检查发现仍有需要补的地方。

## 变更内容

### `README.md`

#### 「半透明毛玻璃悬浮窗」节
- CSS 描述同步：`saturate(260%)` → `saturate(220%) brightness(0.92)`（CHANGELOG_11 改的，没回 README）
- 默认底色加深到 `rgba(12,14,20,0.78)` 一并写明
- pin 模式数值也补上：`rgba(18,18,24,0.2) + blur(18px)`，方便和默认态对照

#### 「会话生命周期」节
- session-end 在 SDK 与 Hook 通道处理不同：SDK → dormant（jsonl 还在，可 resume），Hook → closed（终端 CLI 真退出）。原文写的是一刀切「session-end → closed」，与 `SessionManager.ingest()` 实际行为不符
- 末尾加一条说明这个差异化的设计意图：「SDK 流终止不视为会话死了，给用户留 resume 的口子」

#### 新增「会话恢复（resume）」节
- 新增章节，介绍 SessionDetail 底部输入框捕获 `not found` 时弹出的「会话已断开 / 恢复会话」按钮
- 解释 `createAdapterSession({ ..., resume })` 让 SDK 加载历史 jsonl 续上对话的工作机制
- 提到乐观清空策略，避免 SDK fallback 30s 等待期间用户以为没生效

#### 「Claude Code SDK 通道」节
- 加 30s fallback / tempKey 重命名说明：CLI 30s 内没消息时如何兜底，真实 session_id 到达后如何无损迁移所有子表 + UI 状态
- 加 cwd 待领取标记（`expectSdkSession`）说明：避免 hook 通道领先到达时出现「内/外」两份重复会话；`realpath` 归一 + 单 pending 模糊匹配兜底

#### 「工具权限请求」节（重写）
- **顶部 banner 已废弃**，改为活动流内嵌 `PermissionRow`：与代码对齐（SessionDetail.tsx 注释「顶部 banner 已废弃：权限请求 / AskUserQuestion 全部由活动流的 PermissionRow / AskRow 内嵌渲染并响应」）
- 补：Edit / Write / MultiEdit 的 toolInput 翻译成 Monaco DiffViewer 直接画在 PermissionRow 行内（`toolInputToDiff()`），不是 JSON
- 补：已响应行变「⚪ 已处理」灰带状态
- 补：bypassPermissions 切换的安全约束（必须新建会话时就选好，运行时切换到该模式无效）—— 沿用 CHANGELOG_9 的描述
- 补：Claude 自动取消 pending 时弹 5s toast 让用户知道按钮消失不是自己点的（cancelToasts 逻辑）

#### 「Claude 主动询问（AskUserQuestion）」节（重写）
- 顶部 banner 同样废弃，改活动流内嵌 `AskRow`：补「已选 N/M」进度 + header 右侧实色「提交回答」按钮 + 底部兜底按钮（CHANGELOG_11）
- **取消「单选立即提交」逻辑**：改为「点击 = toggle，所有题型统一一种交互」（CHANGELOG_11 实际改的就是这条，但当时只说「README 不变」—— 实际 README 之前的描述「单选 = 点击立即提交；multiSelect = checkbox + 提交按钮」已与代码不符）
- 补 AskUserQuestion 也有超时跳过（permissionTimeoutMs 共用阈值）

#### 「SessionDetail 面板」节（重写）
- 顶部 banner → 顶部 toast（自动取消通知）
- 活动 Tab 行渲染按 event kind 拆开列举：MessageBubble / PermissionRow / AskRow / ToolStartRow（内嵌 diff）/ ToolEndRow（折叠展开 result）/ SimpleRow —— 之前 README 只笼统写「单行简述」，现在能让人一眼看到哪些事件支持哪种交互
- 改动 Tab 补：按文件分组按钮带改动次数小角标；文件按最近时间倒序排列
- 底部输入区 SDK 会话补：权限模式下拉 + 「会话已断开 / 恢复会话」红条提示

#### 「项目结构」节
- `manager.ts` 末尾补：cwd 待领取标记 + renameSdkSession
- `summarizer.ts` 末尾补：prompt 标注「Claude 一侧的行为」防止 LLM 把动作误总结成「用户…」（CHANGELOG_3 提到过）
- `sound.ts` 补：防叠播 + 5s 上限 + before-quit 清理（CHANGELOG_7）
- `session-repo.ts` 改：`permissionMode` → `setPermissionMode / rename`（实际方法名）
- `settings-store.ts` 补：`REMOVED_KEYS` 数组
- `App.tsx` 补：mount 时拉一次 listAdapterPendingAll 重建 store（CHANGELOG_10 的 A 修复）
- `FloatingFrame.tsx` 补：pin/无 pin 两套样式
- `SessionDetail.tsx` 补：自动取消 toast + 恢复会话；并说明 PermissionRequests / AskUserQuestionPanel 仍 export 备 banner 模式回切
- `SettingsDialog.tsx` 补：getSettings/hookStatus 异步错误显示
- `ActivityFeed.tsx` 拆开行类型：MessageBubble / PermissionRow（内嵌按钮 + diff）/ AskRow（toggle + 实色提交按钮）/ ToolStartRow（内嵌 diff）/ ToolEndRow（折叠展开 result）/ SimpleRow
- `session-store.ts` 补：pendingAskQuestions / setPendingRequests / setPendingRequestsAll / renameSession（CHANGELOG_10 + SDK fallback 路径）
- `use-event-bridge.ts` 补：onSessionRemoved / onSessionRenamed
- `globals.css` 补：默认底色加深、pin 模式高透明（CHANGELOG_11）

## 备注

- 这次纯文档同步，不动代码，不影响运行时行为
- 用户可见行为本身没变，只是 README 之前没及时跟上 CHANGELOG_3 / 4 / 9 / 10 / 11 的几次小改
- 取舍：保留旧 README 写过的所有有价值描述（设计意图 / DB 迁移 / 鉴权细节等），只把过期的事实改对，不搞推倒重写
- 对照清单：CHANGELOG_1（初始 banner 模式）→ CHANGELOG_3（AskUserQuestion 加 banner）→ 之后某次（具体在哪条 changelog 没标记，从代码注释「顶部 banner 已废弃」推断是 CHANGELOG_4 前后）改成活动流内嵌，但 README 一直没回流
