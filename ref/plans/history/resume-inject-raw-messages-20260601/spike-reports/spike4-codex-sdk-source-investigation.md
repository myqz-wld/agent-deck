# Spike 4: codex SDK 源码调查 —— shouldQuery 真相 + 传历史正确姿势（权威结论）

**日期**：2026-06-01
**方法**：spawn 一个 codex session 直接读 `@anthropic-ai/claude-agent-sdk` + `@openai/codex-sdk` 源码（sdk.mjs / sdk.d.ts / index.js / index.d.ts），给 file:line 铁证。**这是 lead 一开始就该做的**——lead 在 SDK 没实现的 shouldQuery 字段上黑盒试了 7 个变体（spike1-3）才被用户点醒「spawn 个 codex 让它查」。

**净结论**：✅ **拼 1 条结构化 user message 是当前 SDK 下传 app DB 文本历史的唯一正确做法。** shouldQuery / SDKUserMessageReplay / 多条 message 全部死路（源码证明）。

## codex 源码铁证（逐条 file:line）

### 1. `shouldQuery` —— TypeScript SDK wrapper 没实现
- 类型 + 注释存在：`sdk.d.ts:3742`（「不触发 assistant turn、合并到下一条 query message」）
- **但 `sdk.mjs` 实现层 `shouldQuery/isReplay` 0 命中**：字段被原样透传给 Claude Code CLI 不处理
- `streamInput` 只是 `for await` 每条 message 后 `JSON.stringify` 写一行到 transport（`sdk.mjs:63`）
- `query` 对 string/AsyncIterable 分流：string 写一条 user JSON，否则调 `streamInput`（`sdk.mjs:115`）
- **判定**：no-op 不是用法姿势问题，是当前 CLI/协议对 SDK stream-json 输入**没兑现这个类型注释的语义**。lead spike1/2 的 num_turns=0 实测与此一致。

### 2. AsyncIterable 多条 message —— 是实时多轮输入流，不是历史注入
- `query` 签名 `string | AsyncIterable<SDKUserMessage>`（`sdk.d.ts:2391`）
- `streamInput` 注释「Used internally for multi-turn conversations」（`sdk.d.ts:2356`）
- SDK 启 CLI 固定加 `--input-format stream-json --output-format stream-json`（`sdk.mjs:60`）
- **判定**：多条 AsyncIterable message 是**实时多轮输入流**（每条独立 user turn），不是「把历史列表一次性注入成上下文」。一次 yield 多条再关流 = 快速送入多条 user turn；保持流开放只影响 stdin 何时关，不会变成 replay/history。lead spike3b 的「多 turn + 中间历史丢」与此一致。

### 3. Claude 历史恢复正确姿势 —— resume + sessionStore（需 raw JSONL）/ 否则拼 1 条文本
- `resume` 注释「Loads the conversation history from the specified session」（`sdk.d.ts:1693`）
- `sessionStore` 是 raw transcript mirror（`sdk.d.ts:1481`）；`load()` 在 SDK parent 把完整 session materialize 成临时 JSONL，子进程用 resume 恢复（`sdk.d.ts:3945`）
- `SessionStoreEntry` 是 opaque JSONL transcript line（`sdk.d.ts:4008`）
- `SDKUserMessageReplay` **不是历史注入 API**：它在 SDKMessage **输出**联合里，`query()` **输入**只接受 SDKUserMessage 不是 Replay；Replay 自带 uuid/session_id/isReplay:true（`sdk.d.ts:3783`）
- **判定**：**DB 里没有 raw Claude JSONL（jsonl 已丢，正是触发本 plan 的原因）→ 正确做法就是拼 1 条结构化 user message。** 不要伪造 SDKUserMessageReplay，不要靠 isSynthetic/tool_use_result/shouldQuery。

### 4. Codex SDK —— 无对等 history injection API
- 输入类型只有 `string | UserInput[]`，`UserInput` 只有 `{type:"text"}` / `{type:"local_image"}`（`index.d.ts:188`）
- `normalizeInput` 把 text entries 用 `\n\n` 拼成一个 prompt（`index.js:120`）
- 恢复只支持 `resumeThread(id)` → CLI `resume <threadId>`（`index.js:223` / `index.js:529`）
- **判定**：codex 端同样二选一——有 `~/.codex/sessions` 线程就 `resumeThread(id)`；内部历史丢了只有 app DB 文本就拼 1 条结构化 prompt。**与 claude 端对称。**

## 对 plan 的最终影响（架构铁证拍板）

- ✅ **拼 1 条结构化 user message** = 当前 SDK 下传 app DB 文本历史的**唯一正确做法**（两端对称）。这不是被 102_400 上限逼的妥协，是 SDK 输入面架构决定的唯一解。
- ❌ **彻底放弃**：shouldQuery（SDK 没实现）/ 多条 AsyncIterable（实时多轮非历史）/ SDKUserMessageReplay（输出类型非输入）。
- ✅ **D3 拼接格式正确**：`[历史回顾]\n用户:...\n助手:...` + 当前消息，正是 spike3 方式A 验证可行 + codex 源码背书的方式。
- ✅ **D6/不变量6 降级链 + 预算式拼接是真实必需**（单条 prompt 物理受 102_400 约束，超长边界兜底），但低频。

## lead 复盘（教训）

1. **该 spike 时跳过 spike** → 用静态分析骗自己，绕 3 轮 review。
2. **引入 shouldQuery 伪需求** → 在 SDK 没实现的字段上黑盒试 7 变体。
3. **该读源码时黑盒试错** → 用户点醒「spawn 个 codex 让它查」才用对方法。
4. **用未验证推断挡用户质疑** → 用户「传列表」直觉从头就对。

**正确工程方法**：不确定 SDK 行为 → 读它的源码（或 spawn agent 读），不要黑盒猜+试。
