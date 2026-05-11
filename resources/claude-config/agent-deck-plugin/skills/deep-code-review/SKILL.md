---
name: deep-code-review
description: 深度 code review — 多轮异构 reviewer 对抗 + 三态裁决，把代码变更里的浅层 bug 与深层隐患（race / leak / 边角条件 / 架构耦合 / 安全 / 测试盲区）一轮一轮挖到见底。**通过 mcp__agent_deck__* 5 个 tool 编排**：lead 用 `mcp__agent_deck__spawn_session` 起两个 teammate（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5 wrapper），用 `mcp__agent_deck__send_message` 驱动每轮 review，用 `mcp__agent_deck__wait_reply` 拿结论，lead 自己做交叉裁决，用 `mcp__agent_deck__shutdown_session` 收尾。触发：「深度 code review」/「deep code review」/「双对抗 review」/「review fix 多轮」/「/agent-deck:deep-code-review」/「再 review 一轮」。
---

# Deep Code Review — 多轮异构对抗 review × fix 收口

把「review → fix → review → fix → ... 直到挖不出新问题」封装成可复用流程。重点是**多轮挖深**：第 1 轮抓浅层（typo / null / 错变量），第 2-3 轮挖深层（race / leak / 边角 / 架构 / 测试盲区 / 性能尾延迟）。

> **R3 硬切**：本 SKILL 完全走 `mcp__agent_deck__*` 5 个 tool（spawn_session / send_message / wait_reply / list_sessions / shutdown_session），不再依赖老 Claude Code Agent Teams 内置 `TeamCreate / SendMessage / TeamDelete` builtin 工具。前提：会话挂了 agent-deck-mcp（应用 Settings → Agent Deck MCP server 已启用）。

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

1. 自检：调 `mcp__agent_deck__list_sessions(status_filter:'active')` 确认 agent-deck-mcp 可用；如不可用，告诉用户开启 Settings → Agent Deck MCP server。
2. 拿 `cwd` = 当前仓库绝对路径（lead 自己 `process.cwd()` 或问用户）。
3. 拿待 review scope：从 `git diff` / 文件清单确定（lead 自己 grep / 跑命令）。

### Step 1. 起对（首轮，并发 spawn）

```ts
const teamName = `review-${Date.now()}`;
const teamSpawnedAt = Date.now();   // 用作 wait_reply since_ts 防 race（关键！）

const reviewerClaude = await mcp__agent_deck__spawn_session({
  adapter: 'claude-code',
  cwd: REPO_ABS_PATH,
  prompt: REVIEWER_CLAUDE_PROMPT,   // 包含 scope / focus / skip 项 / 输出格式
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
- 一方独有 + MED → lead 自己 grep / 读代码现场验证 → ✅/❌
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
  timeout_ms: 180_000,           // 3 分钟（反驳轮单点比较快）
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
  text: ROUND_2_PROMPT,   // focus = 边界条件 / 并发 race / 资源 lifecycle
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
| `wait_reply` 超时（默认 60s，重 review 显式 600_000） | timed_out=true 时检查 `events` partial 段。若有部分输出，让 lead 决定：再 send 一条 prompt 催 / abort 该轮 / 增大 timeout 重 wait |
| `send_message` 返回 `no-shared-team` | spawn 时漏传 `team_name`。重新 spawn 一对（带 `team_name`）再走 |
| `send_message` 返回 `ambiguous-team` | caller 被加入了多个 team。显式传 `team_id` 字段 |
| `send_message` 返回 `team-rate-limit-exceeded` | 等 `retryAfterMs` 后重试，或在 Settings 里调高 `mcpMessageRatePerTeamPerMin` |
| 投递 `failed`（adapter 不支持 / session closed） | message status 变 'failed' 后 wait_reply 不会再有 message kind event，lead 通过 `mcp__agent_deck__list_sessions` 查 receiver 状态 |

## 与决策对抗节的关系（用户视角）

`~/.claude/CLAUDE.md`「决策对抗」节的「主路径 subagent」是**单次决策**用 —— 直接 `Task(subagent_type:"reviewer-claude")` 起 subagent 同步等结论，零依赖、启动快。

本 SKILL 是**多轮深度 review** 用 —— 跨轮 context 持久化（teammate session 不被销毁）、反驳轮被反驳方记得自己 R_N 推理链。两条路径都是合法的。深度 review 选 SKILL 路径；单点判定 / plan 评审 / 约定升级走 subagent 即可。

> **三级兜底链**：teammate（本 SKILL 默认）→ subagent（决策对抗节主路径）→ 手动并发（决策对抗节 §Fallback）。每级失败可往下退，但同一场景最优解就一个，不要乱跨级。
