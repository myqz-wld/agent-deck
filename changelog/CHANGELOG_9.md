# CHANGELOG_9: 新建会话「权限模式」修复（写库 + bypassPermissions 安全开关）

## 概要

修两条「新建会话对话框选了权限模式但好像没用」的问题：

1. **创建会话时不写 `sessions.permission_mode` 列** —— `AdapterCreateSession` IPC handler 只把 permissionMode 传给 SDK options，没调 `sessionRepo.setPermissionMode`；`sessionRepo.upsert` 的 INSERT 字段列表里也根本没有 `permission_mode`。结果新建对话框选了 `acceptEdits` / `plan`，会话开起来后 SessionDetail 底部权限下拉永远显示「默认」，让人以为没切换（其实 SDK 那边收到了，只是 UI 显示对不上）。
2. **`bypassPermissions` 缺安全配套 flag** —— SDK 的 `permissionMode: 'bypassPermissions'` 必须同时传 `allowDangerouslySkipPermissions: true`（runtimeTypes.d.ts:428-431；sdk.mjs 把它们当两个独立 CLI flag `--permission-mode` / `--allow-dangerously-skip-permissions` 传给 CLI 子进程）。`sdk-bridge.ts` query options 之前没传，导致 bypassPermissions 真的不工作。

## 变更内容

### src/main/ipc.ts（AdapterCreateSession handler）
- createSession 返回真实 sessionId 后，把 `opts.permissionMode` 写入 `sessions.permission_mode` 列 + 推 `session-upserted`，让 store 跟着同步、SessionDetail 底部下拉跟得上
- `'default'` 跳过写入（避免污染 CLI 通道的列，CLI 通道这列恒为 NULL → fallback 到 'default'，跟「写 'default' 进去」效果一致），其他值（acceptEdits/plan/bypassPermissions）才写

### src/main/adapters/claude-code/sdk-bridge.ts（query options）
- 新增 `allowDangerouslySkipPermissions: opts.permissionMode === 'bypassPermissions'`
- 只在用户启动时明确选了 bypassPermissions 才打开 —— 这样运行时 `setPermissionMode` 切到/切走 bypassPermissions 不会绕开「启动时是否信任此选项」的判断（CLI 子进程已经按这个 flag 启动，运行时切到 bypassPermissions 但启动时没开 flag 会被 CLI 拒，符合 SDK 语义）

## 备注
- 顺带说明一个已知约束：运行时通过 SessionDetail 底部下拉切到 `bypassPermissions`，如果当初启动这个会话时不是 bypassPermissions，CLI 子进程没拿到 `--allow-dangerously-skip-permissions`，运行时切换会被 CLI 拒（pmError 显示）。要全程 bypass，请在新建会话对话框里就选好。
- README 第 57 行「持久化在 `sessions.permission_mode`」之前是「应有行为」，代码没实现，这次补齐 —— README 不动。

---

## 追加：PermissionRow 按钮被 diff 盖住

### 背景
`ActivityFeed` 里 `PermissionRow` 把「允许 / 始终允许 / 拒绝」按钮排在 diff 容器下面。diff 容器固定 `h-72`（288px），但内部 `TextDiffRenderer` 用 `min-h-[260px]` + header + gap ≈ 286px，Monaco 渲染再加上滚动条/边框时会**溢出**父容器；又因为 `h-72` 没设 `overflow-hidden`，溢出部分直接画到下面按钮区上把按钮糊掉，导致用户看不到按钮无法授权。

### 改动 `src/renderer/components/ActivityFeed.tsx`
- **PermissionRow**：把「允许 / 始终允许 / 拒绝」三个按钮挪到 header 行（`ml-auto` 右对齐），diff 多高都不会盖住。原本 header 上的时间戳取消 `ml-auto`，让按钮组顶到右侧；删除 diff 后面的按钮区块（移走了，不重复）。
- **PermissionRow / ToolStartRow** 的 diff 容器 `h-72` 都加了 `overflow-hidden`，防御 Monaco 溢出污染后续元素。

### 为什么是这种修法
- 按钮放 header 行 = 永远在 diff 之上 / 始终可见，授权操作是高优先级动作，理应最显眼。
- 单加 `overflow-hidden` 也能止血，但按钮在 diff 下面、卡片整体高度（padding + header + 288px diff + 按钮区）经常超出滚动可见区，用户还得滚才能点 —— 顺便挪到顶部一并解决。

---

## 追加：输入框发送键改为 Enter（IME 友好）

### 背景
SessionDetail 底部输入框之前是 `Cmd/Ctrl+Enter` 发送、纯 Enter 换行。聊天工具的肌肉记忆是 Enter 直接发，每次发消息都要按修饰键反人类，反过来才符合直觉。

### 改动 `src/renderer/components/SessionDetail.tsx`
- `onKeyDown` 逻辑反转：`Enter`（不带 Shift / 不在 IME 拼写中）→ `preventDefault` + `send()`；`Shift+Enter` 走默认 → 换行
- IME 防护双保险：`e.nativeEvent.isComposing` + `keyCode === 229` 都判一遍，避免中文/日文输入法上屏的 Enter 被当成发送（拼字写一半被发出去太离谱）
- `placeholder` 文案同步更新成「Enter 发送 / Shift+Enter 换行」

### 同步
- README「SessionDetail 面板」底部输入区描述改为新键位
- README「快捷键」节加一条 SessionDetail 输入框的发送/换行键说明
