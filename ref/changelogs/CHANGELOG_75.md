# CHANGELOG_75: Cmd+Alt+T 透明化快捷键（toggle transparentWhenPinned）

## 概要

新增主窗口「置顶时透明」全局快捷键，与现有 `Cmd+Alt+P`（pin toggle）镜像 pattern：按一次 toggle「设置 → 窗口 → 置顶时透明」开关，pin 状态下立即切 CSS frosted-frame + macOS vibrancy，非 pin 时只更新设置值（下次 pin 按新值生效）。选 `Cmd+Alt+T` 而非 plan D9 默认的 `Cmd+Shift+T`（后者被浏览器「重开关闭标签页」抢占，Electron OS 级 `globalShortcut` 会真冲突），与 `Cmd+Alt+P` 命名一致更直觉，按 plan D9 fallback 路径走。

## 变更内容

### shared (`src/shared/ipc-channels.ts`)

- `IpcEvent` 加 `TransparentToggled: 'event:transparent-toggled'`（与 `PinToggled` 同族）

### main (`src/main/index.ts`)

- bootstrap step 10 后加 step 10.5：`globalShortcut.register('CommandOrControl+Alt+T', ...)` — handler 读 `settingsStore.get('transparentWhenPinned')` 取反 → `floating.setTransparentWhenPinned(next)` 立即生效（pin 状态下立切 vibrancy）→ `safeSend(IpcEvent.TransparentToggled, next)` 通知 renderer。注册失败 `console.warn` 与现有 pin shortcut 同 pattern

### preload (`src/preload/index.ts`)

- `api` facade 加 `onTransparentToggled(cb): () => void`，与 `onPinToggled` 同 pattern（subscribe + 返回 unsubscribe）

### renderer (`src/renderer/App.tsx`)

- 加新 useEffect 监听 `window.api.onTransparentToggled((next) => { setTransparentWhenPinned(next); void window.api.setSettings({ transparentWhenPinned: next }); })`，与 `onPinToggled` 监听位置相邻
- settings handler 内 `applyTransparentWhenPinned` 会再调一次 `floating.setTransparentWhenPinned`，与 main globalShortcut handler 是同 value 二次调用 — `setTransparentWhenPinned` 实现 idempotent（同 value `setVibrancy` 安全），不引入副作用

### README (`README.md`)

- 新增「键盘快捷键」节（在「设置」与「项目结构」之间），表格列 `Cmd+Alt+P` + `Cmd+Alt+T` + 行为，备注「为什么选 Cmd+Alt 而非 Cmd+Shift」

## 备注

- 关联 plan：[`.claude/plans/deep-review-flow-fix-20260512.md`](../.claude/plans/deep-review-flow-fix-20260512.md) Phase T1
- D9 决策：复用现有 `settings.transparentWhenPinned`，不新增独立 transparent state；快捷键 = 同步 toggle 这个开关
- 改 `main` / `preload` 必须 dev 重启验证（项目 CLAUDE.md 「验证流程」节硬约束）；本 changelog 实测见 plan T1.6 节
- 后续：plan Phase B (mcp tool schema) / Phase C (UI teammate session 树形折叠) 仍 pending
