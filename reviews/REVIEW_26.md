---
review_id: 26
reviewed_at: 2026-05-12
expired: false
skipped_expired: []
---

# REVIEW_26: AskUserQuestion / ExitPlanMode 在活动流被错误显示为「失败」

## 触发场景

用户截图反馈：AskUserQuestion 已经在 UI 答完（下方 AskRow 显示「✅ 已回答」），但同一会话上方仍出现一条红框 ToolEndRow「AskUserQuestion 失败」并附带「用户已通过 UI 选择，请把以下回答视为他们对这次 AskUserQuestion 的回复，继续按用户意图执行：…」。

## 方法

**单方现场实证**（trivial 范围、根因明确，未走双对抗）：
- 直接顺 `git log` + grep 字面文案 `用户已通过` 锁定来源 `src/main/adapters/claude-code/sdk-bridge/can-use-tool.ts:142`
- 顺 SDK 翻译 `src/main/adapters/claude-code/sdk-bridge/sdk-message-translate.ts:122` 锁定 `is_error → status='failed'`
- 顺 UI `src/renderer/components/activity-feed/rows/tool-row.tsx:171` 锁定 `isFailed = p.status === 'failed' || ...` 渲染红框
- 顺 `git show da7f2243` 锁定回归 commit：`feat(codex,ui): A1 打开 item.updated 增量 + tool-use-end 跨 adapter status`（CHANGELOG_61 §A1，2026-05-11 落地）

**范围**：

```text
src/renderer/components/activity-feed/index.tsx       (ActivityRow 分支)
```

**机器可读范围**：

```review-scope
src/renderer/components/activity-feed/index.tsx
```

## 三态裁决结果

### ✅ 真问题

| # | 严重度 | 文件:行号 | 问题 | 验证手段 |
|---|---|---|---|---|
| 1 | HIGH | `src/main/adapters/claude-code/sdk-bridge/can-use-tool.ts:139-145` ↔ `sdk-bridge/sdk-message-translate.ts:122` ↔ `activity-feed/rows/tool-row.tsx:171` | AskUserQuestion / ExitPlanMode 用 `behavior: 'deny' + message` 把用户答案 / 决策注回 SDK 是协议级**正常**完成；CLI 把它打成 `tool_result is_error: true`，translate 翻成 `status='failed'`，ToolEndRow 渲染红色「失败」。同一调用其实由 AskRow / ExitPlanRow 已完整呈现「问什么 + 答了什么 + 状态」，再叠一条「失败」属误导 + 信息冗余 | 现场读 3 处源码字面 + `git show da7f2243` 复盘 diff 与回归 commit 时间线吻合（同一 commit 同步引入 translate 端 status 翻译 + ToolEndRow `isFailed` 渲染分支）；对照 ExitPlanMode 的 4 档分支（approve→allow / approve+plan→deny / approve-bypass→deny+interrupt / keep-planning→deny）确认大部分分支同样会被误判 |

### ❌ 反驳 / ❓ 部分 / 未验证

无（范围窄、根因单线、修法机械）。

## 修复

### HIGH-1：SDK 通道下隐藏 AskUserQuestion / ExitPlanMode 的 tool-use-start / tool-use-end

`src/renderer/components/activity-feed/index.tsx` 的 `ActivityRow` 在 `tool-use-start` / `tool-use-end` 两个分支前置判断：当 `event.source === 'sdk'` 且 `toolName ∈ {AskUserQuestion, ExitPlanMode}` 时直接 `return null`。

理由：
- 这两个工具走的是协议级 deny+message 注答 / 注决策路径，UI 端已有专用 AskRow / ExitPlanRow（来自 `waiting-for-user` 事件）完整渲染所有信息（问题 + 选项 + 用户已答 / Claude 留在 plan / 已切档 / 已被取消）
- `ToolStartRow` / `ToolEndRow` 这两条事件是 SDK 协议副产品，重复渲染只制造视觉噪声
- **不动 hook 通道**：`source !== 'sdk'`（即 hook / 外部 CLI 路径）拿不到 canUseTool 通路，也不会有 AskRow / ExitPlanRow，必须保留 ToolStartRow 才能显示 plan 文本（参考 tool-row.tsx:36-57 ExitPlanMode 的 hook fallback 渲染）
- 修法仅动渲染分发，不动 SDK 翻译层（is_error=true 是 SDK 上行的事实，不该在 translate 层撒谎），分层干净

副作用 = 0：
- 不影响其他工具（Bash/Edit/Read/...）的失败渲染（保留 da7f224 引入的红框失败提示给真工具）
- 不影响 hook 通道（外部 CLI）的 ExitPlanMode 显示 plan 文本
- `ActivityRow` 返回类型从 `JSX.Element` 改为 `JSX.Element | null`，React 在 `<ol>` 列表里对 null 自然跳过

## 验证

- `pnpm typecheck` 通过

## 关联 changelog

无（review 内直接落地，未引入新功能；只是修同 commit `da7f2243` (CHANGELOG_61 §A1) 引入的 UI 回归）。
