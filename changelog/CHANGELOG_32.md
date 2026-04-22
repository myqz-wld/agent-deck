# CHANGELOG_32: 权限 tab 补 user-local（~/.claude/settings.local.json）

## 概要

实测反馈：会话详情「权限」tab 缺了 `~/.claude/settings.local.json` 这一层，用户在 user-local 写的 allow/deny 既不在「生效合并」里出现，「打开」按钮也找不到对应卡片。

根因：CHANGELOG_29 当时按 Claude Code 官方文档列的「user / project / project-local」三层模型实现，但 SDK / CLI 实际还会读 `~/.claude/settings.local.json`（user 级个人覆盖，文档里没明说），扫描器漏了它。

本次把权限层级从 3 层扩到 4 层：`user → user-local → project → local`（高优先级覆盖低优先级），UI / 白名单 / 类型同步对齐。

## 变更内容

### `src/shared/types.ts`
- `SettingsSource` 加 `'user-local'`，注释更新为四层 + 优先级说明
- `PermissionScanResult` 加 `userLocal: SettingsLayer` 字段
- `MergedPermissions.defaultMode` 注释顺序改成 `local > project > user-local > user`

### `src/main/permissions/scanner.ts`
- `CandidatePaths` / `getCandidatePaths` 加 `userLocal: ~/.claude/settings.local.json`
- `scanCwdSettings` 改成四层并发读，`mergePermissions` 入参顺序 `[user, userLocal, project, local]`
- 顶部注释 / `mergePermissions` doc 同步标注 user-local 不在官方文档但 SDK 实际读取

### `src/main/ipc.ts`
- `PermissionOpenFile` handler 的 `allowed` 白名单加 `candidates.userLocal`，让「打开」按钮也能打开 user-local 文件
- 注释从「三个候选路径」改成「四个候选路径」

### `src/renderer/components/PermissionsView.tsx`
- `SOURCE_LABEL` / `SOURCE_BADGE` / `SOURCE_HINT` 三张表加 `'user-local'` 条目（label `User Local`、chip `UL`、hint `~/.claude/settings.local.json`）
- 主体 render 在 user 卡片后插入一张 `<LayerPanel layer={data.userLocal} />`
- home 目录场景的「同一文件」提示扩展：原本只检测 `project === user`，现在补 `local === user-local`，避免 cwd=home 时这两组同样需要提示
- `MergedPanel` 顶部标题从「user → project → local」改为「user → user-local → project → local」

## 关键场景验证

- 在 `~/.claude/settings.local.json` 里有 `permissions.allow: ["Bash(git status:*)"]` → 权限 tab 顶部「生效合并」allow 节出现这条规则、chip 显示 `[UL]`；下方多出一张 User Local 卡片展示完整 JSON
- 点 User Local 卡片「打开」按钮 → 系统编辑器打开 `~/.claude/settings.local.json`（白名单放行）
- cwd 等于 home 目录时 → Project / Local 卡片显示「会话 cwd 等于 home 目录，与 User / User Local 是同一文件」提示

## 没动的地方

- 不读 managed settings（`/Library/Application Support/ClaudeCode/managed-settings.json` 等系统级）：那层是 MDM / 企业策略场景，agent-deck 用户群极少，且不同 OS 路径不一样，性价比低
- 仍然不写任何 settings 文件，落盘还是走 SDK 的「Always allow」原生流程
