# CHANGELOG_258: 会话详情工具入参可点击展开

## 概要

SessionDetail 活动流里的工具展示继续沿用 Claude / Codex 共用的 `tool-use-start` / `tool-use-end` 渲染路径；本次补齐所有工具行的完整入参查看入口，避免 Codex MCP / dynamic tool / Agent 工具只能看到单行摘要。

## 变更内容

- `ToolStartRow` 通用工具、`Task` / `Agent` 特化工具、`ExitPlanMode` 工具都新增「查看入参 / 收起入参」折叠区，点击后按 JSON 展示原始 `toolInput`。
- `ToolEndRow` 也新增入参折叠区：优先从同 `toolUseId` 的 start event 反查 `toolInput`，老事件或 completion payload 自带 `toolInput` 时也能展示。
- 新增 `formatToolInput` helper，入参不可 JSON 序列化时退回字符串，防止展开区异常。
- README 主要能力同步注明工具调用可展开完整入参。

## 验证

- `pnpm exec vitest run src/renderer/components/activity-feed/rows/tool-row.test.tsx src/renderer/components/activity-feed/format.test.ts src/renderer/components/activity-feed/describe.test.ts`
- `pnpm typecheck`
