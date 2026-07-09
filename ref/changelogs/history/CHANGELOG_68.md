# CHANGELOG_68: R3.E12 一次性「即将硬切」弹窗 + LegacyTeamExportSection 整体下线

## 概要

R3 PR-B 硬切已上线 (CHANGELOG_65) + R4 Generic-PTY 已实施 (CHANGELOG_66/67)，老 Agent Teams backend 备份窗口期早已过去；R3.E12 阶段加的「即将硬切」一次性 confirm 弹窗 + 设置面板「老 Agent Teams 数据导出」section 失去意义，整体下线。本 changelog **只删不加**：3 个整文件 + 7 处局部编辑 + REMOVED_KEYS 自清字段，0 新增 API。

## 变更内容

### 整文件删除（3）

- `src/renderer/components/settings/sections/LegacyTeamExportSection.tsx` — 设置面板老 team data 导出 UI（含 useState busy/error/lastResult、export 流程、ack 按钮）
- `src/main/ipc/legacy-teams.ts` — `legacy-teams:has-data` / `legacy-teams:export` 两个 IPC handler（含 absolute path 校验）
- `src/main/teams/team-fs.ts` — `exportLegacyTeams` + `hasLegacyTeamData` + `getTeamsRoot` + 两个 root 常量；删完发现整文件只被 legacy-teams.ts 单引用，整文件孤儿一并清

### renderer

- `src/renderer/App.tsx` — 删 R3.E12 一次性 dialog useEffect 整段（启动后探测 hasLegacyTeamData → `window.confirm` 弹「Agent Deck R3 即将彻底硬切：…」+ 自动打开 SettingsDialog）；保留 AppSettings import（其他地方还在用）
- `src/renderer/components/SettingsDialog.tsx` — 删 `LegacyTeamExportSection` import + 渲染调用一处

### main / shared / preload

- `src/preload/index.ts` — 删 `window.api.legacyTeamsHasData` + `window.api.legacyTeamsExport` 两个 facade
- `src/shared/ipc-channels.ts` — 删 `IpcInvoke.LegacyTeamsHasData` + `IpcInvoke.LegacyTeamsExport` 两个 channel
- `src/main/ipc/index.ts` — 删 `registerLegacyTeamsIpc` import + bootstrap 调用
- `src/shared/types/settings.ts` — 删 `r3LegacyExportNoticeAcked: boolean` 字段定义 + `DEFAULT_SETTINGS` 默认值

### 弃用字段自清

- `src/main/store/settings-store.ts` — `REMOVED_KEYS` 加 `'r3LegacyExportNoticeAcked'`，按 CLAUDE.md「弃用字段清理」规约让历史持久化的 ack 标记自动从 settings.json 清掉。已实测：升级后首次启动 log `[settings] removed legacy field "r3LegacyExportNoticeAcked"` 出现一次

## 备注

- **不可逆点**：删除后老用户的 `~/.claude/teams/` / `~/.claude/tasks/` 失去 UI 导出入口（应用不动原文件，用户可手动 `cp` 备份）。R3 PR-B 上线已经历多个版本周期，按用户判断 ("没用了") 默认所有还在用应用的用户都已迁移完毕
- **同期修复**：本批 dist 验证启动时 bootstrap log 干净（含 REVIEW_25 vite chunk 空壳修复后的 `syncAgentDeckSection` / `syncSkills` 不再报 TypeError）；改完 `pnpm typecheck` ✅ + `pnpm dist` ✅ + 覆盖装到 /Applications + ad-hoc 重签 + wrapper ping 验证窗口正常显示 + session 创建成功
- **关联**：删除范围由 [REVIEW_25.md](../../reviews/history/REVIEW_25.md) 同期会话发现（用户在打包验证后顺手清理「没用了」的旧 UX）
