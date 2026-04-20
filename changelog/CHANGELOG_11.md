# CHANGELOG_11: AskRow 提交按钮显眼化 + 毛玻璃（无 pin）底色加深

## 概要

两个用户体感反馈的小修：

1. **AskUserQuestion 内嵌行点完没反应**——用户点了选项以为会立即提交，实际是 toggle 状态需要再点底部「提交回答」；原按钮 `bg-status-working/30 text-status-working` 透明度低、字色弱、藏在长 form 末尾，用户找不到 / 不确定该怎么提交
2. **毛玻璃默认（无 pin）底色太亮**——背景 `rgba(22, 24, 32, 0.55)` + `backdrop-filter: brightness(1.12) saturate(260%)`：底色透、再被 brightness 拉亮 → 浅色桌面背景下文字看不清楚（用户截图就是这种状态）

## 变更内容

### `src/renderer/components/ActivityFeed.tsx`（AskRow）

- 计算 `answeredCount` / `canSubmit` 把进度信息暴露到 UI
- **header 右侧**加「已选 N/M」+ 醒目「提交回答」按钮（`bg-status-working` 实色 + `text-black font-semibold` + `shadow-sm`），与 CHANGELOG_9 时 PermissionRow「按钮在 header」的风格一致；`disabled={busy || answeredCount === 0}` 避免空提交
- **底部**按钮也升级成同款实色按钮 + 旁边一行进度提示文字（「还有 X 题未选」/「已选满，可提交」），长 form 滚走 header 时底部仍可按
- 没保留「单选立即提交」逻辑：用户反馈是想要明确的提交按钮，所有题型统一一种交互更可预期

### `src/renderer/styles/globals.css`（.frosted-frame 默认态）

- 底色 `rgba(22, 24, 32, 0.55)` → `rgba(12, 14, 20, 0.78)`：色更深、透明度更低，文字底面有更稳定的暗色衬底
- `backdrop-filter` 的 `brightness(1.12)` → `brightness(0.92)`，`saturate(260%)` → `saturate(220%)`：不再把后景「调亮调饱和」，避免浅色桌面穿透后白蒙蒙看不清
- 顶部 radial 高光 + 135° 线性高光的白色透明度都减半（0.12 → 0.08，0.08 → 0.05 等），与新底色对比度匹配
- pin 模式（`[data-pinned='true']`）保持不变 —— 那是「看穿到下方应用」的特意设计，用户没反馈

## 备注

- README 不变：AskUserQuestion / 毛玻璃功能描述层面没变化，只是体感优化
- 「按钮挪到 header 行」的设计已经在 PermissionRow 用过一次（CHANGELOG_9），AskRow 跟齐 —— 「需要用户操作的卡片，主操作按钮统一放 header 右侧」可作为 ActivityFeed 行渲染的隐性约定
