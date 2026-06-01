# Spike 2: streamInput / streaming-input-mode 下 `shouldQuery:false` 实测

**日期**：2026-06-01
**动机**：spike1 发现 `query({prompt: AsyncIterable})` 一次性入口下 `shouldQuery:false` 静默 no-op。但 SDK `streamInput` 注释「Used internally for multi-turn conversations」+ shouldQuery 注释「merged into the next user message that does query」暗示该机制可能只在 **streaming input mode**（prompt 是持续开放的 AsyncIterable）生效。用户决定再 spike streamInput 确认能否解锁「干净逐条 append」。

**结论先行**：❌ **彻底推翻**。streaming input mode（受控 queue 保持流开放，mirror 现有 `createUserMessageStream` notify 模式）下，`shouldQuery:false` **仍然**让整批 query 静默 no-op（`num_turns=0`）。隔离实验（同 queue 模式去掉 shouldQuery → `num_turns=1` 正常）锁定**唯一变量就是 `shouldQuery:false`**。该字段在本地 claude-agent-sdk + CLI 组合下不实现注释承诺的语义。

## 实测命令

```bash
zsh -i -l -c "npx tsx .claude/plans/resume-inject-raw-messages-20260601/spike-reports/spike2<X>-streaminput.ts"
```

## 实测结果

| 变体 | 配置 | num_turns | 历史可见 | 关键观察 |
|---|---|---|---|---|
| **2 (streamInput)** | 受控 queue 保持流开放 + 2 条 `shouldQuery:false` 历史 + 1 条 `shouldQuery:true` 当前问题 | **0** ❌ | false | `result=""`，0 API 调用。streaming mode 也救不了 shouldQuery:false |
| **2b (隔离)** | 同 queue 模式，**全不设 shouldQuery** | **1** ✅ | **true** ✅ | `asstTurns=2`，第 2 条回应能看到第 1 条历史（小明/旺财都可见）。证明 queue 模式本身正常工作 |

## 铁证分析

1. **`shouldQuery:false` 在所有测试入口（query 一次性 + streaming queue）都静默毒化整批**（spike1-c/e + spike2 vs spike2b）。注释承诺的「appended without triggering, merged into next」**在本地 SDK+CLI 组合不实现**。疑似：① SDK 此字段为未来/特定 CLI 协议预留，本地 CLI 版本未实现；② 需要其他未公开的配合参数。无论哪种，**当前不可用**。
2. **queue 模式连续 user message 可传递上下文**（spike2b）：第 2 条 user message 触发回应时能看到第 1 条。但每条 user message 触发一次 assistant turn（asstTurns=2，第 1 条触发空 turn）→ fresh 会话启动会刷多轮回应，体验差；且 assistant 历史无法以 assistant role 干净送。

## 对 plan 的最终影响

- ❌ **逐条 append（shouldQuery:false）彻底不可行** —— query 一次性入口 + streaming queue 两种模式都实测失败。用户期望的「干净送列表」当前 SDK 版本无法实现。
- ❌ **多条 user message（不设 shouldQuery）虽传递上下文但副作用大**：多 assistant turn（启动刷屏）+ assistant 历史只能塞 user role（语义仍是「用户复述对话」）。不优于单条拼接。
- ✅ **单条 prompt 拼接是当前 SDK 下唯一干净方案**：deep-review R1-R3 打磨的「总结段 + 历史列表 + 当前消息」拼成单条 prompt，spike 实测背书。

## 残留风险 / 未验证

- `shouldQuery` 为何不工作**未深究根因**（SDK 源码 / CLI 协议层）—— 实测「不可用」已足够 plan 决策，不需根因。
- 若未来 SDK 版本实现 shouldQuery 语义 → 可重启本 spike 验证后切「逐条 append」架构（届时删整套拼接复杂度）。当前 plan 注释标记此未来可能性。
- 变体 assistant-role 作为 SDKUserMessage（spike1-b exit 1）未隔离根因 —— 单条拼接不依赖。

## 净结论（架构最终拍板）

**两轮 spike（query 入口 + streamInput）实测铁证：`shouldQuery:false` 逐条 append 在当前 SDK 版本不可用。回归单条 prompt 拼接架构（deep-review R1-R3 方案）。** 用户「直接送列表」的直觉在理想层面成立，但受限于 SDK 当前实现。单条拼接保留：总结段（D7）+ 历史列表预算式拼接（不变量 6，删伪 cap）+ 当前消息 + beforeId 排除（D4）+ 三级降级（D6）。spike 的价值：用实测终结「逐条 vs 单条」反复，给架构铁证地基。
