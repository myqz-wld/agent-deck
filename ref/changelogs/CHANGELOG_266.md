# CHANGELOG_266: UI 文案用户化 + Codex reasoning summary

## 概要

面向用户优化设置、资产库、活动流和数据 tab 的展示文案，减少 `provider`、`app-server`、`developerInstructions`、`file transport` 等实现细节暴露，让提示更接近日常使用语境。同时修正 Codex 侧 reasoning summary 没有被请求/汇总时 UI 完全没有 thinking 的问题。

Codex thinking 仍只展示 Codex 返回的 reasoning summary；原始 reasoning text delta 不展示，也不会伪造占位内容。

## 变更

- 活动流 thinking 标签调整为 `REASONING SUMMARY`，空内容提示改为 `No reasoning summary for this turn`；团队事件 badge 使用 `THINKING`。
- Codex live session 默认请求 `model_reasoning_summary = "auto"`，并在 app-server 通过 `summaryTextDelta` 流式返回摘要时汇总到 completed reasoning item。
- 数据 tab 的额度读取、实时输出速率、空状态和错误提示改为用户可理解文案，统一使用 `token/s`。
- 设置里的总结模型来源改为友好标签；日志级别、Thinking level 和 issue 严重度保留 `INFO` / `DEBUG`、`LOW` / `MEDIUM` 这类常见枚举名。
- 资产库和 Codex 应用约定说明去掉 `developerInstructions` / `app-server` 等实现词，改为「随新建会话自动加载」。
- Claude / Codex / Deepseek 额度读取不可用提示统一为面向用户的短句。
- README 同步更新设置、资产库、日志和数据 tab 说明。

## 验证

- `pnpm exec vitest run src/main/adapters/codex-cli/app-server/translate.test.ts src/main/adapters/codex-cli/app-server/client.test.ts src/main/adapters/codex-cli/sdk-bridge/__tests__/thread-options-builder.test.ts src/main/adapters/codex-cli/__tests__/usage-snapshot.test.ts src/renderer/components/__tests__/DataPanel.test.tsx src/main/adapters/__tests__/provider-usage.test.ts`
- `pnpm typecheck`
