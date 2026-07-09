# CHANGELOG_33: ExitPlanMode 4 档目标权限 + bypass 冷切

## 概要

修「会话开 plan mode 后权限好像停留在 plan」体感问题：旧版 PendingTab 批准 ExitPlanMode 仅让 SDK 退出 plan mode，但 DB 的 `permission_mode` 与下拉值仍是 `'plan'`，下次 `recoverAndSend` 又按 plan 重启子进程。新版让用户在批准时**选目标权限模式**（4 档：default / acceptEdits / plan / bypassPermissions），前 3 档热切，bypass 冷切（销毁旧 SDK 子进程 + 用 `allowDangerouslySkipPermissions: true` 重启子进程，复用 `recoverAndSend` 的 H4/H1 全套护栏）。SessionDetail 下拉切 bypass 与 PendingTab 批准 bypass 收口到同一冷切实现。顺手修 `closeSession` 不 emit cancel 事件导致的 renderer zombie row。

## 变更内容

### 主进程（src/main）

#### `adapters/claude-code/sdk-bridge.ts`
- 新增 `restartWithPermissionMode(sid, mode, handoffPrompt) → Promise<string>`：销毁旧 SDK 子进程 + 用新 mode 重建（复用 `createSession` 的 jsonl 预检 / fork 兜底 / waitForRealSessionId）。`handoffPrompt` 必须非空（SDK streaming 协议约束），调用方拼好语义。单飞共用 `this.recovering` Map（key=sessionId）；占位 message 分方向文案；snapshot oldMode 失败时回滚 DB + emit error msg；CLI 隐式 fork 时 `renameSdkSession(OLD, NEW)` 整体迁子表
- `respondExitPlanMode` 改 async + 按新 `ExitPlanModeResponse` shape 分支：
  - `approve + targetMode`（热切）：原 allow + updatedInput 路径，settle 后同步调 `s.query.setPermissionMode(targetMode)` + 写 DB + emit upsert
  - `approve-bypass`（冷切）：resolver 走 deny + interrupt:true 中止 OLD turn（避开「allow 后 SDK 推 tool_use 与重启子进程抢 jsonl flush」race），调 `restartWithPermissionMode` 用 plan 文本作 handoff prompt 重启到 bypass
  - `keep-planning`：保留原逻辑
- `closeSession` 顺手修：清三个 in-memory pending Maps（`pendingPermissions / pendingAskUserQuestions / pendingExitPlanModes`）**之前**对每个 entry emit 对应 `*-cancelled` 事件，让 renderer store 同步删 row。原版只清 timer + Map 不通知 renderer，store 会残留 zombie row（用户点了 silently no-op）。冷切场景频率高才暴露
- `recovering` Map 类型从 `Promise<void>` 放宽到 `Promise<unknown>`（兼容 restartWithPermissionMode 的 `Promise<string>` 返回；inflight 等待者只 await 不读返回值）
- 新增 `eventBus` import（restartWithPermissionMode 内 emit `session-upserted` 让下拉立即反映 mode 切换）

#### `adapters/types.ts`
- `AdapterCapabilities` 加 `canRestartWithPermissionMode: boolean`
- `AgentAdapter` 加可选 `restartWithPermissionMode?(sid, mode, handoffPrompt) → Promise<string>`

#### `adapters/claude-code/index.ts`
- capability `canRestartWithPermissionMode: true`
- 暴露 `restartWithPermissionMode` 方法委托给 bridge
- 修 `respondExitPlanMode` 加 `await`（bridge 端改成 async 了，原版漏 await）

#### `adapters/{aider,codex-cli,generic-pty}/index.ts`
- capability `canRestartWithPermissionMode: false`（占位 / 非 SDK 通道 adapter 不实现）

#### `ipc.ts`
- `AdapterSetPermissionMode` handler：`mode === 'bypassPermissions'` 时路由到 `adapter.restartWithPermissionMode(sid, m, '继续之前的会话')`，热档保持 adapter→DB 原顺序。两条用户入口（SessionDetail 下拉、PendingTab 批准 bypass）收口到同一底层方法

### 共享层

#### `shared/types.ts`
- `ExitPlanModeResponse` 由 `{decision: 'approve'|'keep-planning', feedback?}` 扩为联合类型：
  - `{decision: 'approve', targetMode: 'default'|'acceptEdits'|'plan'}` 热切
  - `{decision: 'approve-bypass'}` 冷切（独立 decision 避免热切路径误用）
  - `{decision: 'keep-planning', feedback?}`

### Renderer（src/renderer）

#### `components/pending-rows/index.tsx` ExitPlanRow
- 「批准 + 选档下拉」：4 档 select（默认 acceptEdits）+ 主按钮「批准并切到 X」。bypass 选档点击主按钮前弹 confirmDialog 二次确认（文案：「会重启 SDK 子进程，约 5-10s busy；失败自动回滚」）
- `respond` 函数签名改成接 `ExitPlanModeResponse` 全 shape；keep-planning 调用透传 `feedback`
- import 加 `ExitPlanModeResponse` type

#### `components/PendingTab.tsx`
- section 头加 batch shared selector（仅 3 个热档：default / acceptEdits / plan，不含 bypass，避免批量重启 SDK 子进程 + N 条不可逆 bypass 用户来不及确认）。默认 acceptEdits
- `onBatchAllow` 内批准 ExitPlanMode 改用 `{decision: 'approve', targetMode: batchTargetMode}`，bypass 必须 row 内单条触发
- batch tooltip 加目标 mode 提示

#### `components/SessionDetail.tsx`
- bypass confirm 文案对齐冷切实现：从「该模式在已运行的会话上不一定生效」改为「将重启 SDK 子进程切到 bypassPermissions 模式」，按钮文案「重启并切到 bypass」（IPC handler 已路由到 `restartWithPermissionMode`，文案此前误导）

## 备注

- 双 Agent 对抗（Claude general-purpose + Codex gpt-5.5 xhigh）见 `reviews/REVIEW_8.md`，4 处必改设计点全部采纳
- bypass 冷切风险（jsonl flush race）通过 deny+interrupt+restart-with-handoff-prompt 规避，jsonl 留 deny 痕迹但语义干净
- DB 时机：cold path 翻为 DB→adapter（restartWithPermissionMode 内部已写）；hot path 保持 adapter→DB（避免 SDK 拒绝时 DB 脏，虽然 parsePermissionMode 已白名单）
- 冷切失败：snapshot oldMode + try/catch 回滚 DB + emit error msg + 不 re-emit 已死 ExitPlanMode entry
- 顺手修 `closeSession` zombie 是已存在的隐患（频率低未暴露），冷切场景高频触发才浮现
