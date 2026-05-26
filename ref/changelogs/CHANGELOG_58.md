# CHANGELOG_58: CLAUDE.md 编辑器迁到资产库 + 设置面板「在资产库中查看」文案统一

## 概要

CHANGELOG_57 把 Header 加了「📚 资产库」Dialog 后，设置面板里两条「跳资产库」按钮文案
不一致（`查看内置资产 ↗` vs `在资产库中查看 ↗`）；CLAUDE.md 又在设置和资产库两处展示
（资产库里只是预览 + 「在设置中编辑 ↗」回环），心智模型分裂。本次收口：

- 设置面板的 ClaudeMd / PluginAssets 两个 section 跳资产库按钮文案**统一**为
  `在资产库中查看 ↗`
- `ClaudeMdEditor` 整体迁到 `AssetsLibraryDialog` 「应用约定」tab —— 设置面板里只剩
  注入 toggle + 跳资产库链接（toggle 是「设置」语义，编辑器是「内容」语义，分开干净）
- 资产库的「应用约定」tab 不再是预览 + 回设置编辑，直接落 `ClaudeMdEditor`（保存 /
  撤销 / 恢复默认 / dirty 拦截整套迁过来）
- 资产库 ↔ 设置之间不再有 `onOpenSettings` 回环

## 变更内容

### `src/renderer/components/AssetsLibraryDialog.tsx`

- 新加 `import { ClaudeMdEditor } from './settings/ClaudeMdEditor'`，「应用约定」tab
  渲染 `<ClaudeMdEditor>`（外面只包一行说明，强调与 user/project/local CLAUDE.md
  互不影响）
- 加 `claudeMdDirtyRef` + `closeInFlightRef` + `onClaudeMdDirtyChange`（useCallback
  稳定 identity，REVIEW_4 M11 同款契约）
- 新加 `confirmDiscardClaudeMd(kind: 'close' | 'switch')` 抽两路共用 confirm；
  `guardedClose` 拦 X 按钮，`guardedSwitchTab` 拦切走 claude-md tab（其他 tab 之间
  切换无 dirty 风险，直接放行）
- 删 props.onOpenSettings + 删 `getClaudeMd` 初始 fetch + 删 `claudeMd` state
  （编辑器自带 fetch / dirty / 写盘，dialog 层不用再持镜像）
- ClaudeMdTab 从 preview + 「在设置中编辑」按钮 → 一行说明 + `<ClaudeMdEditor>`，函数
  瘦身

### `src/renderer/components/SettingsDialog.tsx`

- 删 `claudeMdDirtyRef` / `onClaudeMdDirtyChange` / `closeInFlightRef` /
  `guardedClose` / `guardedOpenAssetsLibrary` 整套 dirty 拦截契约（编辑器已迁走，
  设置面板不再有 dirty draft 可能）
- X 按钮 `onClick` 直接调 `onClose`（没 dirty 可拦）；`onOpenAssetsLibrary` prop 直接
  透传给 ClaudeMd / PluginAssets section（中间不再加包装）
- 总行数 254 → 186

### `src/renderer/components/settings/sections/ClaudeMdSection.tsx`

- 删 `import { ClaudeMdEditor }` + `<ClaudeMdEditor>` 渲染 + `onClaudeMdDirtyChange`
  prop（连带文档串）
- 留 toggle（启用 agent-deck CLAUDE.md 注入）+ 描述 + 「在资产库中查看 ↗」按钮
- 描述加一句「编辑「应用约定」内容请到资产库」明指引

### `src/renderer/components/settings/sections/PluginAssetsSection.tsx`

- 按钮文案 `查看内置资产 ↗` → `在资产库中查看 ↗`，与 ClaudeMdSection 完全对齐
- title 属性同步从「查看内置 skill / agent 完整清单与触发关键词」→「在资产库中查看
  （含内置 + 用户自定义 agents/skills/CLAUDE.md）」与 ClaudeMdSection 同款

### `src/renderer/App.tsx`

- 删 `<AssetsLibraryDialog>` 的 `onOpenSettings={...}` prop（资产库不再回跳设置）
- 注释更新（提到 CHANGELOG_58 文案统一为单一文案）

## 备注

- **`ClaudeMdEditor` 文件位置**：仍在 `src/renderer/components/settings/`，路径已不准
  确（不再被任何 settings 节用），但只搬位置不改行为属于纯 cosmetic refactor，留待
  下次拆分轮顺手挪到 `components/assets/` 子目录（避免本次 PR 引入跨目录 git mv 噪音）
- **dirty 拦截语义切换路径**：原本由 `SettingsDialog` 拦截「关设置弹窗」/「跳资产库」
  两条出口；现在由 `AssetsLibraryDialog` 拦截「关本 dialog」/「切走 claude-md tab」
  两条出口。两套都用 `closeInFlightRef` 锁同一组并发 + `confirmDialog` 让用户二次确认，
  REVIEW_4 M11 关于 `onDirtyChange` cleanup 时序的契约整套迁过来。下一次新建会话生效
  的语义不变（main 端 `saveClaudeMd` 写盘 + 清缓存）
- **typecheck 通过**：`pnpm typecheck` ✅
- **未做项**：
  - ClaudeMdEditor 物理位置挪到 `components/assets/`（cosmetic，留下次拆分轮）
  - 资产库 dialog 加 ESC / 背景点击关闭（与 SettingsDialog 一致地不做，保持极简交互）
