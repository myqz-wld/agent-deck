# CHANGELOG_158

Settings UI 改动 — 3 项 follow-up backlog 收口(承接 CHANGELOG_157 ad-hoc deep review):

## 概要

CHANGELOG_157 deep review 触发 + user follow-up 触发的 3 项 settings UI 改动:
1. **LOW-1 (R2 reviewer-codex)**: SummarySection 加 codex 端 model 字段 UI + 旧 hint 改回 cross-adapter 表述
2. **透明配置从设置面板排除** (user 明示请求): 从 WindowSection 删 `windowTransparent` toggle + 长 hint 段;字段本身保留 + 运行时仍 honor + 全局快捷键 Cmd+Alt+T 仍可切换
3. **加快捷键说明 section** (user 明示请求): 新建 `KeyboardShortcutsSection.tsx` 集中列 4 个全局快捷键

## 变更内容

### `src/renderer/components/settings/sections/SummarySection.tsx` 加 codex 端 model 字段 UI

- claude `summaryModel` label 改 "claude 周期性总结模型" + hint 引到下方 codex 字段
- claude `handOffModel` label 改 "claude hand-off 简报模型" + hint 引到下方 codex 字段
- 新增 `codexSummaryModel` ModelInput (label "codex 周期性总结模型",hint "留空 = 沿用 CODEX_SUMMARY_MODEL env → ~/.codex/config.toml 顶层 model 兜底")
- 新增 `codexHandOffModel` ModelInput (label "codex hand-off 简报模型",hint 同款 CODEX_HANDOFF_MODEL env 优先级链)
- ModelInput.commit L42 早已 `draft.trim()` → **R2 LOW-R2-1 settings UI trim 校验自动消除**

### `src/renderer/components/settings/sections/WindowSection.tsx` 删透明 toggle + 抽快捷键速查

- 删 `<Toggle label="窗口透明（看到下层桌面）">` (L26-30 原 toggle 整段)
- 删 透明 hint 段落(平台分流文案 L31-45)
- 删 快捷键速查 inline 段(L46-52,已抽到独立 KeyboardShortcutsSection)
- 仅保留「开机自启」toggle + 更新文件头 jsdoc 说明 "windowTransparent toggle 已从本 section 移除,字段持久化 + 运行时仍 honor,user 通过快捷键 Cmd+Alt+T 切换"
- `IS_DARWIN` import 删 (本 section 不再用)

### 新建 `src/renderer/components/settings/sections/KeyboardShortcutsSection.tsx`

集中列 4 个全局快捷键 (与 `src/main/index.ts` §10-10.6 `globalShortcut.register` 一对一):

| 快捷键 | 功能 |
|---|---|
| `Cmd/Ctrl+Alt+P` | 切换置顶 (等价 header 📌 按钮) |
| `Cmd/Ctrl+Alt+T` | 切换窗口透明 (mac vibrancy on/off + CSS frosted;非 mac 仅 CSS 透明度) |
| `Cmd/Ctrl+Alt+=` | 一键最大化窗口 (到屏幕可用区;再按回上次手动尺寸) |
| `Cmd/Ctrl+Alt+-` | 一键回默认尺寸 (520×680;再按回上次手动尺寸) |

- 平台分流 `mod = IS_DARWIN ? 'Cmd' : 'Ctrl'`
- table 布局 + `<code>` 字体高亮 shortcut + 末尾 disclaimer 说明被其它 app 占用时启动日志 warn
- jsdoc 标注 SSOT:实际 register 在 `src/main/index.ts`,改快捷键时同步 update 本文件

### `src/renderer/components/SettingsDialog.tsx` 接进新 section

- import `KeyboardShortcutsSection`
- `<SectionGroup title="提醒与外观">` 内 `WindowSection` 后追加 `<KeyboardShortcutsSection />`

## 验证

- `pnpm typecheck` GREEN
- `windowTransparent` 字段 settings.ts 保留 (默认 `true`) + 运行时 App.tsx setWindowTransparent 仍 honor + 主进程 globalShortcut Cmd+Alt+T 仍可切

## Follow-up backlog

剩 1 项独立 commit:
- MED-2 codex model regression test (`__tests__/sdk-bridge/` 加 verify ThreadOptions.model 真传 SDK + settings/env 优先级 + 边界 case)
