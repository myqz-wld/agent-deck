# CHANGELOG_270: 自绘下拉列表与生命周期数字框

## 变更

- 新增统一的 `DeckSelect` 自绘下拉控件，用 portal 渲染点击后的选项列表，避免原生 `select` 弹出层无法稳定套用应用样式。
- 将 renderer 里的应用内下拉框替换为 `DeckSelect`，保留关闭态原有尺寸、边框和背景，统一弹出列表的深色背景、hover、选中和禁用态。
- 移除无效的原生 `select option` 全局样式，避免继续依赖浏览器无法保证的菜单渲染。
- 设置页里的数字框隐藏原生加减步进按钮，仅保留直接输入数字；提交时仍沿用原来的整数、最小值和最大值校验。

## 验证

- `rg -n "<select|</select>|select option|select optgroup|option:checked|option:disabled" src/renderer`
- `pnpm typecheck`
- `pnpm build`
