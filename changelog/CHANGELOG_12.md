# CHANGELOG_12: 权限 tab（三层 → 四层 settings）

## 概要

合并原 CHANGELOG_29（会话详情新增「权限」tab，三层 settings 合并展示）+ CHANGELOG_32（补 user-local 层扩到四层）。会话详情新增第 4 个 tab「权限」，按当前会话 cwd 解析 Claude Code settings.json，先按官方文档列的 user/project/local 三层实现，后补 SDK 实际还会读的 `~/.claude/settings.local.json`（user-local），最终四层 `user → user-local → project → local`。**纯只读**，agent-deck 不写任何配置文件。

## 变更内容

### 三层引入（原 CHANGELOG_29）

#### shared 层

- `types.ts` 新增 `SettingsSource` / `SettingsPermissionsBlock` / `SettingsLayer` / `MergedRule` / `MergedDirectory` / `MergedPermissions` / `PermissionScanResult` 类型，对齐 SDK `coreTypes.ts` 的 `PermissionUpdate` schema
- `ipc-channels.ts` 新增 `PermissionScanCwd` / `PermissionOpenFile`

#### main 层

- 新建 `permissions/scanner.ts`：
  - `scanCwdSettings(cwd)`：三个文件 `Promise.all` 并发读，pretty-print 原文 + 抽 permissions 块；ENOENT/ENOTDIR 当成「文件不存在」返回占位 `exists=false`
  - `mergePermissions`：allow/deny/ask/additionalDirectories 按层顺序 union 去重，每条规则记录其出现过的 source 列表；defaultMode 取 local→project→user 倒序首个非空（与 SDK 实际行为一致：靠后的 settingSource 覆盖标量字段）
  - `getCandidatePaths(cwd)`：对外暴露三个候选路径，给 IPC handler 做白名单
- `ipc.ts`：注册两个 handler；`PermissionOpenFile` 严格校验 path 在 `getCandidatePaths(cwd)` 三选一里再调 `shell.openPath`，杜绝 renderer 传任意 path 越权打开

#### preload + renderer

- preload `scanCwdSettings(cwd)` / `openPermissionFile(cwd, path)`
- 新建 `PermissionsView.tsx`：顶部 cwd 信息行 + 「刷新」按钮 + `<MergedPanel>`（每条规则末尾跟 chip `[U]/[P]/[L]` `<SourceBadge>`）+ `<LayerPanel> × 3`（路径 + 是否存在 + 折叠按钮 + 「打开」按钮 + `<RawJsonBlock>` 自写轻量 JSON 高亮，无 monaco 依赖）
- 边界：解析失败红条 + 仍展示原文；不存在文件给「未配置」灰字 + 推断路径 + 仍可点「打开」（多数编辑器会创建空文件）；当 cwd=home 时给黄色提示「project 与 user 是同一文件」
- `SessionDetail.tsx`：`Tab` 类型加 `'permissions'`，渲染 `<PermissionsView cwd={session.cwd} />`

### 扩到四层（原 CHANGELOG_32）

- 实测反馈：缺了 `~/.claude/settings.local.json`，用户在 user-local 写的 allow/deny 既不在「生效合并」里出现，「打开」按钮也找不到对应卡片
- 根因：CHANGELOG_29 当时按官方文档列的「user / project / project-local」三层实现，但 SDK / CLI 实际还会读 `~/.claude/settings.local.json`（user 级个人覆盖，文档里没明说），扫描器漏了它
- `types.ts`：`SettingsSource` 加 `'user-local'`；`PermissionScanResult` 加 `userLocal: SettingsLayer`；`MergedPermissions.defaultMode` 注释顺序改成 `local > project > user-local > user`
- `permissions/scanner.ts`：`CandidatePaths` / `getCandidatePaths` 加 `userLocal: ~/.claude/settings.local.json`；`scanCwdSettings` 改成四层并发读；`mergePermissions` 入参顺序 `[user, userLocal, project, local]`
- `ipc.ts`：`PermissionOpenFile` 白名单加 `candidates.userLocal`
- `PermissionsView.tsx`：`SOURCE_LABEL` / `SOURCE_BADGE` / `SOURCE_HINT` 加 `'user-local'` 条目（label `User Local`、chip `UL`）；user 卡片后插 `<LayerPanel layer={data.userLocal} />`；home 目录场景的「同一文件」提示扩展（补 `local === user-local`）；`MergedPanel` 顶部标题改为「user → user-local → project → local」

### HistoryPanel 点击热区与 SessionList 对齐（原 CHANGELOG_29 追加）

- 实时面板（SessionList → SessionCard）整张卡片都可点开会话详情；历史面板（HistoryPanel）只有标题那一小段 `<div>` 可点，其他 cwd / 时间行 / 卡片空白都不响应
- `<li>` 加 `onClick={() => onSelect(s.id)}` + `cursor-pointer`，整行做点击区；标题 `<div>` 移除 `onClick`；「归档 / 取消归档 / 删除」三按钮 `onClick` 全部 `e.stopPropagation()` 包裹

### 「已响应」与「已被 SDK 取消」拆开显示（原 CHANGELOG_29 追加）

- PermissionRow / AskRow / ExitPlanRow 三个组件在 `stillPending=false` 时统一显示「⚪ 已处理」+ 底部「已响应或已被 SDK 取消」糊在一起
- 顶层 `ActivityFeed` 函数遍历一次 `recent` events，按 payload.type 分别收集 `cancelledPermIds` / `cancelledAskIds` / `cancelledExitIds` 三个 Set，透传给三种 Row
- 每个 Row 新增 `wasCancelled: boolean` prop，三态 UI：等待中 / **已响应**（绿色）/ **已被 SDK 取消**（更暗 `opacity-50` + 灰色 + 底部 hint「Claude 主动放弃了这次请求」）

## 备注

- 不读 managed settings（`/Library/Application Support/ClaudeCode/managed-settings.json` 等系统级）：MDM / 企业策略场景，agent-deck 用户群极少且不同 OS 路径不一样
- 不上 file watcher（避免噪音 + main↔renderer 持续 IPC），用户改完外部配置自己点「刷新」
- 仍然不写任何 settings 文件，落盘还是走 SDK 的「Always allow」原生流程
