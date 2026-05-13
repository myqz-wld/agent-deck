---
name: deep-code-review
description: 深度 code review — 多轮异构 reviewer 对抗 + 三态裁决，挖深层 bug（race / leak / 边角 / 架构 / 安全 / 测试盲区）。前提：会话挂了 agent-deck-mcp。触发：「深度 code review」/「deep code review」/「双对抗 review」/「review fix 多轮」/「再 review 一轮」。
---

# Deep Code Review — 多轮异构对抗 review × fix 收口

把「review → fix → review → fix → ... 直到挖不出新问题」封装成可复用流程。重点是**多轮挖深**：第 1 轮抓浅层（typo / null / 错变量），第 2-3 轮挖深层（race / leak / 边角 / 架构 / 测试盲区 / 性能尾延迟）。

> **前提**：会话挂了 agent-deck-mcp（应用 Settings → Agent Deck MCP server 已启用）。本 SKILL 走 `mcp__agent-deck__*` tool 编排（核心 3 个：`spawn_session` / `send_message` / `shutdown_session`；救火 4 个：`list_sessions(spawned_by_filter)` / `get_session` / `archive_plan` / `hand_off_session`，跨会话 hand off / lead context 重置后捡回 stranded reviewer 用）。Backend 协议（spawn 返回 `spawnPromptMessageId` / **reply 自动 dispatch 进 lead conversation flow** 无需主动 poll / wire format `[from][msg][sid]` 三段双锚点 / shutdown_session 不删数据）SSOT 在应用 CLAUDE.md「Agent Deck Universal Team Backend」节。

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
| `reviewer-claude` teammate（claude-code adapter，Opus 4.7 default thinking） | `reviewer-codex` teammate（claude-code adapter wrapper，内部 Bash 跑外部 codex CLI gpt-5.5 xhigh） |

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

## 执行模板（7 步）

| Step | 动作 | 关键字段 / 等什么 |
|---|---|---|
| 0 | 准备 `cwd`（仓库 / worktree 绝对路径）+ `scope`（从 git diff / 文件清单确定，路径与 cwd 同前缀）| — |
| 1 | 并发 spawn 两 reviewer：`spawn_session({adapter:'claude-code', cwd, prompt, team_name, agent_name, display_name})` × 2，`agent_name='reviewer-claude'` / `'reviewer-codex'`，body 自动注入到 prompt 头；可选 `display_name`（如 `'reviewer-claude · batch A'`）让 SessionList / TeamDetail / wire prefix 一眼区分多组并行 review，不传则 fallback 到 agent_name | 各拿 `spawnPromptMessageId`，是首轮 reply chain 锚点；两 spawn 之间不要等 reply |
| 2 | **告诉 user**「已派 2 个 reviewer 跑 review，UI 实时显示进度，reply 来了我会自动收到处理；期间你可以随时插话（跳过 X / 优先看 Y / abort 某 reviewer）」**然后等 reply 自动注入**。reviewer 跑完调 `send_message({reply_to_message_id: spawnPromptMessageId, ...})` → universal-message-watcher → adapter.receiveTeammateMessage → adapter.sendMessage → lead SDK emit user-role event with wire prefix `[from <reviewer-name> @ claude-code][msg <id>][sid <reviewer-sid>]\n<finding body>` → lead 自动看到 user message act on it。**lead 不主动 poll** —— UI 上 reply chip ↩ 标识让用户知道这条 user message 是 reviewer 注入而非自己输入 | 两份独立 finding 自动到达 lead conversation；user 也可在 UI 实时看 |
| 3 | 三态裁决：双方一致 → ✅；单方独有 + HIGH → Step 4 反驳轮；单方独有 + MED → lead 自己 Grep/Read 验证；单方独有 + LOW/INFO → 直接列 ❓ | — |
| 4 | 反驳轮（仅 HIGH 单方独有）：`send_message({session_id: B-sid, team_id, text: '<A 的 finding 全文> 请独立反驳', reply_to_message_id: <Round 1 messageId>})` 把 A 的 finding 给 B 反驳（reverse 同理）→ 同 Step 2，等 B 的反驳 reply 自动注入 lead conversation | 同一条 finding 只反驳一次；反驳后仍不能定 → lead 自己验证；还不行 → 降级非 HIGH |
| 5 | fix → 下一轮：lead 改代码后，**复用同一对** teammate 调 `send_message` 发 Round 2 prompt（必带 `skip` 字段 = 上轮 ✅ fix 摘要，每条按格式 `已修：<filepath:line> <一句话改动> (commit <hash>)`，避免 reviewer 重复列）→ 等 reply 自动注入 → 回到 Step 3 直到收口 | — |
| 6 | 收尾：`shutdown_session` × 2 | shutdown 不删 events / messages，lead 仍可在裁决报告里引用。**想几小时后再 R3 复用 reviewer mental model 时不要 shutdown** —— 留着让 lifecycle scheduler 自然 dormant，下次 send_message 会自动 SDK resume 复原对话历史；只有彻底不再用本对 reviewer 才 shutdown（详应用 CLAUDE.md §dormant ≠ 丢 mental model 节） |

> **lead 不阻塞不主动 poll**：reply 与普通 send_message 同款走 adapter dispatch 自动注入 receiver SDK conversation flow → reviewer reply 一到 lead 自动收到一条 user-role message → lead 当作普通 user input 处理 → 自然完成裁决 / 进入下一步。user 在场不在场都正常推进（reply 来了 = lead 自然 turn = 处理一遍）。

### lead 怎么处理 reviewer 卡死（reply 一直不到）

**触发**（任一）：
- user ping「reviewer 卡了吗 / 进度？」时 lead 顺便检查
- spawn 后超过 30min 仍无任何 reviewer reply

**lead 自检步骤**：
1. `get_session(reviewerSid).lastEventAt` 看 reviewer 是否还在推进（recent ts → 还在跑只是慢，告诉 user 再等等；非 recent → 卡死）
2. 如果卡死 → `send_message({session_id: reviewerSid, team_id, text: '📍 nudge: 我在等你 reply 上一条 review request；完成后请 send_message 回我；进度需要更多时间也请回一句告知', reply_to_message_id: <last messageId>})`
3. nudge 后再等 5-10min 看是否 reply 自动注入 lead conversation；仍不动 → 走 §失败兜底「reviewer 持续卡死」recipe（PendingTab 真人介入 / shutdown 重 spawn / 合规兜底）

**绝不无限等**：30min（按 `lastEventAt` 判定 + user 多次 ping 仍无 reply）后 reviewer 仍卡死必须 abort 该 reviewer，不要让 lead 在 user 多次 ping 中持续消耗 context。

**Prompt 内容约定**（每次 spawn 或 send_message 的 prompt 必带）：
- `output_mode: full_review` 或 `rebuttal`
- `scope`：文件清单（**绝对路径**，与 spawn cwd 同前缀；worktree 内必须含 `.claude/worktrees/<plan-id>/` 前缀，否则 reviewer 会报 `⚠ SCOPE PATH MISMATCH` abort）
- `focus`：本轮重点维度
- `skip`：上轮 ✅ fix 摘要 / 已审过的稳定项；每条按格式 `已修：<filepath:line> <一句话改动> (commit <hash>)`（例：`已修：src/foo/bar.ts:42 加 try/catch 兜 promise reject (commit 438a613)`）
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
| reviewer 持续不 reply（user 多次 ping 仍无 reply + lead nudge 后仍无 reply）| 调 `get_session(reviewerSid).lastEventAt` 检查 reviewer 是否仍推进：是 → 告诉 user「reviewer 还在跑只是慢，再等等」；否 → reviewer 卡审批 / 卡死，提示真人去 PendingTab 处理或走上面合规兜底 |

> 其余 mcp tool error（no-shared-team / ambiguous-team / rate-limit / 投递 failed / 跨会话捡 stranded reviewer）走 mcp tool schema 自描述错误处理；高级救火场景见应用 CLAUDE.md「Agent Deck Universal Team Backend」节。

## dormant ≠ 丢 mental model

`dormant` 状态下 reviewer 的 jsonl 仍在 → 下次 `send_message` 自动 SDK resume 复原对话历史，mental model 通过 conversation history 隐式保留。**保留 reviewer 跨轮 mental model 复用就别 shutdown**，让它们自然 dormant；下次 send_message 自动 resume。具体机制 + jsonl 缺失边界详**应用 CLAUDE.md §dormant ≠ 丢 mental model 节**。

## 与决策对抗节的关系

本 SKILL = **多轮**深度 review × fix × 反驳轮编排（teammate 模式，跨轮 context 持久化、反驳轮被反驳方有自身上轮推理链）。**单次决策对抗**（单点判定 / plan 评审 / 约定升级）走 `~/.claude/CLAUDE.md`「决策对抗 → 主路径」节**双 Bash 直接起外部 CLI** 即可，零 SDK 状态。两个场景两个姿势，不混用。
