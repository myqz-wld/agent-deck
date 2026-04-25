# CHANGELOG_31: 设置面板加「置顶时透明」开关

## 概要

新增 `AppSettings.transparentWhenPinned`（默认 true 与历史行为一致），让用户决定 pin（始终置顶）时是否同步关闭系统 vibrancy 让 CSS 主导通透感。关掉则 pin 也保留 'under-window' 实玻璃，看不到下层桌面 / 其他 app。设置即改即生效，无需重启。

## 变更内容

### 设置 schema

**`src/shared/types.ts`**

- `AppSettings` 加 `transparentWhenPinned: boolean`
- `DEFAULT_SETTINGS.transparentWhenPinned = true`（维持原行为）

### 主进程窗口

**`src/main/window.ts`**

- `FloatingWindow` 加内部 state `transparentWhenPinned` + `alwaysOnTopCurrent`
- `setAlwaysOnTop(value)` 中 `setVibrancy` 改为 `value && this.transparentWhenPinned ? null : 'under-window'`
- 新增 `setTransparentWhenPinned(value)`：更新内部 state；当前若已 pin 立即重新应用 vibrancy（非 pin 状态下下次 setAlwaysOnTop(true) 时按新值生效）

### 设置即时生效分发

**`src/main/ipc.ts`**

- 新增 `applyTransparentWhenPinned`，加进 `APPLY_FNS` 常量列表（REVIEW_7 L3 抽 const 之后新增 setting 字段直接进列表，try/catch 双路径自动同步，无漏 apply 风险）

### 启动初始化

**`src/main/index.ts`**

- `floating.create()` 之后调 `floating.setTransparentWhenPinned(settings.transparentWhenPinned)`
- 让 window 启动时按用户 settings 决定 vibrancy 初值（之前默认走构造时的 `vibrancy: 'under-window'`）

### UI

**`src/renderer/components/SettingsDialog.tsx`**

- 「窗口」section 加 Toggle「置顶时透明（看到下层桌面）」+ 一句说明文字
- 排在「开机自启」之前

### README

**`README.md`**

- 「设置」章节「窗口」行更新：`置顶时透明（看到下层桌面，默认开；关掉则置顶时仍是 macOS under-window 实玻璃）/ 开机自启`

## 备注

- 仅 macOS 有视觉差异（vibrancy 是 macOS 系统材质 API），其他平台 toggle 仍持久化但不影响渲染
- 切换后立即生效路径：`SettingsDialog Toggle → window.api.setSettings → ipc.SettingsSet → applyTransparentWhenPinned → window.setTransparentWhenPinned → setVibrancy`
- typecheck + vitest 46/46 全过
