# CHANGELOG_10: 权限请求死锁治理（pending 同步 + 超时 abort + 顶部计数 + 排队警告）

## 概要

修上一回合发现的核心 bug：**用户看到「等待授权」按钮被 diff 盖住点不到 → 之后就死锁**。

死锁链路：
1. SDK 调 `canUseTool` → 主进程把 resolver 挂在 `pendingPermissions` Map → emit `permission-request` event
2. UI 渲染按钮被 Monaco diff 溢出遮挡（CHANGELOG_9 已修按钮位置 + overflow-hidden）
3. 但更深层问题：renderer HMR / 重启后 zustand store 是空的，事件流里那条 `permission-request` 被错渲成「已处理」（`stillPending=false` 因为 store 里没那条 pending）→ 按钮按设计不显示 → 用户依然点不到
4. 与此同时主进程那边 resolver 还挂着，SDK query() 仍在 await
5. 用户发 "继续"/"?" → 进 `pendingUserMessages` 队列 → 但 SDK 在 await canUseTool 的 Promise，没消费 → Claude 收不到 → 用户以为会话死了 / 没回应
6. lifecycle 仍是 active（SDK 真没死，只是被卡住），UI 显示「在工作」骗了用户一次

四层修复（A 是底层必需，B/C/D 是配套），让任何一层失效都还有兜底。

## 变更内容

### A. pending 列表 renderer ↔ 主进程同步（拉取重建）

**`src/main/adapters/claude-code/sdk-bridge.ts`**
- `InternalSession.pendingPermissions` 类型从 `Map<requestId, resolver>` 升级为 `Map<requestId, { payload: PermissionRequest, resolver, timer }>` —— 现在能给出完整的 PermissionRequest payload，不只是个 resolver
- 同样改造 `pendingAskUserQuestions`
- 新增 `listPending(sessionId)` —— 返回该 session 当前还在等的 `{permissions, askQuestions}`
- 新增 `listAllPending()` —— 返回所有 session 的 pending 全量快照（启动时一次性灌进 store 用）
- `respondPermission` / `respondAskUserQuestion` / abort handler / consume() finally 全部清理 timer，避免 resolver 已 resolve 后定时器误触

**`src/main/adapters/types.ts` + `claude-code/index.ts`**
- `AgentAdapter` 接口加可选方法 `listPending` / `listAllPending` / `setPermissionTimeoutMs`
- ClaudeCodeAdapter 实现转发到 bridge

**`src/shared/ipc-channels.ts`**
- 加 `AdapterListPending`（`adapter:list-pending`）+ `AdapterListPendingAll`（`adapter:list-pending-all`）

**`src/main/ipc.ts`**
- 加两条 IPC handler 转发到 adapter

**`src/preload/index.ts`**
- 暴露 `listAdapterPending(agentId, sessionId)` / `listAdapterPendingAll(agentId)`

**`src/renderer/stores/session-store.ts`**
- 加两个 action：`setPendingRequests(sessionId, perms, asks)` 覆盖单 session 的 pending；`setPendingRequestsAll(map)` 全量替换
- 用「覆盖」语义（不是「合并」），因为主进程返回的就是当前真实状态，本地老状态没意义

**`src/renderer/App.tsx`**
- mount 时调一次 `listAdapterPendingAll('claude-code')` → `setPendingRequestsAll`，重建全量 pending

**`src/renderer/components/ActivityFeed.tsx`**
- 切会话 / 加载事件时同时调 `listAdapterPending`，用单 session 接口刷新（避免 App.tsx 那次拉取后到现在又有新变化）

### B. sendMessage 在有 pending 时推警告

**`src/main/adapters/claude-code/sdk-bridge.ts`**
- `sendMessage` 检查 `pendingPermissions.size + pendingAskUserQuestions.size`，> 0 时先 emit 一条 `error: true` 的 message event：「⚠ 还有 N 个待处理请求，你这条消息会被排队，但 Claude 要等你先处理完才会看到它」
- 不阻断（消息照样进队列），只是给用户看到原因。之后用户处理了 pending → SDK query() 解锁 → 队列里的消息按顺序被消费

### C. 权限请求超时自动 abort

**`src/shared/types.ts`**
- `AppSettings` 新增 `permissionTimeoutMs: number`（毫秒）；`DEFAULT_SETTINGS` 默认 5 分钟（300_000）
- 0 = 关闭超时

**`src/main/adapters/claude-code/sdk-bridge.ts`**
- `SdkBridgeOptions` 加 `permissionTimeoutMs?` 初始值；`ClaudeSdkBridge` 私有字段保存
- 加 `setPermissionTimeoutMs(ms)` 运行时调（settings 改 → 立即生效）
- `canUseTool` 创建 entry 时 `setTimeout(this.permissionTimeoutMs)` → 超时调 `timeoutPermission` / `timeoutAskUserQuestion`
- `timeoutPermission(sid, requestId)` 流程：清 pending entry → emit `permission-cancelled`（让 UI store 移除）→ emit warning message（让用户看到原因）→ `resolver({ behavior: 'deny', message: 'timeout', interrupt: true })`
- `interrupt: true` 让 SDK 中断当前 turn，最终触发 query 流终止 → consume() finally → emit `session-end` → SessionManager 把 lifecycle 推到 dormant。**这就是「会话死了 UI 也能感知」的关键路径**，原本死锁状态下永远不会走到这里
- AskUserQuestion 走同款逻辑，回调一个特殊「超时未答」答案给 SDK，让它把这次 ask 当空回应处理

**`src/main/adapters/claude-code/index.ts`**
- adapter init 时把 `settingsStore.get('permissionTimeoutMs')` 传给 bridge 构造

**`src/main/ipc.ts`**
- `SettingsSet` handler 检查 patch 包含 `permissionTimeoutMs` → 调 `adapter.setPermissionTimeoutMs(...)` 即改即生效

**`src/renderer/components/SettingsDialog.tsx`**
- 「生命周期」section 加一行「权限请求超时（秒，0 = 不超时）」NumberInput

### D. 顶部 header pending 计数 chip

**`src/renderer/App.tsx`**
- header 标题区右侧加一个 `⚠ N 待处理` chip：把所有 session 的 `pendingPermissions[].length + pendingAskQuestions[].length` 加总
- 点击跳到第一个有 pending 的 session（`setView('live') + select(firstSid)`），避免 pending 被滚到视口外用户看不见
- chip 标 `no-drag`，确保拖动窗口时仍能点到

## 设计要点

- **A、B、C、D 互相独立又互补**：A 解决「按钮看得到」，C 解决「没看到也能自动收尾」，B 解决「卡住期间用户感知」，D 解决「跨 session 不被错过」。任何一层失效，其他三层至少能让用户在合理时间内退出死锁
- **lifecycle 仍由 SessionManager 唯一仲裁**：sdk-bridge 不直接改 lifecycle，只通过 emit `session-end` 让 manager 决定（保持单一真相源；C 的 `interrupt: true` 间接触发，跟原有 abort 行为一致）
- **pending Map 用「覆盖」不是「合并」**：主进程是 pending 的真相源；renderer 偶尔会比主进程慢半拍，但不会丢，因为 emit 流（push event）+ 主动拉取（list pending）双保险
- **超时阈值默认 300s 而非永久**：5 分钟既给了人足够时间起身上厕所回来再决定，又不至于让一个被遗忘的 pending 卡死整个 session 一整天

## README 更新

- 「设置面板 → 生命周期」补 `permissionTimeoutMs`
- 「工具权限请求」节补：按钮位置（header 行不被 diff 盖）/ 超时自动 abort / pending 拉取重建 / header 计数 chip / sendMessage pending 警告
- 「项目结构」App.tsx 一行说明补 `⚠pending 计数 chip`
