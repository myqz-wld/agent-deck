# CHANGELOG_196: 修复日志查看器 modal 被设置面板裁切（createPortal 脱离 backdrop-filter 祖先链）

## 概要

「设置 → 日志 → 查看日志」弹出的「当天日志」modal 不全屏，被挤压裁切在设置面板矩形内（用户截图：modal 缩成面板宽度的一小条）。根因是 `position: fixed` 的 containing block 陷阱——祖先链里有 `backdrop-filter` 时，后代 `fixed` 不再相对 viewport。改用 `createPortal` 把 modal 渲染到 `document.body`，脱离整条 backdrop-filter + overflow 祖先链，按用户诉求「单独弹窗渲染」。

## 变更内容

### src/renderer/components/settings/sections/LogViewerModal.tsx

- `import { createPortal } from 'react-dom'`，`return` 的 JSX 用 `createPortal(<div className="frosted-frame fixed inset-0 z-[60]…">…, document.body)` 渲染。
- 根因：modal 的祖先链上 `FloatingFrame`（`.frosted-frame`，`backdrop-filter: blur(36px)…`）与 `SettingsDialog` 外层（`backdrop-blur-sm`）都带 `backdrop-filter`。CSS 规范下 `backdrop-filter`（同 `transform` / `filter`）会把后代 `position: fixed` 的 containing block 从 viewport 改成该祖先 → `fixed inset-0` 困在设置面板内，再被 `SettingsDialog` 卡片的 `w-[340px] max-h-[85%] overflow-y-auto` 裁成截图那一条。
- portal 到 `document.body` 是唯一稳妥解：DOM 节点脱离 backdrop-filter 祖先链后 `fixed` 才真正相对 viewport 全屏。z-[60] 不变（高于 SettingsDialog z-40 / ContentViewerModal z-50）。
- 同步修正文件顶部 doc comment：旧注释「`fixed` 逃逸 overflow + 豁免 `.frosted-frame > *:not(.fixed)` 规则」是对根因的误判（globals.css 那条 `:not(.fixed)` 规则只豁免 z-index/relative，挡不住 containing block 被 backdrop-filter 改写），改写为 portal 解法说明。

## 备注

- 同款 `frosted-frame fixed inset-0` 的 `ResolveInNewSessionDialog.tsx` 不受影响：它直接挂在 IssueDetail 顶层、中间无 `overflow` 裁切卡片，containing block 即便被降级到全屏的 FloatingFrame 也碰巧全屏正常。本次只改 LogViewerModal。
- 验证：`pnpm typecheck` 双配置绿（renderer-only 改动，dev 下 HMR 自动推送）。
- 踩坑沉淀：已在 `ref/conventions/tally.md`「Agent 踩坑候选」加一条（`fixed` + `backdrop-filter`/`transform` 祖先的 containing block 陷阱，全屏 overlay 走 createPortal）。
