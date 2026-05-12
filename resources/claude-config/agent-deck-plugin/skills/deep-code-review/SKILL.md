---
name: deep-code-review
description: 深度 code review — 多轮异构 reviewer 对抗 + 三态裁决，把代码变更里的浅层 bug 与深层隐患（race / leak / 边角条件 / 架构耦合 / 安全 / 测试盲区）一轮一轮挖到见底。**通过 mcp__agent_deck__* 6 个 tool 编排**：lead 用 `mcp__agent_deck__spawn_session` 起两个 teammate（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5 wrapper），用 `mcp__agent_deck__send_message` 驱动每轮 review，用 `mcp__agent_deck__wait_reply` 拿结论，需要时用 `mcp__agent_deck__list_sessions(spawned_by_filter)` / `mcp__agent_deck__get_session` 探测 teammate 状态，lead 自己做交叉裁决，用 `mcp__agent_deck__shutdown_session` 收尾。触发：「深度 code review」/「deep code review」/「双对抗 review」/「review fix 多轮」/「/agent-deck:deep-code-review」/「再 review 一轮」。
---

# Deep Code Review — 多轮异构对抗 review × fix 收口

把「review → fix → review → fix → ... 直到挖不出新问题」封装成可复用流程。重点是**多轮挖深**：第 1 轮抓浅层（typo / null / 错变量），第 2-3 轮挖深层（race / leak / 边角 / 架构 / 测试盲区 / 性能尾延迟）。

> **前提**：会话挂了 agent-deck-mcp（应用 Settings → Agent Deck MCP server 已启用）。本 SKILL 完全走 `mcp__agent_deck__*` 6 个 tool（spawn_session / send_message / wait_reply / list_sessions / get_session / shutdown_session）编排。

## 何时用

- 关键路径 / 核心抽象的代码变更（multi-client / 并发 / lifecycle / 资源管理）
- 跨多模块、影响主链路（≥ 200 行 / ≥ 5 文件）
- MR 提交前最后一道闸门
- **不适合**：trivial 改动（typo / 单点 rename / 显然措辞修订）— 一轮人审就够

## 核心设计

### 异构对抗

每轮**必须**两个 reviewer 同时起；初轮 spawn，**后续轮次复用同一对**（send_message 不重新 spawn）：

| Reviewer A | Reviewer B |
|---|---|
| `reviewer-claude` teammate（claude-code adapter，Opus 4.7 xhigh） | `reviewer-codex` teammate（claude-code adapter wrapper，内部 Bash 跑外部 codex CLI gpt-5.5 xhigh） |

两个 teammate 完全独立（互不知道对方存在）。**lead 自己**做三态裁决，不让 teammate 既当 reviewer 又当裁判。

> **不要**两个 Claude 自己 review — 同源 = findings 重叠、盲区也重叠。`reviewer-codex` 失败时**严禁降级**到同源双 Claude（teammate body 内已有失败模板，lead 收到后通知用户决策）。

### 多轮挖深

| 轮次 | focus | 期待 finding |
|---|---|---|
| Round 1 | 修复正确性 / 是否引新问题 / 测试质量 | 浅层 bug、API 误用、明显 regression |
| Round 2 | 边界条件 / 并发 race / 资源 lifecycle | race window、cleanup 漏 path、状态机边角 |
| Round 3 | 架构耦合 / 安全 / 性能尾延迟 | 跨模块隐患、信任边界破坏、p95/p99 异常 |
| Round 4+ | 上轮残留 + 用户特别关注的领域 | 收口或拒合 |

### 三态裁决

- ✅ **真问题**：双方独立提出 / 一方提出且现场实践验证成立（写 test 复现 / grep 调用点 / 读真实代码）→ 必修
- ❌ **反驳**：被对抗或现场核实证伪 → 不修，记反驳依据
- ❓ **部分 / 未验证**：双方角度不同 / 一方提出但纯文本推理（含弱断言）尚未实践验证 → 综合后决定；未验证强制降级非 HIGH

每条**单方独有**：HIGH 候选 → §反驳轮；MED → lead 自己 grep / 读代码；LOW/INFO → 直接列 ❓。**不接受没验证的 ✅ HIGH**。

### 收口 / 拒合

**收口**（全部满足）：双 reviewer 都「可合」+ 0 个 HIGH/MED + 上轮真问题已 fix 通过测试。
**拒合**：还有 HIGH 未修 / 双方仍发现 ≥ 5 条新真问题 / 用户主动停。

## 执行模板

### Step 0. 初始化（lead 自己）

1. 拿 `cwd` = 当前仓库绝对路径（lead 自己 `process.cwd()` 或问用户）。
2. 拿待 review scope：从 `git diff` / 文件清单确定（lead 自己 grep / 跑命令）。

> 不需要预先 `list_sessions` 探活：spawn_session 失败本身会返回明确错误（如 tool not found / mcp 未启用），按错误提示去 Settings → Agent Deck MCP server 开启即可。多一次 list_sessions 只是多一次 RTT，不带来决策信息。

### Step 0.5 worktree 场景适配（必读）

如果 lead 当前在 worktree 内（`pwd` 含 `.claude/worktrees/<plan-id>/`，按全局 CLAUDE.md「复杂 plan：worktree 隔离」节进入），下面所有 `REPO_ABS_PATH` 与 `cwd` 一律取 **worktree 路径**（即 `git rev-parse --show-toplevel` 或 `pwd` 结果，含 `.claude/worktrees/<plan-id>/`），**不得**换成主仓库根级路径。

- **反例**：`REPO_ABS_PATH = /Users/.../main-repo`（不含 worktree 前缀） → reviewer cwd 切到主仓库 → reviewer Read 看到的是 main 分支版本，**错过 worktree 内待 review 的 fix** → reviewer 给「fix 已正确」假阳性 → 三态裁决全走偏，整轮 review 跑空。
- **同理**：scope 中给 reviewer 的文件路径也用 worktree 内绝对路径（`<worktree-abs-path>/src/foo.ts`），不要写主仓库根级形态。
- **lead 收到 reply 后必校验**：抽样检查 finding 里 `文件:行号` 的路径前缀含 `.claude/worktrees/<plan-id>/`；命中主仓库根级形态 = spawn cwd 或 scope 路径写错，本轮 finding 全部作废，shutdown + 重 spawn + 重发 prompt 重跑。
- **reviewer 端兜底**：reviewer-claude.md / reviewer-codex.md「核心纪律」节有 worktree 自检条，scope 路径与 spawn cwd 不一致时 reply 顶部硬性输出 `⚠ SCOPE PATH MISMATCH ...` 并 abort，lead 收到此 warn 立即按上一条流程重发。

### Step 1. 起对（首轮，并发 spawn）

```ts
const teamName = `review-${Date.now()}`;
const teamSpawnedAt = Date.now();   // 用作 wait_reply since_ts 防 race（关键！）

const reviewerClaude = await mcp__agent_deck__spawn_session({
  adapter: 'claude-code',
  cwd: REPO_ABS_PATH,
  prompt: REVIEWER_CLAUDE_PROMPT,   // 必带 output_mode: full_review + scope / focus / skip / 输出格式（output_mode 是 reviewer 内部分支必需，详 reviewer-{claude,codex}.md「输入识别」节）
  team_name: teamName,
});

const reviewerCodex = await mcp__agent_deck__spawn_session({
  adapter: 'claude-code',           // reviewer-codex agent 自己内部 Bash 调外部 codex CLI
  cwd: REPO_ABS_PATH,
  prompt: REVIEWER_CODEX_PROMPT,
  team_name: teamName,
});
```

**关键**：两个 spawn 在同一 `mcp__agent_deck__spawn_session` 调用之间不要等 reply；先 spawn 完再 wait_reply。

### Step 2. 等首轮结论

```ts
const [claudeReply, codexReply] = await Promise.all([
  mcp__agent_deck__wait_reply({
    session_id: reviewerClaude.sessionId,
    until: 'turn_complete',
    timeout_ms: 600_000,           // 10 分钟，重 review 给足时间
    since_ts: teamSpawnedAt - 5000, // 防 race window：buffer 5s
  }),
  mcp__agent_deck__wait_reply({
    session_id: reviewerCodex.sessionId,
    until: 'turn_complete',
    timeout_ms: 600_000,
    since_ts: teamSpawnedAt - 5000,
  }),
]);
```

> **since_ts 防 race**（必读）：`teamSpawnedAt - 5000` 给 5 秒 buffer。reviewer adapter event 的 ts 可能比 wait_reply handler 注册更早到达——若 since_ts 用 `teamSpawnedAt`，event 已经先触发但 wait_reply handler 还没起 listener，会被 baselineTs 过滤掉，永远拿不到真 reply。-5000 buffer 让 backfill 兜底拉历史段。

### Step 3. lead 三态裁决

```
逐条对比 claudeReply.events 与 codexReply.events 中的 message text（reviewer 输出的 finding 列表）：

- 双方一致 → ✅ 真问题
- 一方独有 + HIGH → §Step 4 反驳轮
- 一方独有 + MED → lead 自己用 **Grep tool**（不是 Bash grep，详全局 CLAUDE.md「Using your tools」节）/ Read tool 现场验证 → ✅/❌
- 一方独有 + LOW/INFO → 直接列 ❓
- 双方都说没问题 → 该轮 0 finding，进 §Step 5 收口判定
```

### Step 4. 反驳轮（仅 HIGH 单方独有）

```ts
// 把 reviewer-claude 提的 HIGH 给 reviewer-codex 反驳；reverse 同理
const sendResp = await mcp__agent_deck__send_message({
  session_id: reviewerCodex.sessionId,
  text: REBUTTAL_PROMPT_FOR_CLAUDE_FINDING_X,  // 限定单点；明禁借机提其他 finding
  // 单 team 共享时可省 team_id；多 team 共享时必填
});

const codexRebuttal = await mcp__agent_deck__wait_reply({
  session_id: reviewerCodex.sessionId,
  until: 'turn_complete',
  timeout_ms: 600_000,           // 10 分钟（reviewer-codex 内部跑外部 codex CLI xhigh，单点反驳也走完 reasoning effort 全流程，3-10 分钟；reviewer-claude 反驳走 Opus 直接回，可降到 180_000）
  since_ts: sendResp.sentAt - 5000,  // 用 send_message 返回的 sentAt
});

// 反驳后 lead 推到 ✅ / ❌ / ❓
// 同一条 finding 只反驳一次，避免循环
// 反驳后还不行 → lead 自己 grep / 写小 test 现场验证 → 还不行降级非 HIGH
```

### Step 5. fix → 下一轮

lead 根据 ✅ 列表自己改代码（或跟用户确认）。改完后**复用同一对 teammate** 进入下一轮：

```ts
const round2SentAt = Date.now();
await mcp__agent_deck__send_message({
  session_id: reviewerClaude.sessionId,
  text: ROUND_2_PROMPT,   // 必带：output_mode: full_review / focus = 边界条件 / 并发 race / 资源 lifecycle / skip = 上轮 ✅ 已 fix 的 finding 摘要（避免 reviewer 重复列同样 finding 浪费 token —— 详 reviewer-codex.md 反模式表「Round 2+ 没把上轮 codex 输出塞 skip」）
});
await mcp__agent_deck__send_message({
  session_id: reviewerCodex.sessionId,
  text: ROUND_2_PROMPT,
});
const [r2Claude, r2Codex] = await Promise.all([
  mcp__agent_deck__wait_reply({
    session_id: reviewerClaude.sessionId,
    until: 'turn_complete',
    timeout_ms: 600_000,
    since_ts: round2SentAt - 5000,
  }),
  mcp__agent_deck__wait_reply({
    session_id: reviewerCodex.sessionId,
    until: 'turn_complete',
    timeout_ms: 600_000,
    since_ts: round2SentAt - 5000,
  }),
]);
// 重复 §Step 3-5 直到收口
```

### Step 6. 收尾（shutdown 两 teammate）

```ts
await Promise.all([
  mcp__agent_deck__shutdown_session({ session_id: reviewerClaude.sessionId }),
  mcp__agent_deck__shutdown_session({ session_id: reviewerCodex.sessionId }),
]);
```

> shutdown_session 不删历史 events / file_changes / summaries（仅 lifecycle='closed' + abort SDK live query），lead 仍可在裁决报告里引用。

## 强制约束（reviewer-* agent body 已强制；lead 收到 reply 后**再**校验）

- 每条 finding 必须带 `文件:行号` + 代码 / 原文片段 + **验证手段**（如「grep 出 3 处全无 null check」/「写 stateful mock 模拟双 disconnect 实测 abort 0 次」）
- 空泛 finding + 没验证 = 直接降 ❓ 或 ❌
- **不接受没验证的 ✅ HIGH**
- 弱断言关键词（"可能 / 也许 / 看起来 / 应该 / 大概"）只允许出现在标注 *未验证* 的条目里
- 最终清单标注被反驳 / 升降级条目

## 失败兜底

| 失败场景 | 处理 |
|---|---|
| `reviewer-codex` teammate 内部 codex CLI 不可用（二进制缺失 / OAuth 过期 / 超时） | reviewer-codex agent body 已自带失败模板（输出格式见 reviewer-codex.md）。lead 收到后**严禁**降级到同源双 Claude，必须告诉用户决策：等恢复 / 单方 reviewer-claude 出结论 / 稍后重试 / abort |
| **reviewer-* teammate 报「FRESH SESSION — in-memory state empty」信号**（reply 顶部硬约束行） | teammate SDK 会话被自动重启过（典型：CLI 隐式 fork / jsonl hard-fail 走 fallback createSession 不带 resume / 跨长 idle 后通道断），in-memory mental model（reviewer-claude 已读文件 + 推理链 / reviewer-codex 上轮 finding skip 拼接）全丢。**严禁**继续假装 Round N+1 跑（codex 重复列同样 finding 浪费 token / claude 全部重读浪费 turn 又拿不到上轮推理链）。**正确姿势**：`mcp__agent_deck__shutdown_session` 收掉这个 fresh teammate → `mcp__agent_deck__spawn_session` 重新起一对（reviewer-claude + reviewer-codex 同时起，保持异构） → 按当前 scope（lead 自己累积的 fix 状态）发 **Round 1 init prompt 全量重跑**（不要继续 Round N+1，从头开始；之前的 finding 库 lead 在自己 context 里仍可引用做对比，新一轮拿到的是「fresh 视角的当前状态 review」） |
| `wait_reply` 超时（默认 60s，重 review 显式 600_000） | timed_out=true 时检查 `events` partial 段。若有部分输出，让 lead 决定：再 send 一条 prompt 催 / abort 该轮 / 增大 timeout 重 wait |
| `send_message` 返回 `no-shared-team` | spawn 时漏传 `team_name`。重新 spawn 一对（带 `team_name`）再走 |
| `send_message` 返回 `ambiguous-team` | caller 被加入了多个 team。显式传 `team_id` 字段 |
| `send_message` 返回 `team-rate-limit-exceeded` | 等 `retryAfterMs` 后重试，或在 Settings 里调高 `mcpMessageRatePerTeamPerMin` |
| 投递 `failed`（adapter 不支持 / session closed） | message status 变 'failed' 后 wait_reply 不会再有 message kind event。lead 已持有 spawn_session 返回的 sessionId，调 `mcp__agent_deck__get_session(session_id:'<receiver_sid>')` 直接拿 lifecycle / lastEventAt 判断 receiver 是否 closed；多 receiver 救火可用 `mcp__agent_deck__list_sessions(spawned_by_filter:'<lead_self_sid>', status_filter:'all')` 一把拉自己 spawn 的全部 children |
| lead context 重置 / 重启后想捡起 stranded reviewer | `mcp__agent_deck__list_sessions(spawned_by_filter:'<old_lead_sid>', status_filter:'active')` 拉自己以前 spawn 的 active reviewer；按 sessionId 走原 send_message / wait_reply / shutdown_session 流程 |

## 与决策对抗节的关系（用户视角）

本 SKILL 是**多轮深度 review × fix × 反驳轮**编排，**必走 teammate**（mcp__agent_deck__* 6 tool）—— 跨轮 context 持久化（teammate SDK session 不被 lead shutdown 之前一直活）、反驳轮被反驳方记得自己 R_N 推理链 / 已读文件 mental model。

全局 CLAUDE.md（`~/.claude/CLAUDE.md` 或应用注入的 `resources/claude-config/CLAUDE.md`，两者内容同步）「决策对抗」节的**单次决策对抗**（单点判定 / plan 评审 / 约定升级）走「双 Bash 直接起外部 CLI」即可（`zsh -i -l -c "claude -p '<reviewer-claude prompt>'"` 与 `zsh -i -l -c "codex exec ..."` 同 message 并发）—— 简单、零 SDK 状态、不引混用陷阱。

> **不要混用**：单次决策对抗别用 SKILL（teammate 编排开销大无收益）；多轮 review 别走单 Bash 一次性起（fresh per turn 丢 in-memory state，反驳轮没自己上轮推理链 → 反驳质量崩；Round 2+ 没上轮 finding 当 skip → codex 重复列同样 finding 浪费 token）。两个场景两个姿势，不存在「兜底链」。
