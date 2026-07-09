# Spike 1 — token usage 数据源与采集点

> 静态 spike：证据来自 ① Claude Agent SDK `sdk.d.ts` + `@anthropic-ai/sdk` BetaMessage/BetaUsage 类型定义 ② Codex SDK `index.d.ts` Usage 类型 ③ 官方 cost-tracking 文档 ④ 现有代码 translate 层。**未烧钱真跑 SDK**（凭据在 macOS keychain 非文件，且类型 + 文档证据已足够闭合，真跑只能再确认一遍同样结论）。

## 动机

需求1（header 实时 token/s）+ 需求2（每模型每天 token）共享同一缺失地基：**token 用量目前几乎没被采集**。
- `sdk-message-translate.ts:146` result 分支只 emit `finished{ok, subtype}`，丢弃了 usage。
- `codex-cli/translate.ts:198` turn.completed emit 了 `usage` 进 finished payload，但下游没持久化。

必须先定「采集点 + 数据语义」，否则两个需求都无源之水。

## 关键假设与验证

### 假设 A：采集点放 assistant message，不放 result message

**实证（SDK 类型铁证）**：
- `SDKAssistantMessage.message: BetaMessage`（sdk.d.ts:2600）
- `BetaMessage`（messages.d.ts:1179）带：
  - `id: string`（line 1185）— 去重锚点
  - `model: MessagesAPI.Model`（line 1242）— **模型名直接可得，免查 session**
  - `usage: BetaUsage`（line 1284）
- `BetaUsage`（messages.d.ts:2352）带：
  - `input_tokens: number`（line 2372）
  - `output_tokens: number`（line 2387）
  - `cache_creation_input_tokens: number | null`（line 2360）
  - `cache_read_input_tokens: number | null`（line 2364）

**结论**：assistant message 自带 `{id, model, usage{input/output/cache}}` 四件套，是最佳采集点。

### 假设 B：assistant message 的 usage 是 per-step（非会话累计）

**实证（官方 cost-tracking 文档）**：
> TypeScript provides per-step token breakdowns on each assistant message (message.message.id, message.message.usage) ... When Claude uses multiple tools in one turn, all messages in that turn share the same ID, so deduplicate by ID to avoid double-counting.

**结论**：
- assistant message usage 是 per-step 增量，**不累计** → 直接累加入库即可，无需 diff 上一次。
- **必须按 message.id 去重**：同一 turn 内多个 tool_use 会拆成多条 assistant message 共享同一 id，重复 usage。去重策略见下。

### 假设 C：result.modelUsage 是「本次 query() 调用」聚合，不能直接用

**实证（官方文档）**：
> each result only reflects the cost of that individual call. The SDK does not provide a session-level total ... accumulate the totals yourself.

agent-deck 用 **streaming input 模式**（单 query() 跨整个会话多 turn，见 stream-processor.ts createUserMessageStream）。文档只覆盖「每次 query() call」语义，**没明确**「streaming 单 query 多 turn 下每个 turn result 是本 turn 还是 query 累计」。

**结论**：避开 result.modelUsage 的语义不确定性，**改用假设 A 的 assistant message 采集**（per-step 语义文档明确），result message 只用于标记 turn 边界（finished）。**这是绕开累计/增量谜题的关键决策**。

### 假设 D：costUSD 是客户端估算，会与账单漂移

**实证（官方文档）**：
> The total_cost_usd and costUSD fields are client-side estimates, not authoritative billing data ... computes them locally from a price table bundled at build time.

**结论**：用户已确认 UI 不展示费用 → 符合现实（估算值不该当账单показ）。DB 仍可采集（assistant message 无 costUSD，仅 result.modelUsage 有；既然不展示，**采集层不引 costUSD**，需求2 只存 input/output/cache）。

### 假设 E：Codex usage 是 per-turn，但不带 model 名

**实证（codex-sdk index.d.ts:118-127）**：
```ts
type Usage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
};
```
- `TurnCompletedEvent.usage: Usage`（turn 粒度，per-turn 增量）
- codex event **不带 model 名** → 从 `sessions.model` 列取（session-finalize.ts 已持久化 codex model）
- codex **无 per-message usage**（只有 turn.completed 一次性给）→ codex 采集点只能是 turn.completed
- codex **无 cache_creation**（只有 cached_input）→ 缺的列存 null/0
- codex `reasoning_output_tokens` 归入 output（GPT reasoning 算输出）

## 实时 token/s 可行性（需求1 + 数据页实时区）

### 假设 F：能否做到「turn 进行中」秒级 token 增量？

**实证**：
- Claude SDK 有 `includePartialMessages?: boolean`（sdk.d.ts:1524）→ 开启后 emit `SDKPartialAssistantMessage{type:'stream_event', event: BetaRawMessageStreamEvent}`（sdk.d.ts:3349）。stream_event 里 `message_delta` 带增量 usage。
- **但**：当前应用 `query-options-builder.ts` **没开** includePartialMessages；开启会让消息流量激增（每个 token delta 一条），冲击现有 translate / event 持久化链路，风险高。
- Codex **无** partial token 流（只有 item.updated 的 aggregated_output 文本增量，不带 token 数）。

**结论（实时性降级决策）**：
- **不开 includePartialMessages**（避免冲击现有事件链 + codex 不对称）。
- 「实时 token/s」定义为：**滑动 60s 窗口内已完成 turn 的 output tokens 总和 ÷ 窗口时长**。turn 完成（assistant message 落库）即刷新。
- 这是「较实时」而非「秒级流式」——符合用户「较实时」措辞。turn 进行中不跳动，turn 一完成立即反映。
- header / 数据页实时区共用同一份窗口聚合值（同源）。

## 最终采集架构

```
┌─ claude-code: translateSdkMessage assistant 分支
│   └─ 提取 message.{id, model, usage} → emit 'token-usage' event {model, input, output, cacheRead, cacheCreation, messageId}
│       去重：internal 维护 seenUsageMessageIds Set（同 id 只采一次）
│
├─ codex-cli: translateCodexEvent turn.completed 分支
│   └─ usage + session.model → emit 'token-usage' event {model, input, output(含reasoning), cacheRead=cached, cacheCreation=0}
│
└─ ingest pipeline 新增第 6 段 persistTokenUsage
    └─ token-usage event → token_usage_repo.record(sessionId, model, tokens, ts)
        → 落 token_usage 明细表（按 ts）
        → renderer 通过 IPC 查：① 今日 Top3（header）② 实时 60s 窗口速率 ③ 每模型每天聚合（数据页）
```

## 残留风险

1. **assistant message 去重跨进程边界**：去重 Set 在 sdk-bridge internal（per-session 内存），session 重启后 Set 清空。但 message.id 全局唯一 + DB 层可加 UNIQUE(message_id) 兜底防重复 record。**采用 DB UNIQUE 兜底**（internal Set 是快路径，DB UNIQUE 是正确性护栏）。
2. **codex 无 model 名依赖 session.model**：若 codex session model 列为 null（用户没显式指定 model，codex 用 config.toml 默认）→ 归到 'codex-default' 占位 bucket。记入 plan 已知踩坑。
3. **实时窗口跨午夜**：60s 窗口纯按 ts 算，与「今日」边界无关，不受午夜影响。但「今日 Top3」按本地日期切分 → 需统一本地 day 边界算法（与需求2 每天聚合共用）。
4. **token/s 用 output 还是 total**：需求1「输出 token/s」→ 用 output_tokens。窗口内 Σoutput ÷ 窗口秒数。
5. **partial messages 未来若要秒级**：includePartialMessages 留作后续独立 plan，本期不碰。
