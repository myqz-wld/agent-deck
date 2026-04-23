# CHANGELOG_10: Monaco / Diff 红屏修复（同步 throw + async unhandledrejection）

## 概要

合并原 CHANGELOG_19（抑制 Monaco 卸载 race 弹红屏）+ CHANGELOG_25（监 unhandledrejection + 活动流可复制）。同一个 Monaco 卸载 race 走两条不同路径：CHANGELOG_19 修同步 throw 经 `window.onerror`；CHANGELOG_25 升级到 async path 经 `unhandledrejection`，顺手放开活动流的 `user-select`。

## 变更内容

### Monaco 卸载 race 同步 throw 白名单（原 CHANGELOG_19）

- 切会话或关闭 diff 时，`@monaco-editor/react` 在 React 卸载 DiffEditor 的 useEffect cleanup 阶段抛 `TextModel got disposed before DiffEditorWidget model got reset`（包内部已知 race，不影响功能）
- 同步 throw 走到 `window.onerror`，被 `main.tsx` 的兜底 handler 当致命错误调 `showFatal()`，整个窗口被红色全屏面板盖住，必须点 ✕ 才能继续
- ErrorBoundary 接不住 effect cleanup 中的 throw，只能在 window.onerror 这层做白名单
- `src/renderer/main.tsx`：`window.error` handler 在「跨源脚本错误」白名单后追加一条 monaco 卸载 race 的白名单：用 `/TextModel got disposed before DiffEditorWidget/.test(ev.message)` 命中后只 `console.warn` 留痕，不调 showFatal

### Async unhandledrejection 路径升级（原 CHANGELOG_25）

- 又发现 monaco DiffEditor 卸载 race 的另一条路径：`Error('no diff result available')` 走 async 变成 unhandledrejection，绕过了 CHANGELOG_19 加的 `window.onerror` 白名单 → 还是全屏弹红屏
- `src/renderer/main.tsx`：抽出共用 `isMonacoUnmountRaceNoise(reason: unknown): boolean`，正则匹配两条已知 race：
  - `TextModel got disposed before DiffEditorWidget`（DiffEditor cleanup 顺序倒置 → 同步 throw → window.onerror）
  - `no diff result available`（`monaco-editor/.../diffProviderFactoryService.js:110`：`await editorWorkerService.computeDiff` 之后判 `!c` 抛 Error → async path → unhandledrejection）
- `window.addEventListener('error', ...)` 把原内联正则替换成调辅助函数（语义不变只是抽公共）
- `window.addEventListener('unhandledrejection', ...)` 新加同样的白名单分支：命中 → `console.warn` 留痕 + return；未命中 → 走原本 `showFatal`

### 活动流可复制（原 CHANGELOG_25）

- 活动流里的对话内容（消息气泡、tool 输出、JSON 入参）此前因全局 `user-select: none`（防拖窗误选）无法复制
- `ActivityFeed.tsx`：`<ol className="flex flex-col gap-1.5">` 加 `select-text`（Tailwind `user-select: text`）
- 注释解释为何安全：拖窗只靠 header `.drag-region`、活动流不参与；button/select 自带 user-agent `user-select: none`、textarea/input 本身可选

## 备注

- 不直接从 `globals.css` 去掉 `#root { user-select: none }`：全局禁选是为了避免拖动 header / 列表项时误选文字，对 SessionList、SessionDetail header、tab 栏仍然有用
- 不彻底修 monaco：`@monaco-editor/react` 的 useEffect cleanup 与 monaco 内部 worker promise 的生命周期对不齐，要彻底修需要换 monaco 加载方式或自己包一层 cancellation token；属于上游 / 后续优化，当前 noise 白名单兜住够（不影响功能、用户感知不到）
- 用一个正则而不是数组：两条路径未来不会暴增（基本就是 monaco DiffEditor / TextModel / worker 三件套的几种 race 文本组合），后续真要加第三条直接拼 `|new pattern` 即可
- 错误根因是 monaco 默认从 `cdn.jsdelivr.net` 加载，把 monaco 本地化能让应用真正离线可用 + 让版本严格对齐可能消除部分 race，但属独立改动，下次单独立项
