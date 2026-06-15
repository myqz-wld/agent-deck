# CHANGELOG_263: 工具行点击展开入参和出参

## 概要

SessionDetail 活动流里的工具调用去掉单独的「查看入参」按钮，改成更直接的行点击交互：`tool-use-start` 展开入参，`tool-use-end` 展开出参。

## 变更内容

- `ToolStartRow` 新增行级入参展开状态，普通工具、`Task` / `Agent`、`ExitPlanMode` 都通过 start 行左侧三角展开原始 `toolInput`。
- `ToolEndRow` 移除入参折叠区，保留原有 end 行点击展开 `toolResult` / `toolResponse` 的行为。
- 更新活动流工具行单测，覆盖 start 行点击展示入参、end 行点击展示出参，以及「查看入参」按钮已移除。
- README 主要能力同步描述新的 start/end 点击语义。

## 验证

- `pnpm exec vitest run src/renderer/components/activity-feed/rows/tool-row.test.tsx`
- `pnpm typecheck`
