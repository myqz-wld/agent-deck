# CHANGELOG_2: 应用图标（Wakaba Mutsumi）

## 概要

把应用图标设成若叶睦头像。源图是 webp 180×180，转 png 并放大到 1024×1024 写入 `resources/icon.png`，BrowserWindow 与 macOS Dock 都用上。

## 变更内容

### 资源（resources/）
- 新增 `resources/icon.png`（1024×1024，由 `~/Downloads/Wakaba_Mutsumi_icon.webp` 经 `sips -s format png` + `sips -z 1024 1024` 转换得到，约 635 KB）
- electron-builder 已配 `directories.buildResources = "resources"`，打包时会自动从此处生成 macOS `.icns`

### 主进程（src/main/window.ts）
- 新增 `resolveIconPath()`：用 `app.getAppPath()/resources/icon.png` 解析路径，dev 与生产都能找到
- `BrowserWindow` 配置加 `icon: nativeImage.createFromPath(resolveIconPath())`
- macOS 下显式调 `app.dock.setIcon(img)`：dev 模式默认 Dock 还是 Electron logo，必须主动设；生产模式由 .icns 接管，重复设也无副作用

## 备注
- 透明 + frameless 的悬浮窗本身不显示图标，主要影响 macOS Dock / 任务切换器 / 通知中心
- 原图只有 180×180，放大到 1024×1024 会有插值模糊，但 macOS Dock 缩到 64×64 后看不出来
