---
review_id: 32
date: 2026-05-13
plan: deep-review-and-split-20260513
phase: H1
heterogeneous_dual_completed: true
reviewers:
  - reviewer-claude (Opus 4.7 xhigh, teammate)
  - reviewer-codex (gpt-5.5 xhigh, teammate wrapper)
rounds: 1 (跳过反驳轮 — 双方 finding 都有现场实证)
fix_landed_in: changelog/CHANGELOG_80.md
---

# REVIEW_32 — 50 commits 异构对抗 + bug fix 收口（plan deep-review-and-split-20260513 Phase 1）

## 触发场景

用户在新会话主动请求三件事：
1. 「深度 code review 一下最近 50 个 commit」
2. 「针对大文件进行拆分」（6 个 > 500 行源文件）
3. 「lead 被归档后，团队依然存在可见」bug 修复

按 plan deep-review-and-split-20260513 执行：H1 = 修 bug + 跑 deep-code-review SKILL（本 REVIEW），H2-H4 = 拆 6 大文件，H5 = 验证收尾归档。

## 方法

- **执行环境**：worktree `.claude/worktrees/deep-review-and-split-20260513`，base commit `08e0b48`
- **deep-code-review SKILL**：teammate 模式（mcp__agent_deck__spawn_session 起 reviewer-claude + reviewer-codex 各一），focus 1+2 合并一对 reviewer 跑 R1；scope 10 文件（覆盖 R3/R4 backend / MCP 核心 + team-cohesion plan + 本会话 bug fix）；focus 3-5（deep-review-flow plan / bootstrap 修复 / UI 大重构）因本会话 token 偏紧，留 follow-up review 轮次
- **R1 wait_reply 等两份独立 reply**（spawnPromptMessageId 锚点）→ 三态裁决 → fix → typecheck
- **跳过反驳轮**：3 个单方独有 HIGH（HIGH 1/2/3）双方各自给了**实证手段**（reviewer-claude HIGH-1 sqlite3 cli 模拟 + 测试盲区分析，reviewer-codex HIGH-1/HIGH-2 grep + 现场读完整链路），符合 SKILL「✅ 真问题：一方提出且现场实践验证成立」标准

## 三态裁决清单

### ✅ 真问题（修复落地）

| # | 严重度 | 来源 | 文件:行号 | 概要 | 验证手段 |
|---|---|---|---|---|---|
| 1 | HIGH | reviewer-claude | `src/main/agent-deck-mcp/tools.ts:552-568` + `src/main/store/agent-deck-message-repo.ts:335-345` | spawn placeholder `markDelivered` SQL `WHERE status='delivering'` 与 placeholder 真实 status='pending' 不匹配，changes=0 → `findEligible` 命中 → universal-message-watcher 把 wireBody 二次塞进 SDK pendingUserMessages → teammate 跑完首条 prompt 后立刻又收到一份 | sqlite3 cli 模拟（不依赖 ABI）：`INSERT(status='pending')` 后跑生产 markDelivered SQL，changes=0；再跑 findEligible 确认行被命中 |
| 2 | HIGH | reviewer-codex | `src/main/store/agent-deck-team-repo.ts:502-514` | `findSharedActiveTeams` 只看 membership left_at IS NULL，不 JOIN agent_deck_teams.archived_at IS NULL，也不排除 archived session。`last-lead-archived` 自动归档 / 用户主动归档后，成员仍可继续通过 MCP send_message | `rg findSharedActiveTeams` → 只 tools.ts:616 调用，下游无 team archived 校验 |
| 3 | HIGH | reviewer-codex | `src/main/agent-deck-mcp/tools.ts:790-800, 845-862` | `wait_reply` 只按 `reply_to_message_id` 查 replies，nudge timer 入队的 nudge 也使用同一个 `replyToMessageId` 且 `fromSessionId=caller`。带 nudge_text 的 deep review 等待会假成功（lead 拿到自己发出的催促文本当 reviewer reply）| 现场读 tools.ts:787-826，未见 `fromSessionId !== caller` / `fromSessionId === original.toSessionId` 过滤 |
| 4 | HIGH | **用户加** | `src/main/agent-deck-mcp/tools.ts:572-582` | `spawn_session` return shape 没有 `agentName` / `displayName` 字段。caller 传了 agent_name='reviewer-codex' + display_name='reviewer-codex · REVIEW_32 R1 focus 1+2'，但返回 JSON 看不到 → 多组并发 review 时无法区分哪个 teammate 是哪个 agent，必须调 list_sessions/get_session 反查 | Read tools.ts:572-582 直接验证 |
| 5 | HIGH | **用户加 + reviewer-codex 旁证** | `src/main/agent-deck-mcp/tools.ts:230-238 + 451-470` | spawn_session schema 没 `claude_code_sandbox` 字段，且 `permission_mode/codex_sandbox` 不传时不继承 lead → spawn 出的 codex teammate 在受限沙盒里跑不动；reviewer-codex 自承「外层 Claude Code sandbox 拦了 codex in-process app-server 初始化（Operation not permitted），首轮 codex 退出 0 但 OUT 为空；按 sandbox 规则 dangerouslyDisableSandbox 重跑成功」就是这个根因导致首轮失败需 wrapper 兜底 | Read tools.ts schema + reviewer-codex reply 自承 |
| 6 | MED→HIGH（升级 — 与 #1 bug fix 旁路一致性问题）| 双方一致 | `src/main/store/agent-deck-team-repo.ts:553-560` | `setRole` 内的「demote last lead」invariant 校验 SQL 与本次 fix 后的 `countActiveLeads` 不一致：otherLeads 不 JOIN sessions，team 有 lead-A（archived） + lead-B（active），把 lead-B 降级时 otherLeads=1 通过校验 → demote 成功 → countActiveLeads=0 → team 进入 0 active lead 死状态（demote 路径不调 archive 联动；scheduler D7 不识别 archived_at） | sqlite3 cli 直接跑两 SQL 对比 |
| 7 | MED | 双方一致 | `src/main/session/manager.ts:561-585`（本会话刚加的 helper）+ `src/main/store/agent-deck-team-repo.ts:316-330` | `_unarchiveTeamsForRevivedLead` 不区分 archive 来源 — agent_deck_teams 没 `archive_reason` 列，`archive(teamId, _opts)` 的 reason 参数也没持久化。用户主动归档 team T → 归档 lead L → 取消归档 L → T 被悄悄复活（与用户期望反）| 现场读 helper + grep `archive\(` 全代码无 reason 持久化 |
| 9 | HIGH | **用户加** | `src/main/agent-deck-mcp/tools.ts` 7 处 schema | `caller_session_id` 在所有 7 个 tool schema 都是必填 string，但 in-process transport 已经自动 override 真实 session id，caller 传任意占位字符串都被覆盖。**用户体验**：caller 必须传一个无意义的 `__SELF__` 之类的占位 → 体验差 | Read schema 验证 + 之前会话已确认 in-process override 行为 |

### ❌ 反驳证伪 / 不修

无（本轮跳过反驳轮，双方 finding 都有实证）。

### ❓ 单方独有 / 未验证 / Follow-up（写入 follow-up）

详 `§Follow-up` 节。

## 修复条目（按 fix 顺序）

详 [`changelog/CHANGELOG_80.md`](../changelogs/CHANGELOG_80.md) §变更内容 节。9 条 fix 全程跑过中间 typecheck，最终 typecheck 双端通过。

## Follow-up（本会话未修，留 H1.5 / Phase 2 / 后续）

### MED 单方独有（reviewer 报告但本会话未验证修复）

- **MED-claude(fan-out race)** `src/main/agent-deck-mcp/tools.ts:467-476` — `fanOutSlot.release()` 在 try/finally 跑（line 469），紧接着才 `sessionRepo.setSpawnLink`（line 476）。两步之间存在 race window：parallel spawn_session 进 applySpawnGuards 时 inFlightChildren=0（已 release）+ listChildren=oldCount（新 sid 未 setSpawnLink）→ effective 比真实少 1，能突破 maxFanOut + 1
- **MED-claude(D7 ghost)** `src/main/teams/team-lifecycle-scheduler.ts:79-107` — D7 scheduler 只识别 lifecycle='closed' 不识别 archived_at != null。如果 _archiveTeamsIfOrphaned 因任何原因 swallow（lazy import warn / archive 抛 unique 冲突 catch），团队永远 active 状态。修法：scan 内增加 `sess.archivedAt !== null` 也算「session 不在用」
- **MED-claude(placeholder enqueue 失败)** `src/main/agent-deck-mcp/tools.ts:560-568` — placeholder enqueue 失败时只 console.warn，但 prompt 已含 `[msg <id>]` prefix 发出去；teammate 按规约 reply_message → original 找不到 → reply 100% 失败 + lead wait_reply 拿 null 整轮 hang。修法：messageRepo.insert 提到 createSession 之前；失败 → fallback 不含 prefix + spawnPromptMessageId=null
- **MED-codex(send reply teamId 跨污染)** `src/main/agent-deck-mcp/tools.ts:644` — `send_message` 允许手填 `reply_to_message_id` 但只校验 caller/target 共享 team，没反查 original.teamId。错误或恶意 caller 可把 team A 消息挂到 team B reply chain
- **MED-codex(首次 archive 吞事件)** `src/main/teams/universal-message-watcher.ts:230` — `TeamEventDispatcher.lastArchivedAt` 初始为空，第一次收到某 team 的 `agent-deck-team-updated`（即使 active→archived）因 `prev === undefined` 直接 return → active member 收不到 team-archived event

### LOW / INFO（本会话未修，下次 batch 一起清）

- **LOW-claude(lazy import 空操作)** `src/main/session/manager.ts:491,529,563,592` — 4 处 `await import('@main/store/agent-deck-team-repo')` 都是空操作（top-level 已 import）。删掉 4 处 lazy import + 注释
- **LOW-codex(scheduler 无分页)** `src/main/teams/team-lifecycle-scheduler.ts:81` — `list({ activeOnly: true, limit: 200 })` 永远只扫最新 200 个 active team，长期使用后旧 ghost team 累积
- **INFO-claude(cap 隐式语义)** `src/main/store/agent-deck-team-repo.ts:373,390,547` — `MAX_LEADS_PER_TEAM=10` 现在指 active lead 数（archived 不算），membership 表理论无上限。文档化 inline 注释或改 cap 维度
- **INFO-claude(EnqueueMessageInput 漂移)** `src/main/teams/universal-message-watcher.ts:111-121` — `EnqueueMessageInput` 不暴露 `id` 字段，与 `agentDeckMessageRepo.InsertMessageInput.id?` 漂移（spawn_session 直接绕过 watcher 入口调 repo）

### 用户加（HIGH future feature）

- **HIGH 10** `src/renderer/components/SessionDetail/*` + `src/renderer/.../MessagePanel`（待调研定位）— **send_message / reply_message 在对应会话里需要特殊渲染**，跟普通对话发送区分开（lead 通过 send_message 发给 teammate session 时，teammate 视图应区分「来自 lead 的 cross-session message」与「用户直接输入」）。涉及 wire format prefix 利用 + UI chip / icon / 来源标签。需 H1.5 或 Phase 2 拆 renderer 后做
- **HIGH 11**（用户加 future feature）— wait_reply 真异步姿势：加 `check_reply(message_id)` 短查询 API 或 wait_reply `non_blocking: true` 选项，让 lead 调了立刻拿 handle 后续主动 poll，期间能处理其他 user input（当前模式：parallel wait_reply 已支持但 lead 等期间不能从 user 收新 message）

### 反复踩坑候选（写入 conventions/tally.md，本会话最后追加）

**Agent 踩坑候选**：「调 SKILL / 工具前先做不必要的 SSOT discovery」——本次 lead Claude 与上次会话另一个 Claude 都犯：判断要不要走 deep-code-review SKILL 时，跑 `find / -path '*/agent-deck*' -name 'SKILL.md'` / `grep 'deep.code.review'` / `ls /Applications/Agent Deck.app/...` 等多个 Bash 浪费 token + 时间。Skill 工具按 `Skill(skill: 'agent-deck:<name>', args: '...')` 直接 invoke 即可，**不存在会报错**，根本不需要前置存在性确认。

## 关联 changelog

- `changelog/CHANGELOG_80.md`（9 条 fix 全部落地）
- `plans/INDEX.md` / 待 H5 plan 归档时同步

## 备注（本会话超出 plan 范围 / token 消耗）

本会话 H1 原 plan 只规划：
- 修 bug（plan 主线）
- 跑 deep-code-review SKILL R1
- 写 CHANGELOG_80 / REVIEW_32

实际超出 plan 范围扩到 9 条 fix（新增 HIGH 4/5/9 — 用户在 review 期间陆续加的 spawn UX 系列 + caller_session_id schema 优化）。token 消耗较大但稳定通过 typecheck，未引入回归。

H2 cold start 第一步执行 plan §步骤 checklist Phase 2 Step 2.0+（拆 Tier 1 三个文件 tools.ts / agent-deck-team-repo.ts / session-repo.ts），plan 文件路径见 frontmatter `plan` 字段对应的 `~/.claude/plans/piped-fluttering-moth.md`。
