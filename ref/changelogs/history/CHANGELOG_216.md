# CHANGELOG_216 — Codex 侧生成中 tok/s 实时估算

## 变更类型
功能新增

## 涉及文件
- `src/main/adapters/codex-cli/sdk-bridge/live-token-rate.ts`（新建）
- `src/main/adapters/codex-cli/sdk-bridge/types.ts`
- `src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts`

## 背景
Claude 侧已有 `live-token-rate.ts` 实现生成中 tok/s display-only 估算，并在 Header Top3 实时显示。Codex 侧缺少对等实现，导致 Header 无法展示 Codex 会话的实时速率。

## 实现方案

### 核心差异：Codex vs Claude 侧
- Claude 侧：监听 `content_block_delta` 流事件，每次收到文本 delta 直接累加估算。
- Codex 侧：SDK 不暴露单 token streaming；改用 `item.updated{agent_message/reasoning}` 事件，其 `text` 字段是**累积全文**（每次更新更长）。取差值 `text.slice(prevLen)` 得本次增量。

### 新增 `live-token-rate.ts`
- `handleCodexEventForLiveRate(ev, internal, sessionId, now)`：
  - `item.updated{agent_message|reasoning}`：差值得增量文本 → 估算 tokens（CJK/非CJK 混合公式）→ EMA 平滑 → 节流 250ms emit `token-rate-tick`
  - `turn.completed` / `turn.failed`：清估算状态，emit `done: true`
- `clearCodexLiveTokenEstimate(internal, sessionId, now)`：turn 结束 / 用户中断时清 live 条目

### 状态设计
`CodexLiveTokenEstimateState`（加在 `InternalSession` 上）：
- `itemTextLens: Map<string, number>` — 每个 `item.id` 已观测文本长度，支持同 turn 内多条 agent_message 并行增量正确计算
- 其余字段与 Claude 侧 `LiveTokenEstimateState` 对称（bucketKey / estTokensSinceFlush / lastFlushTs / emaTps）

### 接入点
`thread-loop.ts` 事件循环，`translateCodexEvent` 调用前插入 `handleCodexEventForLiveRate`；abort catch 路径（用户中断）调 `clearCodexLiveTokenEstimate`。

## 不变量
- 估算状态完全 display-only，不写 token_usage 表，不影响计费统计
- 任何估算异常全部 swallow（try/catch 全包），不中断事件翻译主流程
- Codex tok/s 数据通过既有 `token-rate-tick` event bus → IPC → renderer `liveBySession` → `HeaderTokenRates` Top3 排名展示，零新 IPC 通道
