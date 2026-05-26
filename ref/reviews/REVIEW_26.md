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

---

## Follow-up（同日补丁，2026-05-12）

### 触发

用户截图反馈：上述修法上线后**新会话**生效（实时事件流），但**刷新窗口 / 切回历史会话**后红框「AskUserQuestion 失败」又出现。复盘发现首次修法对历史事件路径无效。

### 根因（单方现场实证）

`src/main/store/event-repo.ts:5-12` 的 `Row` interface + `rowToEvent`：

```ts
interface Row {
  id: number;
  session_id: string;
  kind: string;
  payload_json: string;
  ts: number;
}
```

events 表 schema **没有 `source` 列**（INSERT 也只写 `session_id, kind, payload_json, ts`，event-repo.ts:28-31）。`window.api.listEvents` 走 IPC 调到 `eventRepo.listForSession` → `rowToEvent` → `event.source === undefined`。

ActivityFeed 重新加载历史事件 → ActivityRow `if (event.source === 'sdk')` 守卫 false → fallthrough 渲染 `<ToolEndRow />` → SDK 通道历史事件的 `payload.status === 'failed'` 命中 ToolEndRow 红框分支 → 「AskUserQuestion 失败」。

### 修法（同样不动 SDK 翻译层 / 不动 schema）

把 ActivityRow 内两处 `event.source === 'sdk'` 守卫替换为父组件已有的 session-level `isSdk` props（`src/renderer/components/activity-feed/index.tsx`）。

**等价性**：`SessionManager.dedupOrClaim`（`src/main/session/manager.ts:196`）保证 SDK 接管的会话所有 hook 通道事件被丢弃，所以 SDK 会话内所有事件都源自 SDK 通道；CLI 会话内所有事件都源自 hook 通道。把 event-level 不可靠字段（events 表不存）替换为 session-level 持久化字段（sessions 表 `source` 列，manager.ts:270 写入）后两者语义等价、且 `isSdk` 在父组件按 sessionRepo upsert 后的 store record 计算 → 不存在「字段丢失」窗口。

副作用 = 0：
- hook 通道 ExitPlanMode 在外部 CLI 会话仍渲染 ToolStartRow plan markdown（isSdk=false 分支保留）
- 真工具（Bash/Edit/Read/...）的失败红框不受影响（toolName 黑名单只含 AskUserQuestion / ExitPlanMode）
- 不动 events 表 schema → 无 migration 风险
- 不动 SDK 翻译层 → `is_error=true` 仍是 SDK 上行事实，分层干净（与 REVIEW_26 主修法选型一致）

### 教训沉淀

「event-level `source` 字段不持久化」是隐藏断层 — REVIEW_26 主修当时单方实证现场代码、`event.source === 'sdk'` 在内存事件流里铁证生效，但漏看 events 表 schema 是否承载该字段。今后**任何依赖 AgentEvent 字段做渲染分发的修法**，必须确认该字段是否在 `event-repo.ts` insert / rowToEvent 路径中被持久化。

**未做更激进的 schema 升级**（在 events 表加 source 列 + migration），原因：
- 渲染层用 isSdk 已经可靠覆盖 100% 场景，schema 升级是过度修法（CLAUDE.md「不要为不可能场景加错误处理」）
- 若未来出现「同一 session 既有 SDK 又有 hook 事件」需要按 event 维度区分的新需求，再做 schema 升级
- 风险换收益不划算：migration 触及全用户 DB（数十万 events 级），rollback 复杂

### 验证

- `pnpm typecheck` 通过
