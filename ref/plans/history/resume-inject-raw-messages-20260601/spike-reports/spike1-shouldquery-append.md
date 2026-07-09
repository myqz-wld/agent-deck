# Spike 1: claude-agent-sdk `shouldQuery:false` 逐条 append 历史机制实测

**日期**：2026-06-01
**动机**：plan `resume-inject-raw-messages-20260601` 原架构把「总结+30条历史」拼进单条首条 prompt，撞 `MAX_MESSAGE_LENGTH=102_400` 上限，派生 cap/降级链/beforeId 一整套复杂度（deep-review 3 轮都在这上面打磨）。用户连续质疑「直接送列表消息不行吗，有这么麻烦吗」。查 SDK 类型定义发现 `SDKUserMessage.shouldQuery?: boolean` 字段，注释：「When false, the message is appended to the transcript without triggering an assistant turn. It will be merged into the next user message that does query.」+ `message: MessageParam`（role 可为 'assistant'）。若此机制运行时成立 → 推翻整套拼接架构，改逐条 append（无 cap/无降级/无 beforeId）。

**结论先行**：⚠️ **假设推翻**。`query({prompt: AsyncIterable<SDKUserMessage>})` 路径下，`shouldQuery: false` **不是**「append 不触发回应」，而是**让整个 query 静默 no-op**（`num_turns=0` / `result=""` / 0 API 调用）。注释描述的「merged into next」行为在 `query()` 一次性入口**未生效**（疑似仅 `streamInput` 长连接模式才生效）。

## 假设

- **H1**：AsyncIterable 送多条 SDKUserMessage，`shouldQuery:false` 的不触发 assistant turn
- **H2**：`message.role` 可为 'assistant'（assistant 历史用真实 role 送）
- **H3**：最后一条 `shouldQuery:true` 触发回应，且能看到前面 append 的历史

## 实测命令

```bash
zsh -i -l -c "npx tsx .claude/plans/resume-inject-raw-messages-20260601/spike-reports/spike1<X>-runner.ts"
```

6 个变体 runner（spike1*-runner.ts）+ 对应 .log。

## 实测结果

| 变体 | 配置 | num_turns | 历史可见 | 关键观察 |
|---|---|---|---|---|
| **baseline (d)** | 单条 `string` prompt | **1** ✅ | n/a | OAuth 鉴权完全通，SDK 正常工作，`result="测试成功"`。隔离证明：runner 写法没问题 |
| **b/原始** | AsyncIterable 含 `role:'assistant'` 那条 | exit 1 | — | 起了 system event 后退出（assistant-role 消息或被 reject） |
| **c** | AsyncIterable 3 条，末条显式 `shouldQuery:true`，前 2 条 `false` | **0** ❌ | false | `num_turns=0 result=""`，**0 次 API 调用** |
| **e** | 同 c + 保持流开放 3s | **0** ❌ | false | 保持流开放无效，仍 num_turns=0 |
| **f** | 多条 user message **全不设 shouldQuery** | **1** ✅ | **true** ✅ | `asstTurns=2`，Claude 回「好的小明我记住了」——**看到了历史「小明」**，但把末条也当陈述没回答问题 |

## 铁证分析

1. **`shouldQuery:false` 是 num_turns=0 的元凶**（c/e vs f 对照）：唯一变量就是 shouldQuery。设了 false → 0 turns 静默 no-op；不设 → 正常 1 turn 且历史可见。注释承诺的「append without triggering, merged into next」在 `query({prompt})` 入口**不成立**。
2. **多条 user message 本身可行**（f）：AsyncIterable 送多条 user-role message，SDK 会逐条进 transcript，后续消息能看到前面的内容（「小明」可见）。但每条 user message 都可能触发一次 assistant turn（f 出现 asstTurns=2）。
3. **assistant-role 作为 SDKUserMessage 送存疑**（b exit 1）：`message:MessageParam` 类型上支持 role:'assistant'，但运行时变体 b 异常退出，未隔离确认是否因 assistant role。

## 对 plan 的影响（design 决策更新）

- ❌ **逐条 append（shouldQuery:false）架构在 `query({prompt})` 路径不可行** —— 这是用户期望的「最干净」方案，但 SDK 当前版本此入口不支持。要用得改 `streamInput` 长连接模式 + 大改 createSession 流程（远超本 plan scope，且 streamInput 行为未验证）。
- ⚠️ **多条 user message（不设 shouldQuery，变体 f）半可行但有副作用**：历史可见 ✅，但每条触发 assistant turn（fresh 会话启动刷一堆逐条回应），且 assistant 历史无法以 assistant role 干净送（只能都塞 user role → 语义仍是「用户复述了整段对话」）。**这正是之前推断「拆多条语义错乱」的实测确认**——推断方向对，只是机制细节（不是 shouldQuery 而是 turn 触发）不同。
- ✅ **回归单条拼接架构**：spike 证明「逐条注入」要么不工作（shouldQuery:false）要么有副作用（多 turn）。**单条 prompt 拼接（总结+历史列表+当前消息）仍是当前 SDK 下最稳的注入方式**，回到 deep-review R1-R3 打磨的方案。

## 残留风险 / 未验证

- `streamInput(stream)` 模式（sdk.d.ts:2361）的 shouldQuery 行为**未测**（本 spike 只测 `query({prompt})` 入口）。若未来要逐条 append，需单独 spike streamInput。
- 变体 b 的 assistant-role 异常退出**未隔离根因**（是 assistant role 不被接受，还是其他）。单条拼接架构不依赖此，故不深究。
- codex SDK 对等机制**未测**（codex 端注入仍走单条 prompt 拼接，与 claude 对称）。

## 净结论

**用户的「直接送列表」直觉在理想层面对，但当前 SDK 版本的 `query({prompt})` 入口不支持干净的逐条 append（shouldQuery:false 静默 no-op / 多条触发多 turn + assistant role 存疑）。** 回归单条拼接架构（deep-review R1-R3 方案），但 spike 证明了一个重要简化依据 → 见下方「架构最终决策」。
