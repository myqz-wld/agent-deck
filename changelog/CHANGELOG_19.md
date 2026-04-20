# CHANGELOG_19: 抑制 Monaco 卸载 race 弹红屏

## 概要

切会话或关闭 diff 时，`@monaco-editor/react` 在 React 卸载 DiffEditor 的 useEffect cleanup 阶段抛 `TextModel got disposed before DiffEditorWidget model got reset`（包内部的已知 race，不影响功能）。这条同步 throw 走到 `window.onerror`，被 [main.tsx](../src/renderer/main.tsx) 的兜底 handler 当成致命错误调 `showFatal()`，整个窗口被红色全屏面板盖住，必须点 ✕ 才能继续 —— 体验非常糟。

ErrorBoundary 接不住 effect cleanup 中的 throw，所以只能在 window.onerror 这层做白名单。

## 变更内容

### src/renderer/main.tsx
- `window.error` handler 在「跨源脚本错误」白名单后追加一条 monaco 卸载 race 的白名单：用 `/TextModel got disposed before DiffEditorWidget/.test(ev.message)` 命中后只 `console.warn` 留痕，不调 showFatal
- 注释里讲清楚为什么 ErrorBoundary 接不住、为什么不在 TextDiffRenderer 那层修：上游修复或我们换 monaco 加载方式（本地 npm 替 jsdelivr CDN）才是根治，这里只是把 noise 屏蔽掉避免遮挡 UI

## 后续可选

错误根因是 monaco 默认从 `cdn.jsdelivr.net` 加载（@monaco-editor/react 默认行为），而不是用本地 `monaco-editor` 包。把 monaco 本地化能：
1. 让应用真正离线可用（当前断网就没法看 diff）
2. 让 monaco 的版本与 React 包版本严格对齐，可能顺带消除部分 race
但属于独立改动，下次单独立项。
