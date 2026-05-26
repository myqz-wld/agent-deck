# CHANGELOG_6: 权限交互演进（mode 修复 / 死锁四层兜底 / Slash 拦截 / cancelled 误报）

## 概要

合并原 CHANGELOG_9（permissionMode 写库 + bypassPermissions 配套 + PermissionRow 按钮挪 header + Enter 发送）+ CHANGELOG_10（权限请求死锁四层兜底）+ CHANGELOG_30（拦截 slash 命令）+ CHANGELOG_31（cancelled 事件不再切 waiting / 不弹通知）。一条主线把权限交互从「能用」演进到「不死锁、不误报、不糊脸」。

## 变更内容

### permissionMode 写库 + bypassPermissions 配套（原 CHANGELOG_9）

- **不写 `sessions.permission_mode` 列**：`AdapterCreateSession` IPC handler 只把 permissionMode 传给 SDK，没调 `sessionRepo.setPermissionMode`，UI 显示永远「默认」。修：createSession 返回 sessionId 后写入该列 + 推 `session-upserted`（'default' 跳过避免污染 CLI 通道）
- **`bypassPermissions` 缺安全 flag**：SDK 的 `permissionMode:'bypassPermissions'` 必须同时传 `allowDangerouslySkipPermissions: true`（runtimeTypes.d.ts:428；sdk.mjs 把它们当两个独立 CLI flag 传给子进程）。`sdk-bridge.ts` 之前没传导致真不工作。改：`allowDangerouslySkipPermissions: opts.permissionMode === 'bypassPermissions'`，只在启动时明确选了才打开（运行时 `setPermissionMode` 切到 bypassPermissions 会被 CLI 拒，符合 SDK 语义）

### PermissionRow 按钮被 diff 盖住 + Enter 发送（原 CHANGELOG_9）

- `ActivityFeed.tsx PermissionRow`：「允许 / 始终允许 / 拒绝」三按钮挪到 header 行（`ml-auto` 右对齐），diff 多高都不会盖住；header 时间戳取消 `ml-auto`；diff 容器 `h-72` 加 `overflow-hidden` 防御 Monaco 溢出
- `SessionDetail.tsx onKeyDown` 反转：`Enter` → `preventDefault + send()`、`Shift+Enter` → 默认换行；IME 双保险 `e.nativeEvent.isComposing + keyCode === 229`；placeholder 同步「Enter 发送 / Shift+Enter 换行」

### 权限请求死锁四层兜底（原 CHANGELOG_10）

死锁链路：用户看到「等待授权」按钮被 diff 盖住点不到 → renderer HMR / 重启后 zustand store 是空的，事件流里那条 `permission-request` 被错渲成「已处理」（`stillPending=false` 因为 store 没那条 pending）→ 主进程 resolver 还挂着 SDK query() 仍 await → 用户发"继续"进 `pendingUserMessages` 队列但 SDK 没消费 → 死锁。

四层修复（任一失效还有兜底）：

- **A. pending 列表 renderer↔主进程同步**：`InternalSession.pendingPermissions` 类型从 `Map<requestId, resolver>` 升级为 `Map<requestId, {payload, resolver, timer}>`；新增 `listPending(sessionId)` / `listAllPending()`；`AdapterListPending` / `AdapterListPendingAll` IPC + preload + store 的 `setPendingRequests` / `setPendingRequestsAll`（覆盖语义不是合并）；App.tsx mount 调一次重建全量；ActivityFeed 切会话时调单 session 接口刷新
- **B. sendMessage pending 时推警告**：`pendingPermissions.size + pendingAskUserQuestions.size > 0` 时先 emit 一条 `error: true` 的 message event：「⚠ 还有 N 个待处理请求，你这条消息会被排队」；不阻断只警告
- **C. 权限请求超时自动 abort**：`AppSettings.permissionTimeoutMs` 默认 5 分钟（300_000，0=关闭）；`canUseTool` 创建 entry 时 `setTimeout(this.permissionTimeoutMs)` → 超时 emit `permission-cancelled` + warning message + `resolver({behavior:'deny', message:'timeout', interrupt:true})`；`interrupt:true` 让 SDK 中断 turn → 触发 query 流终止 → consume() finally → emit `session-end` → SessionManager 推 dormant
- **D. 顶部 header pending 计数 chip**：所有 session 的 pendingPermissions+pendingAskQuestions 加总；点击跳到第一个有 pending 的 session

### ComposerSdk 拦截 `/` 开头 slash 命令（原 CHANGELOG_30）

- agent-deck SDK 通道走 streaming input mode，不带 CLI 的 slash 命令注册表，用户输入 `/clear` `/compact` `/cost` 等会撞 SDK 抛的 `Unknown slash command` / `only prompt commands are supported in streaming mode`
- `ComposerSdk.send()` 在 `if (!t || busy) return;` 后、`setText('')` 前加 `t.startsWith('/')` 拦截：本地 `setSendError` 红条提示「应用内会话不支持斜杠命令，请回终端运行 `claude`」；不进 busy 状态、不发 IPC、不清空输入框
- 不本地实现 `/clear` `/compact` `/cost` 等等价语义；不做白名单（避免与 SDK 内部 slash 注册表演进出现漂移）

### cancelled 事件不再切 waiting / 不弹通知（原 CHANGELOG_31）

- 实测：会话已处理完 pending 或 SDK 自己 timeout/abort/session-end 后还会再弹一次「Agent 等待你的输入」+ 提示音，状态徽标卡 `waiting`
- 根因：取消事件（`permission-cancelled` / `ask-question-cancelled` / `exit-plan-cancelled`）跟真请求复用同一个 kind（`waiting-for-user`），下游通知分发和 activity 状态机一律按"又一次需要用户输入"处理
- `manager.ts nextActivityState` 多接 `payload` 参数：`waiting-for-user` 时检查 `payload.type` 以 `-cancelled` 结尾的视为「撤掉那条 pending」，activity 保持 `current` 不切到 `waiting`
- `index.ts` 通知分发的 `waiting-for-user` 分支加 `*-cancelled` 短路：取消事件直接 return 不调 `notifyUser`
- kind 字段保持 `waiting-for-user` 不变（renderer store 已按 `payload.type` 区分），改 kind 反而要全链路重新对齐

## 备注

- A、B、C、D 互相独立又互补：A 解决「按钮看得到」，C 解决「没看到也能自动收尾」，B 解决「卡住期间用户感知」，D 解决「跨 session 不被错过」
- lifecycle 仍由 SessionManager 唯一仲裁；sdk-bridge 不直接改 lifecycle，只通过 emit `session-end`
- 超时阈值默认 300s 而非永久：5 分钟既给人时间起身上厕所，又不至于让一个被遗忘的 pending 卡死整天
- header chip 在 CHANGELOG_8 后被改为打开「待处理」tab（不再跳第一个会话）
