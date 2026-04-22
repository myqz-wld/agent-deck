# CHANGELOG_25: 修 monaco unhandledrejection 红屏 + 活动流可复制

## 概要

两个独立的 renderer UX 修复：
1. monaco DiffEditor 卸载 race 偶发抛 `Error('no diff result available')`，走 async 路径变成 unhandledrejection，绕过了 CHANGELOG_19 在 `window.onerror` 加的白名单，全屏弹红屏。这次抽出共用 `isMonacoUnmountRaceNoise` 判断函数，error / unhandledrejection 两条 listener 都用，把同步 / 异步两条 race 路径都过滤掉。
2. 活动流里的对话内容（消息气泡、tool 输出、JSON 入参）此前因全局 `user-select: none`（防拖窗误选）无法复制。给 `ActivityFeed` 的 `<ol>` 顶层加 `select-text` 覆盖回去。

## 变更内容

### src/renderer/main.tsx
- 抽出 `isMonacoUnmountRaceNoise(reason: unknown): boolean`，正则匹配两条已知 monaco race 报错：
  - `TextModel got disposed before DiffEditorWidget`（DiffEditor cleanup 顺序倒置 → 同步 throw → window.onerror）
  - `no diff result available`（`monaco-editor/.../diffProviderFactoryService.js:110`：`await editorWorkerService.computeDiff` 之后判 `!c` 抛 Error → async 路径 → unhandledrejection）
- `window.addEventListener('error', ...)` 把原内联正则替换成调辅助函数（语义不变，只是抽公共）
- `window.addEventListener('unhandledrejection', ...)` 新加同样的白名单分支：命中 → `console.warn` 留痕 + return；未命中 → 走原本的 `showFatal` 全屏报错

### src/renderer/components/ActivityFeed.tsx
- `<ol className="flex flex-col gap-1.5">` → 加 `select-text`（Tailwind `user-select: text`）
- 注释解释为何安全：拖窗只靠 header 的 `.drag-region`、活动流不参与；button/select 自带 user-agent `user-select: none`、textarea/input 本身可选，整体放开不会破其他 UX

## 取舍说明

### 为什么不直接从 globals.css 去掉 `#root { user-select: none }`
全局禁选是为了避免**拖动 header / 列表项时误选文字**——这个语义对 SessionList、SessionDetail header、tab 栏仍然有用。只在内容密集的 ActivityFeed 局部放开是最小改动、最贴合诉求。

### 为什么 monaco 这条 race 不彻底修
`@monaco-editor/react` 的 useEffect cleanup 与 monaco 内部 worker promise 的生命周期对不齐，要彻底修需要换 monaco 加载方式或自己包一层 cancellation token；这事属于上游 / 后续优化，当前用 noise 白名单兜住就够（不影响功能、用户感知不到）。两条已知报错文本都很特征化，正则误伤概率低。

### 为什么用一个正则而不是数组
两条路径未来不会暴增（基本就是 monaco DiffEditor / TextModel / worker 三件套的几种 race 文本组合）。后续真要加第三条直接拼 `|new pattern` 即可，没必要先抽数组结构。

## 不在这次改动范围内
- 不动 `globals.css` 的全局 `user-select: none`（其他面板需要保留禁选，避免拖窗误选）
- 不动 monaco 加载链路 / cancellation 机制
- 历史 `PermissionRequests` / `AskUserQuestionPanel` banner 组件（已废弃但仍 export）保持原样，不在活动流路径上
