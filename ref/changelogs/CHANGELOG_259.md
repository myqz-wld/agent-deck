# CHANGELOG_259: 数据 tab 显示 provider 额度窗口

## 概要

数据 tab 在模型 token 统计之外，新增 Claude / Codex / Deepseek 三个 provider 的额度窗口区域：Claude 和 Codex 显示当前窗口、周用量和重置时间；Deepseek 因当前走 API 通道，先以“不支持”占位。

## 变更内容

- 新增 `ProviderUsageSnapshot` IPC 契约、preload facade 和 main 端聚合 handler，数据 tab 可一次拉取三家 provider 快照。
- Claude 通过 live SDK query 的 experimental `/usage` control API 读取 5 小时 / 7 天窗口；无可通信 Claude 会话或账号不返回限额时显示暂无。
- Codex 通过 app-server `account/rateLimits/read` 读取 primary / secondary rate-limit window，并归一化 reset 时间。
- Deepseek adapter 返回 unsupported 占位，明确当前 API 通道不支持读取订阅窗口。
- DataPanel 顶部新增“额度窗口”展示区，60 秒刷新一次，不影响原实时 token/s、今日汇总和每日明细。
- README 主要能力同步补充数据 tab 的 provider 额度窗口说明。

## 验证

- `pnpm exec vitest run src/main/adapters/__tests__/provider-usage.test.ts`
- `pnpm typecheck`
