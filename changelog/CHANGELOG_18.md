# CHANGELOG_18: 测试系统通知提示按真实 appName 显示

## 概要

设置面板「测试系统通知」按钮的提示文字硬编码了 `「请到 系统设置 → 通知 → Electron 检查权限」`。这只在 dev 模式正确（dev 跑裸 Electron 二进制，系统通知确实归在「Electron」名下）；生产打包后系统通知应该归在「Agent Deck」名下，老提示让用户去找「Electron」找不到。

改成由 main 进程返回 `app.getName()` 的真实值，renderer 拼接到提示里。

## 变更内容

### src/main/ipc.ts
- `AppShowTestNotification` 成功返回时多带 `appName: app.getName()` 字段
- 注释说明 dev='Electron' / prod='Agent Deck'

### src/preload/index.ts
- `showTestNotification` 返回类型加 `appName?: string`

### src/renderer/components/SettingsDialog.tsx
- `NotificationTestRow.test()` 解构 `r.appName`，拼提示时用它（兜底 'Agent Deck'）
- 函数顶部 docstring 同步：dev/prod 名字差异 + 为什么必须用 main 给的值
