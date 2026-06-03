# Spike: Claude Agent SDK partial messages 实时 tok/s 可行性

> 日期 2026-06-03 · SDK `@anthropic-ai/claude-agent-sdk@0.3.160` · node v24.10.0 · runner.mjs + case-*.log 同目录

## 动机

现状 tok/s「不够实时」三层根因：① 采集 message 帧级（turn 进行中数值完全不动）② 60s 窗口平均 ③ 2.5s 轮询。
评估「方案 1：开 `includePartialMessages` 在 turn 进行中算实时速率」前，需实测 SDK 行为定型——走「精确 delta」还是「文本估算」。

## 假设（spike 前）

- H1：开 partial 后 `message_delta` 在 turn 进行中**连续高频**发送，带累计 `output_tokens` → 可做精确实时 delta。
- H2：完整 `type:'assistant'` + `type:'result'` 帧照常来（partial 叠加非替代）→ 现有统计原样不动。

## 实测命令

```
zsh -i -l -c "cd <spike-dir> && unset ELECTRON_RUN_AS_NODE && node runner.mjs"              # 默认 opus thinking-max
zsh -i -l -c "... SPIKE_MODEL=haiku node runner.mjs"                                          # haiku 非 thinking
zsh -i -l -c "... SPIKE_MODEL=sonnet node runner.mjs"                                         # sonnet thinking-high
```

prompt 固定：「逐条写 1~30 中文数字大写 + 简短说明，不用工具」。鉴权走 keychain（service `Claude Code-credentials`），SDK spawn 的 CLI 子进程自读，无需手动注入。

## 实测结果（铁证）

| case | model | 总耗时 | output_tokens | stream_event | **message_delta** | **text_delta** | text_delta 间隔 |
|---|---|---|---|---|---|---|---|
| A（首跑） | opus thinking-max | 50.6s | 1020 | 6 | 0 | 0 | n/a（冷启动抖动，见下） |
| A2（重跑） | opus thinking-max | 32.1s | 1095 | 38 | **1** | 24 | avg 942ms (366~1232) |
| B | haiku-4-5（非 thinking） | 11.3s | 1441 | 285 | **1** | 166 | **avg 22ms** (0~256) |
| C | sonnet thinking-high | 25.1s | 1379 | 339 | **1** | 267 | avg 73ms (0~3738) |

原始 `stream_event.event.type` 直方图（B/C 同形态）：
`message_start:1, content_block_start:N, content_block_delta:多, content_block_stop:N, message_delta:1, message_stop:1`

`content_block_delta.delta.type` 直方图：`text_delta` + `thinking_delta`(+`signature_delta:1`)。

## 结论

### 1. 假设 H1 **推翻**：`message_delta` 不是流式增量源

三模型一致——`message_delta` **整个 turn 只发 1 次**，出现在末尾（紧贴 message_stop），`output_tokens` 直接是最终累计值（1441 / 1095 / 1379）。
**Anthropic 原生 streaming API 每个 delta 都带累计 usage 的行为，被 Claude Code CLI 这一层吃掉了**——只透传最后一帧。故「用 message_delta 做 turn 内精确实时 token 计数」**不可行**。

#### 1b. 补测（spike3）：堵上「只测了短输出」的盲区 —— 长输出下 message_delta 仍只发 1 次

> 质疑：spike1 的 prompt 太短（≤1441 tok / ≤11s），可能根本没触发 Anthropic SSE 对长生成的**周期性** message_delta。若长输出下 message_delta 多发，则可用累计 output_tokens **差分**算精确实时速率（不用文本估算）。

`runner-long.mjs`（1~100 中文数字 + 文化典故，逼出超长输出）实测 haiku：

```
[  4186] message_start input=10 output=1
[ 41819] *** message_delta #1  out=4704  Δout=+4704  gap=0ms  stop=end_turn   ← 总耗时 41840ms
[ 41824] RESULT subtype=success ...outputTokens:4704...
对比 text_delta: 发送次数 = 1329   间隔 = avg=27ms min=0ms max=1128ms
裁决: ❌ message_delta 仍只 1 次 → spike1 结论成立，走文本估算
```

**即使 4704 token / 41.8s 的长生成，`message_delta` 仍然只发 1 次**（41819ms，紧贴末尾），带最终累计 4704。证明单发**不是短输出的偶然**，而是 Claude Code CLI 层把所有中间 `message_delta` 帧**结构性吃掉**只透传最后一帧。

**对「流式能否拿到每个包的新增 token」的最终回答（双向否定）**：
- 高频包 `text_delta`（1329 帧 @ 27ms）—— 协议层就**不带** usage 字段（Anthropic SSE 定义文本增量包里没有 token 计数，非 CLI 所为）
- 带 token 的包 `message_delta` —— 被 CLI 压成 turn 末 1 帧，turn 内**取不到中间值**

→ 经此 CLI 通道（`@anthropic-ai/claude-agent-sdk`），**SDK 层确实无法逐包拿到新增 token**。唯一绕过路径是抛开 CLI 直连 Anthropic raw API（`@anthropic-ai/sdk`），但那会绕过本 app 赖以为生的 CLI 鉴权 / session / tooling 全套基建，不在本方案范围。**故方案锁定「文本估算·末尾校准」。**

### 2. 真正的高频实时源是 `content_block_delta`（text_delta）

- haiku：166 帧 @ **avg 22ms** — 极跟手。
- sonnet：267 帧 @ avg 73ms — 跟手（max 3738ms 是 thinking→text 切换的单点间隙）。
- opus thinking-max：24 帧 @ avg 942ms — **稀疏**（thinking 占大头，文本输出本身就慢且少）。

`text_delta` 帧**不带 usage**，只有文本内容。要用它做 tok/s 必须**按文本估算 token**（`≈ chars/4` 或更精细的 tokenizer 近似）。

### 3. 假设 H2 **确认**：完整帧照常来

三 case 均 `assistant` 2 帧 + `result` 1 帧（带完整 `modelUsage`）。partial 是**纯叠加**。
→ 现有 message 帧级统计 + DB max-merge 去重逻辑**一个字节不用动**，partial 走独立展示旁路即可。

### 4. 关键边界：thinking 模型下文本 delta 稀疏

opus thinking-max 真实场景下大量时间在 thinking（`thinking_delta`），`text_delta` 稀疏（avg ~1s）。
但 **thinking 本身也消耗 output token**，且 `thinking_delta` 频率不低（opus 6 次 / sonnet 62 次 / haiku 111 次）。若实时指示要反映「模型正在干活」，应把 `thinking_delta` 也计入字节估算，而非只数 text_delta——否则 thinking 阶段进度条仍是死的。

### 5. case A 首跑反常说明

首跑仅 6 events / 0 text_delta / 50s，A2 重跑 38 events 正常。归因：进程冷启动 + CLI 子进程首次拉起 + 缓存未热（cacheRead=17077 表明二跑吃到缓存）。**非稳定行为，不影响结论**；但提示实时 UI 需容忍「首帧延迟数秒才有数据」。

## 对方案的影响（定型）

| 方案 1 变体 | spike 裁决 |
|---|---|
| ~~精确 delta（message_delta 累计差分）~~ | ❌ **毙**——message_delta turn 内只发 1 次，拿不到中间值 |
| **文本估算（content_block_delta 字节 ÷ 耗时）** | ✅ **采纳**——text_delta + thinking_delta 高频，按 `bytes/4` 估算瞬时速率，turn 结束用 result 帧 `modelUsage` 精确值校正 |

**推荐实时方案（文本估算变体）**：
1. `query-options-builder` 加 `includePartialMessages: true`。
2. `sdk-message-translate` 加 `stream_event` 分支：累计 text_delta + thinking_delta 的字符数 + 时间戳，**不入 token_usage 表**，走新 IPC 通道（如 `token-stream-tick`）throttle（~200~500ms）push 给 renderer。
3. renderer 维护一个「当前活跃 turn 的瞬时速率」展示态：`估算token ≈ 累计chars/4`，`tok/s = Δtoken / Δt`；turn 结束（result 帧）切回精确口径或清零。
4. 历史统计（topToday / daily / 60s rates）继续走现有 message 帧级精确链路，**完全不动**。

## 残留风险

- **chars/4 估算误差**：中文 token 密度与英文不同（中文常 1~2 char/token），`/4` 偏英文。展示态可接受（只要趋势对、量级对），精确值有 result 帧兜底。**调参项**：中文为主可调 `/2`。
- **thinking 模型展示稀疏**：opus thinking-max text_delta avg ~1s，纯文本估算的瞬时速率会一跳一跳。缓解：计入 thinking_delta + 短 EMA 平滑。
- **IPC 量**：haiku 285 events/turn，多 session 并发时需在 main 侧 throttle 后再 push（不要每 delta 一次 IPC）。
- **首帧延迟**：冷启动数秒无数据，UI 需有「计算中」中间态而非显示 0。
- **partial 仅 claude adapter**：codex adapter 无此机制，实时 tok/s 是 claude-only 能力，UI 需对 codex session 退化到现有 60s 窗口。
