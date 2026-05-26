# CHANGELOG_32: 设置面板 hook 状态读取 + 透明玻璃关闭后 pin/非 pin 同色

## 概要

修两个独立 UI 体感 bug：(1) 打开设置面板时 `hookStatus 失败：cwd must be non-empty string` 红框报错（main 校验比 adapter 严格，user scope 本来就不需要 cwd）；(2) CHANGELOG_31 引入 `transparentWhenPinned` 开关后只动了主进程 vibrancy，CSS frosted-frame 仍按「pin 即透明」单维度判断，用户关掉透明后 pin 态仍套 alpha 0.2 极透明背景，与非 pin 的 alpha 0.78 深色玻璃肉眼可见色差。

## 变更内容

### src/main/ipc.ts

- 新增 `parseHookCwd(scope, cwd)` helper：scope='user' 返回 undefined，scope='project' 走 `parseStringId` 必填校验
- `HookInstall` / `HookUninstall` / `HookStatus` 三个 handler 全部改用 helper，对齐 `settingsPath` / installer / adapter / preload 一路 `cwd?` optional 的语义
- 根因：`hook-installer.ts:52` `settingsPath` 在 user scope 下只用 `~/.claude/settings.json`，cwd 不参与；只有 ipc.ts 三处把 cwd 当必填，renderer 调 `hookStatus('user')` 单参直接被拦

### src/renderer/components/FloatingFrame.tsx

- prop 由 `pinned` 改名为 `transparent`，data attribute 由 `data-pinned` 改为 `data-transparent`
- 组件本来不需要知道「pin」业务概念，只关心「视觉是否走透明态」，命名对齐实际语义

### src/renderer/styles/globals.css

- `.frosted-frame[data-pinned='true']` 选择器（背景 + ::before display:none 两处）替换为 `.frosted-frame[data-transparent='true']`
- 注释更新：从「pin 模式」改为「透明态」，明确仅当 `(pinned && transparentWhenPinned)` 时由 App.tsx 切到 `data-transparent='true'`

### src/renderer/App.tsx

- 新增 `transparentWhenPinned` state，初始化 effect 一并从 `getSettings` 读取
- `<FloatingFrame transparent={pinned && transparentWhenPinned}>`：CSS 透明态由两个条件共同决定
- SettingsDialog `onClose` 包一层 re-fetch settings 同步 `transparentWhenPinned` state（无 settings broadcast 通道时的轻量兜底；用户在 dialog 里改完关掉后窗口外观立即对齐）

## 备注

- 没改 hook adapter / installer / preload 任何签名，只动 main 的 IPC 校验；type 已是 `cwd?: string`，本次让 runtime 校验跟上类型签名
- 透明态决策权放 renderer 是因为 CSS 不能从主进程直接拉 settings；如果未来需要更多组件响应 settings 变化，应改加一条 `settings:applied` 广播事件，本次没做以保持改动最小
- 两个 fix 共用一份 changelog，因为都是「打开设置面板/调透明开关」一组用户路径里的视觉 bug
