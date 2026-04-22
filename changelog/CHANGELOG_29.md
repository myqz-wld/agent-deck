# CHANGELOG_29: 会话详情新增「权限」tab

## 概要

会话详情的 tab 行追加「权限」，按当前会话 cwd 解析三层 Claude Code settings.json（user / project / local），顶部展示按 SDK `settingSources: ['user','project','local']` 顺序合并后的生效规则，下面三张卡片分别展示每层完整 JSON。**纯只读**，agent-deck 不写任何配置文件，改规则统一走系统编辑器（按钮调 `shell.openPath`）。

设计上对齐 SDK 的「Always allow」机制：那条按钮把 `ctx.suggestions` 的 `PermissionUpdate[]` 透传回 SDK 由它落盘到 `.claude/settings.local.json` 等文件，agent-deck 始终不参与文件读写。这次新增的「权限」tab 让用户可以肉眼看到这些落盘的规则跟 cwd 的具体关系。

## 变更内容

### shared 层（src/shared/）

- `types.ts`：新增 `SettingsSource` / `SettingsPermissionsBlock` / `SettingsLayer` / `MergedRule` / `MergedDirectory` / `MergedPermissions` / `PermissionScanResult` 类型，对齐 SDK `coreTypes.ts` 的 PermissionUpdate schema 取关键字段
- `ipc-channels.ts`：`IpcInvoke` 新增 `PermissionScanCwd: 'permission:scan-cwd'` 与 `PermissionOpenFile: 'permission:open-file'`

### main 层（src/main/）

- 新建 `permissions/scanner.ts`：
  - `scanCwdSettings(cwd)`：三个文件 `Promise.all` 并发读，pretty-print 原文 + 抽取 permissions 块；ENOENT/ENOTDIR 当成「文件不存在」返回占位结构（exists=false），其他 IO 错误把 errno 写进 parseError 让 UI 显示
  - `mergePermissions`：allow/deny/ask/additionalDirectories 按层顺序 union 去重，每条规则记录其出现过的 source 列表；defaultMode 取 local→project→user 倒序首个非空（与 SDK 实际行为一致：靠后的 settingSource 覆盖标量字段）
  - `getCandidatePaths(cwd)`：对外暴露三个候选路径，给 IPC handler 做白名单
  - cwd 兜底为 homedir（与 CHANGELOG_23 保持一致）；当 cwd 实际是 homedir 时 user 与 project 路径相同，scanner 不去重，由 UI 检测路径相同时给提示
- `ipc.ts`：注册两个 handler
  - `PermissionScanCwd` → `scanCwdSettings(cwd)`
  - `PermissionOpenFile` → 严格校验 path 在 `getCandidatePaths(cwd)` 三选一里再调 `shell.openPath(path)`，杜绝 renderer 传任意 path 越权打开；shell.openPath 错误信息原样回传给前端（ok / reason 协议）

### preload 层（src/preload/index.ts）

- 新增两个 typed facade：
  - `scanCwdSettings(cwd: string): Promise<PermissionScanResult>`
  - `openPermissionFile(cwd: string, path: string): Promise<{ ok, reason? }>`

### renderer 层（src/renderer/components/）

- 新建 `PermissionsView.tsx`：
  - props 仅 `{ cwd }`，cwd 变化或挂载时 `scanCwdSettings` 自动拉一次；顶部 cwd 信息行 + 「刷新」按钮
  - `<MergedPanel>`：合并视图，每条规则末尾跟 chip `[U]/[P]/[L]`（`<SourceBadge>` 子组件，title 显示来源全名 + 路径模板）
  - `<LayerPanel>` × 3：路径 + 是否存在 + 折叠按钮 + 「打开」按钮；body 是 `<RawJsonBlock>`（`<pre>` + 自写轻量 JSON 高亮 `highlightJson`，对 key/string/keyword/number 着不同色，无 monaco 依赖）
  - 边界：解析失败红条 + 仍展示原文；不存在文件给「未配置」灰字 + 推断路径 + 仍可点「打开」（多数编辑器会创建空文件）；当 cwd 等于 home 时给黄色提示「project 与 user 是同一文件」
  - 「打开」按钮失败把 errorMsg 红条显示在卡片 header 下面（不弹 toast，免被忽略）
- `SessionDetail.tsx`：
  - `Tab` 类型加 `'permissions'`，tab 行加按钮，渲染分支 `{tab === 'permissions' && <PermissionsView cwd={session.cwd} />}`
  - 切会话时已有的 `setTab('activity')` 重置逻辑覆盖这个新 tab，无需额外处理

### 文档（README.md）

- 「SessionDetail 面板」节由「三个 Tab」改为「四个 Tab」，新增「权限」一节描述合并视图 / 三层卡片 / 打开按钮 / 边界处理
- 「项目结构」节加 `main/permissions/scanner.ts` 与 `renderer/components/PermissionsView.tsx`，并把 SessionDetail 描述里的「3 Tab」改成「4 Tab」

## 验证

`pnpm typecheck` 通过（main + renderer 两套 tsconfig 都过）。

手测路径：

1. 选中一个 cwd 是 `~/Repository/personal/agent-deck`（本仓库）的会话 → 切「权限」tab
   - User 卡片显示 `~/.claude/settings.json` 内容；Project 卡片「未配置」；Local 卡片显示 `Bash(grep:*) / Bash(cat:*) / Bash(head:*)`
   - 顶部合并视图列出 user 的 `mcp__hilo_tools__*`（标 `[U]`）+ local 的三条 Bash 规则（标 `[L]`）
2. 点 Local 卡片 [打开] → 系统默认编辑器打开 settings.local.json
3. 编辑器手动加规则后回 agent-deck 点 [刷新] → 顶部合并和 Local 卡片同步
4. 切到 `/tmp` 临时建会话 → Project / Local「未配置」、User 仍正常
5. 故意把 settings.local.json 写成非法 JSON → 红字「解析失败」+ 仍能看原文
6. 用一个非候选路径手动调 `permission:open-file`（dev tools console）→ 拿到 `{ ok: false, reason: 'path not in candidate list' }`

## 安全要点

- scanner 只调 `fs.readFile` + `JSON.parse`，绝不写文件
- `permission:open-file` IPC 的 path 必须命中 `getCandidatePaths(cwd)` 三选一的白名单，否则返回 `{ ok: false, reason: 'path not in candidate list' }`，杜绝 renderer 通过该通道打开任意路径
- 不上 file watcher（避免噪音 + main↔renderer 持续 IPC），用户改完外部配置自己点「刷新」

---

## 追加：HistoryPanel 点击热区与 SessionList 对齐

**症状**：实时面板（SessionList → SessionCard）整张卡片都可点开会话详情；历史面板（HistoryPanel）只有标题那一小段 `<div>` 可点，cwd 行 / 时间行 / 卡片空白都不响应，跟实时面板交互习惯不一致。

**修法**（src/renderer/components/HistoryPanel.tsx）：

- `<li>` 加 `onClick={() => onSelect(s.id)}` + `cursor-pointer`，整行做点击区
- 标题 `<div>` 移除 `onClick` + `cursor-pointer`（保留 `hover:text-white` 让标题仍有 hover 反馈）
- 「归档 / 取消归档 / 删除」三个按钮 `onClick` 全部用 `(e) => { e.stopPropagation(); ... }` 包裹，避免点按钮冒泡触发 `onSelect`，与 SessionCard 内部 menu 按钮的处理方式一致

不动 README（行为对齐既有约定，不增加新可见特性）。

---

## 追加：「已响应」与「已被 SDK 取消」拆开显示

**症状**：PermissionRow / AskRow / ExitPlanRow 三个组件在 `stillPending=false` 时统一显示「⚪ 已处理」+ 底部一行「已响应或已被 SDK 取消」糊在一起，分不清这条 request 是用户主动 allow/deny/answer/approve 的，还是 SDK 自己 abort 掉的（流终止 / interrupt / 超时）。

**修法**（`src/renderer/components/ActivityFeed.tsx`）：

1. 顶层 `ActivityFeed` 函数遍历一次 `recent` events，按 payload.type 分别收集 `cancelledPermIds` / `cancelledAskIds` / `cancelledExitIds` 三个 Set；通过 `RowProps` 透传给三种 Row
2. 每个 Row 新增 `wasCancelled: boolean` prop，三态 UI：
   - 等待中：`⚠ 等待授权` / `❓ Claude 在询问你` / `📋 Claude 提议了一个执行计划`（保持原色）
   - **已响应**：`✅ 已响应` / `✅ 已回答` / `✅ 已处理`（绿色，不显示底部 hint —— 已经够清楚）
   - **已被 SDK 取消**：`🚫 已被 SDK 取消` / `🚫 提问已被取消` / `🚫 计划批准已被取消`（更暗 `opacity-50` 卡片 + 灰色文字）+ 底部 hint「Claude 主动放弃了这次请求（流终止 / interrupt / 超时）」
3. cancellation 检测靠活动流自身的 `*-cancelled` 事件（main 端 sdk-bridge.ts 在 abort / timeout / session-end 时已经 emit）—— renderer 不需要新加 store map，就用现有 `recentEventsBySession` 一次扫描即可，无 store 改动 / 无 IPC 新增

之前顶部的「Claude 自动取消了一条权限请求 / 提问 / 计划批准请求」5s toast 保持不变，作为「时刻提示」；新的 cancelled 视觉是「持久标记」，关掉 toast 之后回看活动流仍能一眼区分。

