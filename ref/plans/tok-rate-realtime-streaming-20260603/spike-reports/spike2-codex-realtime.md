# Spike 2: codex SDK 实时 tok/s 可行性

> 日期 2026-06-03 · codex SDK `@openai/codex-sdk@0.135.0` · node v24.10.0 · codex-runner*.mjs + codex-case-*.log 同目录
> 背景：spike1 否定了 claude 的精确 delta、确认文本估算可行后，lead 推测 codex 也能走文本估算（需先接上 translate.ts 当前丢弃的 item.updated{agent_message}）。本 spike 实测验证该推测。

## 动机

`translate.ts:23-25 / :317-320` 注释称 codex 会推 `item.updated{agent_message / reasoning}` 文本增量（只是应用层"去重复杂"没转发），又称 `item.updated{command_execution}` 能让 UI 看 stdout 一行行涨。若属实，codex 实时 tok/s 可复用 claude 的文本估算思路。**实测验证这两个假设。**

## 实测命令

```
zsh -i -l -c "... node codex-runner.mjs"        # case A: 1~30 数字大写（read-only）
zsh -i -l -c "... node codex-runner-long.mjs"   # case B: 800 字短文（输出更长，排除"太短来不及发增量"）
zsh -i -l -c "... node codex-runner-cmd.mjs"    # case C: 跑 8 行渐进 stdout 的 shell（验 command_execution 增量）
```

鉴权走 `~/.codex` 已登录态（SDK spawn codex binary 自读，apiKey 不传）。

## 实测结果（三 case 完全一致）

| case | 场景 | item.started | **item.updated** | item.completed | usage 出现 | 文本到达方式 |
|---|---|---|---|---|---|---|
| A | 数字大写 | 0 | **0** | 1（agent_message FINAL 506 字符） | 1（turn.completed） | turn 末一次性全量 |
| B | 800 字短文 | 0 | **0** | 1（FINAL 433 字符） | 1 | turn 末一次性全量 |
| C | shell 8 行渐进 stdout | 1（command_execution） | **0** | 2（command_execution + agent_message） | 1 | 命令 started→completed 两帧，无中间增量 |

event 计数（case A/B）：`thread.started:1, turn.started:1, item.completed:1, turn.completed:1` —— **没有任何 item.started / item.updated**。
case C：`item.started:1（command_execution）, item.completed:2, turn.completed:1` —— **command_execution 也无 item.updated**。

## 结论

### 1. lead 推测 **推翻**：codex SDK 0.135.0 文本完全不发流式增量

- `item.updated{agent_message}` = **0 次**（case A/B 两种长度都 0）。文本只在 turn 跑完后由 `item.completed{agent_message}` **一次性全量吐出**。
- `item.updated{reasoning}` = 0 次。
- usage 只在 `turn.completed` 出现 1 次（印证 `translate.ts:204` 现状，per-turn 增量）。

### 2. `translate.ts` 注释与当前 SDK 行为脱节（附带发现）

注释 `:23-25`「`item.updated{command_execution}` → tool-use-start（UI 实时显示 aggregated_output 增长）」+ `:283-296` 整段描述的"codex 跑 npm test 能看到 stdout 一行行涨"——**在 0.135.0 下不成立**。case C 实测 `command_execution` 0 个 item.updated，命令是 started→completed 两帧，中间无渐进输出。
（注：这是历史 codex SDK 版本行为，升级后被裁；`translateItemUpdated` 函数现在实际收不到任何调用。属独立 follow-up，与本 tok/s 评估正交。）

### 3. codex 实时 tok/s **当前 SDK 无可行数据源**

claude 靠 `content_block_delta`（22~73ms 高频文本流）做估算；**codex 没有任何等价的 turn 内增量帧**——文本、reasoning、命令输出全是 turn 末一次性到达。
→ **codex 实时 tok/s 在 SDK 0.135.0 下做不了**。不是应用层丢弃数据，是 SDK 这一层根本不吐流式增量。

## 最终裁决（合并 spike1 + spike2）

| adapter | turn 内高频增量源 | 实时 tok/s 可行性 |
|---|---|---|
| **claude** | ✅ content_block_delta(text_delta/thinking_delta)，实测 22~73ms | ✅ 文本估算可行 |
| **codex** | ❌ 无任何 turn 内增量（文本/reasoning/命令全 turn 末到达） | ❌ **不可行**，只能维持现有 60s 窗口 |

→ **我之前 spike1 报告里写的「codex 退化到 60s 窗口」结论，方向是对的，但理由当时是推断、现已被实测坐实**：codex 不是"多一步接上文本增量"就能做，而是 SDK 压根不给 turn 内增量。实时 tok/s 注定是 **claude-only 能力**，codex session 的顶栏 tok/s 维持现状（turn 完成才跳一下 + 60s 窗口平均）。

## 对方案的影响

- 实时方案设计为 **claude-only 增强**，UI 需按 `session.adapter` 分流：claude session 显示实时估算速率，codex session 沿用现有 message/turn 帧级 + 60s 窗口。
- 若未来 codex SDK 重新引入 turn 内增量（如恢复 item.updated 流），可对称扩展——但**不纳入当前 plan scope**（无 SDK 支持不预投入）。
- `translate.ts` 注释脱节是独立 follow-up（不影响 tok/s，但误导后续维护者），建议单独修注释 / 清理 `translateItemUpdated` 死代码。
