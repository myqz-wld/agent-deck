---
name: deep-code-review
description: 深度 code review — 多轮异构 reviewer 对抗 + 三态裁决，挖深层 bug（race / leak / 边角 / 架构 / 安全 / 测试盲区）。前提：会话挂了 agent-deck-mcp。触发：「深度 code review」/「deep code review」/「双对抗 review」/「review fix 多轮」/「再 review 一轮」。
---

# Deep Code Review — 多轮异构对抗 review × fix 收口

把「review → fix → review → fix → ... 直到挖不出新问题」封装成可复用流程。重点是**多轮挖深**：第 1 轮抓浅层（typo / null / 错变量），第 2-3 轮挖深层（race / leak / 边角 / 架构 / 测试盲区 / 性能尾延迟）。

> **前提**：会话挂了 agent-deck-mcp（应用 Settings → Agent Deck MCP server 已启用）。本 SKILL 完全走 `mcp__agent-deck__*` 10 个 tool 编排。Backend 协议（spawn 返回 `spawnPromptMessageId` / **check_reply 非阻塞 poll** 按 messageId 锚点 / wire format / shutdown_session 不删数据）SSOT 在应用 CLAUDE.md「Agent Deck Universal Team Backend」节。

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

两个 teammate 完全独立（互不知道对方存在）。**lead 自己**做三态裁决，不让 teammate 既当 reviewer 又当裁判。同源化禁令（不可降级到双 Claude）见 §失败兜底 引用。

### 多轮挖深

| 轮次 | focus | 期待 finding |
|---|---|---|
| Round 1 | 修复正确性 / 是否引新问题 / 测试质量 | 浅层 bug、API 误用、明显 regression |
| Round 2 | 边界条件 / 并发 race / 资源 lifecycle | race window、cleanup 漏 path、状态机边角 |
| Round 3 | 架构耦合 / 安全 / 性能尾延迟 | 跨模块隐患、信任边界破坏、p95/p99 异常 |
| Round 4+ | 上轮残留 + 用户特别关注 | 收口或拒合 |

### 三态裁决

- ✅ **真问题**：双方独立提出 / 一方提出且现场实践验证成立（写 test 复现 / grep 调用点 / 读真实代码）→ 必修
- ❌ **反驳**：被对抗或现场核实证伪 → 不修，记反驳依据
- ❓ **部分 / 未验证**：双方角度不同 / 一方提出但纯文本推理（含弱断言）尚未实践验证 → 综合后决定；未验证强制降级非 HIGH

每条**单方独有**：HIGH 候选 → §Step 4 反驳轮；MED → lead 自己 Grep / Read 现场验证；LOW/INFO → 直接列 ❓。**不接受没验证的 ✅ HIGH**。

### 收口 / 拒合

**收口**（全部满足）：双 reviewer 都「可合」+ 0 个 HIGH/MED + 上轮真问题已 fix 通过测试。
**拒合**：还有 HIGH 未修 / 双方仍发现 ≥ 5 条新真问题 / 用户主动停。

## 执行模板（6 步）

| Step | 动作 | 关键字段 / 等什么 |
|---|---|---|
| 0 | 准备 `cwd`（仓库 / worktree 绝对路径）+ `scope`（从 git diff / 文件清单确定，路径与 cwd 同前缀）| — |
| 1 | 并发 spawn 两 reviewer：`spawn_session({adapter:'claude-code', cwd, prompt, team_name, agent_name, display_name})` × 2，`agent_name='reviewer-claude'` / `'reviewer-codex'`（D1 实施，body 自动注入到 prompt 头）；可选 `display_name`（如 `'reviewer-claude · batch A'`）让 SessionList / TeamDetail / wire prefix 一眼区分多组并行 review，不传则 fallback 到 agent_name | 各拿 `spawnPromptMessageId`，是首轮 reply 锚点；两 spawn 之间不要等 reply |
| 2 | **非阻塞 user-driven poll**：lead 调 `check_reply({message_id: spawnPromptMessageId})` × 两个 reviewer 各一次，立即返回告诉 user「已派 2 个 reviewer 跑 review，UI 实时显示进度，reply 来了或 reviewer 卡了请告诉我；期间你可以随时插话（跳过 X / 优先看 Y / abort 某 reviewer）」。**之后每次 user 发 message 时，lead 在响应前先 check_reply 一遍**两个 reviewer：两个都收到 reply → 进 Step 3；都没 reply → 处理 user message + 决定是否 nudge teammate（详 §lead 必须自己 nudge 兜底）。**严禁** wait_reply（30min 阻塞 user）、`ScheduleWakeup`（仅 /loop dynamic mode 适用）、Bash sleep（阻塞 lead 整个 turn） | 拿两份独立 finding 列表（user-driven 触发，开销零） |
| 3 | 三态裁决：双方一致 → ✅；单方独有 + HIGH → Step 4 反驳轮；单方独有 + MED → lead 自己 Grep/Read 验证；单方独有 + LOW/INFO → 直接列 ❓ | — |
| 4 | 反驳轮（仅 HIGH 单方独有）：`send_message` 把 A 的 finding 给 B 反驳（reverse 同理）→ **同 Step 2 一样 user-driven poll**：调一次 `check_reply({message_id: <send 返回的 messageId>})` 后立即返回告诉 user，下次 user 发 message 时再 check 反驳 reply | 同一条 finding 只反驳一次；反驳后仍不能定 → lead 自己验证；还不行 → 降级非 HIGH |
| 5 | fix → 下一轮：lead 改代码后，**复用同一对** teammate 发 Round 2 prompt（必带 `skip` 字段 = 上轮 ✅ fix 摘要，避免 reviewer 重复列）→ user-driven check_reply poll → 回到 Step 3 直到收口 | — |
| 6 | 收尾：`shutdown_session` × 2 | shutdown 不删 events / messages，lead 仍可在裁决报告里引用 |

**为什么 user-driven check_reply 而非 wait_reply 阻塞 / 也不用 timer 自我调度**（设计取舍，**不要被本能反带回 wait_reply / ScheduleWakeup**）：

- **lead 必须保持对 user 的响应能力**：deep review 跑 30min 是常态，user 看 UI 实时活动可能随时想：「跳过 X 这条 finding 我已经判定不修」/「重点看 race 那条」/「reviewer-codex 那边卡了，先 abort」。wait_reply 期间 lead 完全聋，user 反馈被 SDK input queue 排队到 wait_reply 超时才处理 → 体感「打字了但 agent 没反应」（CHANGELOG_95 反馈来源）
- **lead 不主动 schedule wake，依赖 user 触发 poll**：lead 不用 ScheduleWakeup（限 `/loop dynamic mode` 上下文，本场景非 /loop）/ CronCreate（一次性增加 cron 表达式负担，且 lead schedule 自己 wake 在 GUI 应用没必要）/ Bash sleep（仍阻塞 lead 整个 turn）任何 timer。reviewer SDK 会话的 events 实时推送到 SessionDetail UI —— **user 看 UI 自己判断 reviewer 进度**：reply 来了 user 主动 ping「reviewer 回了，继续」；reply 没来 user 主动 ping「reviewer 卡了吗」；想插话直接说。lead 每次 turn 开头先调 `check_reply` 一遍，有 reply 接 Step 3，没 reply 处理 user message
- **设计依据**：应用 CLAUDE.md `§check_reply` 节明示「lead 自己控 poll 节奏」—— 「自己控」可以是 timer 调度也可以是 user-driven。后者更符合 GUI 应用 + user-in-the-loop 工作流，零依赖额外工具，零浪费空 poll

### lead 必须自己 nudge 兜底（check_reply 不会自动催 reply）

`check_reply` 是纯非阻塞 poll，不像 `wait_reply` 带 `nudge_text + nudge_after_ms` 自动催 reply 字段。如果 teammate 忘了调 `reply_message`（context 满了忘协议 / 卡审批不响应 / 任何形态的「卡死但还活着」），lead 单纯 poll 永远拿不到 reply。

**触发**：user 主动 ping「reviewer 卡了吗」/「进度？」时，lead 顺便判断是否需要 nudge：

- **轻量 nudge**：lead `send_message(teammateSid, '📍 nudge: 我在等你 reply 上一条 review request；完成后请 reply_message 回我；进度需要更多时间也请回一句告知')`，**记下新 send 返回的 `nudgeMessageId`**

  ⚠️ **关键陷阱（reviewer-codex MED2 实测）**：watcher 会给 nudge body 自动注入 `[from <name> @ <adapter>][msg <nudgeId>]\n` wire prefix（`universal-message-watcher.ts:189-199`）。按 `reviewer-{claude,codex}.md` 协议 teammate 强制 regex 抓收到消息**第一个** `[msg ...]` 当 reply_to_message_id → teammate 会 reply nudgeId 而非原 originalId → lead 仅 poll originalId 永远拿不到 reply。

  **修法**：lead 之后**同时 poll 两个 messageId**（伪代码）：
  ```
  const r1 = await check_reply({message_id: originalId});
  if (r1.reply) return r1.reply;            // teammate 真按 original 回
  if (nudgeMessageId) {
    const r2 = await check_reply({message_id: nudgeMessageId});
    if (r2.reply) return r2.reply;          // teammate 按 nudge 回（默认行为）
  }
  // 仍 null → 等下次 user message 触发 poll
  ```
  下一轮（Step 5）lead 用 `send_message` 发新 prompt 时，新 messageId 重新成为「当前 wait 锚点」，旧 originalId / nudgeMessageId 自动作废

- **重 nudge / 升级**（user 连发 ≥ 2-3 次「进度？」+ 两 messageId 都 null + `get_session(teammateSid).lastEventAt` 没动 ≥ 15min）：调 `get_session(teammateSid).lastEventAt` 看 teammate 是否还在动 → 在动 → 告诉 user「reviewer 还在跑只是慢，再等等」；不动 → 走 §失败兜底「`check_reply` 持续返回 `{reply: null}`」recipe（PendingTab 真人介入 / shutdown 重 spawn / 合规兜底）

- **绝不无限 poll**：30min（按 `lastEventAt` 判定 + user 多次 ping 仍无 reply）后 teammate 仍卡死必须 abort 该 reviewer，不要让 lead 在 user 多次 ping 中持续消耗 context

**Prompt 内容约定**（每次 spawn 或 send_message 的 prompt 必带）：
- `output_mode: full_review` 或 `rebuttal`
- `scope`：文件清单（**绝对路径**，与 spawn cwd 同前缀；worktree 内必须含 `.claude/worktrees/<plan-id>/` 前缀，否则 reviewer 会报 `⚠ SCOPE PATH MISMATCH` abort）
- `focus`：本轮重点维度
- `skip`：上轮 ✅ fix 摘要 / 已审过的稳定项
- 输出格式约束（详 reviewer-{claude,codex}.md「输入识别」节）

## 强制约束（lead spot-check 用）

reviewer-* agent body 已强约束 finding 输出契约（文件:行号 + 代码片段 + 验证手段；弱断言只允许出现在 *未验证* 条目里）。lead 收到 reply 后只需抽查：

- 缺文件:行号 / 缺验证手段 → 降 ❓
- 「✅ HIGH」纯文本推理无验证 → 强制降 ❓ 或走反驳轮

## 失败兜底

| 场景 | 处理 |
|---|---|
| reviewer-codex 报失败模板（CLI 不可用 / OAuth 过期 / Bash 卡审批被拒 / timeout）| 通知用户决策（等恢复 / 单方 reviewer-claude 出结论 / 稍后重试 / abort）。**严禁**降级同源双 Claude（同源化破坏异构）。**合规兜底**（仍异构）：lead 自己 Bash `run_in_background: true` + `timeout: 600000` 起外部 codex CLI（按 reviewer-codex.md §codex CLI 调用模板填模板，lead 自己执行而非 wrapper teammate），与 reviewer-claude teammate 仍构成 gpt-5.5 vs Opus 4.7 异构对；reviewer-claude teammate 不动继续按 SKILL 流程跑；lead 拿到独立 codex stdout 后照常做三态裁决。**严禁**让 reviewer-claude teammate 跑一份「codex 视角」补缺（仍是同源化）|
| reviewer-* 报「⚠ FRESH SESSION — in-memory state empty」信号 | teammate 被 SDK 自动重启过，in-memory state 全丢。`shutdown_session` 该 teammate → 重 spawn → 按当前 scope 发 **Round 1 init prompt 全量重跑**（不要继续 Round N+1）|
| reviewer-* 报「⚠ SCOPE PATH MISMATCH」信号 | scope 路径前缀与 spawn cwd 不一致（典型：worktree 场景下 scope 写成主仓库根级形态）。修 scope 路径 → shutdown + 重 spawn + 重发 prompt |
| `check_reply` 持续返回 `{reply: null}`（user 多次 ping 仍无 reply + nudge 后两个 messageId 都 null）| 调 `get_session(teammateSid).lastEventAt` 检查 teammate 是否仍推进：是 → 告诉 user「reviewer 还在跑只是慢，再等等」继续 user-driven poll；否 → teammate 卡审批 / 卡死，提示真人去 PendingTab 处理或走上面合规兜底 |

> 其余 mcp tool error（no-shared-team / ambiguous-team / rate-limit / 投递 failed / 跨会话捡 stranded reviewer）走 mcp tool schema 自描述错误处理；高级救火场景见应用 CLAUDE.md「Agent Deck Universal Team Backend」节。

## 与决策对抗节的关系

本 SKILL = **多轮**深度 review × fix × 反驳轮编排（teammate 模式，跨轮 context 持久化、反驳轮被反驳方有自身上轮推理链）。**单次决策对抗**（单点判定 / plan 评审 / 约定升级）走 `~/.claude/CLAUDE.md`「决策对抗 → 主路径」节**双 Bash 直接起外部 CLI** 即可，零 SDK 状态。两个场景两个姿势，不混用。
