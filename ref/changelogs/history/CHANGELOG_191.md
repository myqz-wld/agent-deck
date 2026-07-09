# CHANGELOG_191 — 设置面板「日志」改造:「在 Finder 中显示」→ 应用内 Monaco 只读查看 modal

## 概要

设置面板「会话 → 日志」操作区把原「在 Finder 中显示」按钮（`shell.showItemInFolder` 外部跳转）改造为**应用内 Monaco 只读查看 modal**:点「查看日志」直接在应用内弹出当天 `main-YYYY-MM-DD.log` 文本，无需切到 Finder + 外部编辑器。承接 [plan `runtime-logging-electron-log-20260529`](../../plans/history/runtime-logging-electron-log-20260529.md) §D9 落地的 LogsSection 后续体验改进（用户反馈「外部跳转看日志太绕」）。

直接在 main 分支改（无 worktree、无独立 plan）。原 `LogsShowCurrentInFinder` IPC channel / handler / preload 方法整套替换为 `LogsReadToday`。

## 变更内容

### B1 — IPC channel 重命名（`src/shared/ipc-channels.ts`）

- 加 `LogsReadToday: 'logs:read-today'`，删旧 `LogsShowCurrentInFinder`。

### B2 — main handler 改读文件（`src/main/ipc/logs.ts`）

- 删旧 `LogsShowCurrentInFinder` handler（`shell.showItemInFolder` + 文件不存在 fallback openPath）。
- 加 `LogsReadToday` handler，复用 `todayLogFile()` 构造路径，返回 `{ ok, existed, content?, truncated?, size?, path?, error? }`:
  - 文件不存在 → `{ ok:true, existed:false }`，UI 显空态。
  - **symlink 防护**：抽 `refuseSymlink()`（`fs.lstatSync` 不 follow，命中 symlink 直接拒），与既有 `LogsTruncateToday` 同源加固（攻击面 = 当天 log 文件被换成 symlink → 读会 follow 到任意同权限文件）。
  - **2MB tail cap**（`LOG_READ_TAIL_CAP`）：文件 ≤ 2MB 全读；> 2MB 用 `fs.openSync` + `fs.readSync` 只读尾部 2MB（日志尾部=最新，用户最关心），标 `truncated:true` + 返 `size`，`finally` 兜底 `closeSync`。当天 log 正常 ≤1MB（electron-log maxSize rotate），2MB 是防御性上限。

### B3 — preload typed 方法（`src/preload/api/misc.ts`）

- 加 `logsReadToday()` typed facade（返回类型与 handler 对齐），删旧 `logsShowCurrentInFinder()`。

### B4 — 新建 `LogViewerModal.tsx`（`src/renderer/components/settings/sections/`）

- Monaco lazy import（`@monaco-editor/react` named `Editor`，与 `TextDiffRenderer` 同款懒加载，体积大）。
- 只读 Editor（`readOnly` / `minimap:false` / `wordWrap:'on'` / `overviewRulerLanes:0` / `lineNumbers:'on'`）。
- **定位 `fixed inset-0 z-[60]`**：LogsSection 嵌在 SettingsDialog `overflow-y-auto` 卡片内，`absolute` 会被裁掉 + 定位错祖先；`fixed` 逃逸 overflow + 豁免 `.frosted-frame > *:not(.fixed)` 强制 relative 规则。z-[60] 高于 SettingsDialog(z-40) / ContentViewerModal(z-50)。
- 自管 load/refresh（日志滚动写入，查看期间可重新拉取）；空态（`existed:false`）；截断 banner（`truncated:true` 显「仅显示最新 2MB 尾部」）；`seqRef` 防快速开关 / 连点刷新旧响应回写新状态。

### B5 — LogsSection 接线（`src/renderer/components/settings/sections/LogsSection.tsx`）

- import `LogViewerModal` + `useState` 加 `logOpen` state。
- 删 `handleShowCurrentInFinder`；按钮 label「在 Finder 中显示」→「查看日志」，onClick → `setLogOpen(true)`。
- JSX 末尾渲染 `<LogViewerModal open={logOpen} onClose={() => setLogOpen(false)} />`。
- 更新组件 jsdoc。

### 文档

- `README.md` §日志(runtime logging) 加一行设置面板操作按钮说明（打开日志目录 / 查看日志 / 清空今天日志）。

## 验证

- ✅ grep 自检：`LogsShowCurrentInFinder|showCurrentInFinder` 全局无活引用（仅 `ref/` 下历史 plan/changelog 归档保留）。
- ✅ `pnpm typecheck` 双配置绿（修了 B4 遗留的 `renderOverviewRuler` 无效 Monaco option → 改 `overviewRulerLanes:0`）。
- ✅ `pnpm build` 通过（main 790.98 kB / preload 27.10 kB / renderer 1480.70 kB；dynamic-import 警告为既有无关项）。
- ⏳ 重启 dev 手测（B1-B3 动 main/preload 非 HMR）：设置→日志→「查看日志」Monaco 加载/刷新/空态、打开目录/清空今天日志无回归 — **用户决定跳过**，后续自测。

## 备注

本 changelog 仅覆盖**日志查看器改造**（B1-B5 + 验证）。当前工作树另含一批独立的「提示词资产重构」改动（决策对抗 → simple-review 迁移、删 `reviewer-*.sh.tmpl` / `codex-cli-stuck-lessons.md`、CLAUDE.md/CODEX_AGENTS.md 等），属另一任务范畴，未纳入本条，需单独归档。
