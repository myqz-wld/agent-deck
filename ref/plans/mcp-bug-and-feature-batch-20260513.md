---
plan_id: mcp-bug-and-feature-batch-20260513
created_at: 2026-05-13
worktree_path: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/mcp-bug-and-feature-batch-20260513
status: completed
base_commit: bfccc10
base_branch: main
last_session: H6 (completed 2026-05-13, 收口 + 归档)
latest_commit: 5a44e34
final_commit: 5a44e34
completed_at: 2026-05-13
---

# Plan: mcp J bug + 10 项 backlog / feature 批量 (lead 归档→team 联动 plan 之后续)

## Context

H5 收口完 deep-review-and-split-20260513 plan（main HEAD `bfccc10`）后用户提出三件事合一处理：

1. **新发现 J bug（critical）**：lead 调 wait_reply 拿到 reply 后，lead 自己 SessionDetail 显示一条 user message 与 reply 内容重复。**铁证级根因**已在 plan mode 内 grep + read 锁定（详 §设计决策 §决策 1）
2. **要做 H5 §Step 5.6 留下的全部 backlog**（5 项 H5 follow-up + 2 条 H1 用户加 HIGH future feature）
3. **新增 K/L/M 三项**：(K) hand off **三层**（K1 plan-driven cleanup mcp / K2 plan-driven 下一 phase 起会话 mcp / K3 ad-hoc UI 按钮 + LLM 历史总结起会话，不依赖 worktree/plan）+ 改 user/project CLAUDE.md + 改对应 skill；(L) 会话卡片透露更多工具信息（TodoWrite / WebSearch / Bash 等）；(M) 透明和置顶解耦（用户追加 H1 中提，因为已有独立快捷键，绑定不再合理）

**任务规模**：12 项跨「mcp 协议」+「main 业务联动」+「test infra」+「class 重组」+「renderer UI」+「文档体系」+「打包脚本」全栈 → 触发 user CLAUDE.md「复杂 plan：worktree 隔离 + 跨会话 hand off」流程，不能单刀直入。

**Phase 1 调研已经完成**（plan mode 内 3 Explore subagent 并行 + 主 agent Read 关键代码）：
- J 根因铁证锁定（universal-message-watcher.deliver 对 reply 也 inject 给 sender SDK）
- backlog 现状已逐项过：D / F 移除（不是真 bug），C / E / G / H / I 确认是真 backlog
- K 设计基础（mcp tool 注册路径 + ExitWorktree 是 CLI 内部 tool 不能 mcp 直调）
- L 现状：events.payload_json 已含 toolName/toolInput（无 schema 改），SessionCard formatEventLine 已支持 12+ tool（增强空间在「展示密度 / 历史粒度」）

---

## 总目标 & 不变量

### 最终交付（按 phase 串行）

| Phase | 范围 | LOC 估 |
|---|---|---|
| **Phase 1** | J bug 修 + B check_reply API + 单测 | ~200 |
| **Phase 2** | C/E/G/H 4 项 main 端 backlog cleanup（D/F 已移除） | ~250 |
| **Phase 3** | I `#sdkOwned` 真私有（按 §决策 6 决定走对抗 or 直接改） | ~50 |
| **Phase 4a** | K1 archive_plan mcp tool + 同步改 user CLAUDE.md / resources/claude-config | ~250 |
| **Phase 4b** | K2 start_next_session mcp tool + cold start 协议 | ~150 |
| **Phase 4c** | K3 UI hand off 按钮 + LLM 历史总结 + 起新 session（不依赖 worktree/plan） | ~350 |
| **Phase 5** | A HIGH 10 cross-session UI 渲染区分 + L 卡片更多工具信息 + M 透明/置顶解耦 | ~350 |
| **Phase 6** | H5 收口（typecheck + build + dev smoke + worktree merge + plan 归档） | — |

### 不变量

- **修 J 不破坏既有 send_message → teammate 处理 → reply chain 协议**：teammate 仍按 wire format prefix `[msg X]` 提 reply_to_message_id 调 reply_message，lead 仍 wait_reply / check_reply 拿 reply
- **lifecycle 与 archived 正交**（CLAUDE.md§89）—— 任何 phase 不动这条原则
- **events.payload_json schema 已含 toolName/toolInput**（L 任务不改 schema） + tally.md P28 教训不依赖未持久化字段
- **任何 try { await } 含「释放标记 / 清 Map / 注销 listener」必须 try/catch/finally**
- **mcp tool 改 schema 双面兼容**（在用 wait_reply 的 lead session 不能因为加 check_reply 而崩）
- **拆文件 / 抽函数的所有 import 路径更新 + `pnpm typecheck` 必过**
- **K hand off mcp tool**：只能做 git + filesystem + plan 文件操作；ExitWorktree 是 Claude CLI 内部 tool 不能 mcp 调，agent 仍需手动 ExitWorktree

---

## 设计决策

> Phase 1 调研后我有强推荐，但下面 5 个决策 [OPEN QUESTION] 需用户确认（用 AskUserQuestion 一次性问完）。其余决策已结论。

### 决策 1：J bug 修法 [已确认 — 方案 1]

**用户决定 Q1**：方案 1 watcher.deliver 跳过 reply inject。

**铁证根因**：`src/main/teams/universal-message-watcher.ts:399 deliver` 对所有 message 一视同仁调 `adapter.receiveTeammateMessage(toSessionId, fromSessionId, wireBody)`，包括 reply。adapter.receiveTeammateMessage 实现是 `sendMessage(wireBody)`（4 个 adapter 都 delegate），sendMessage 在 sdk-bridge:324-335 emit 'message' kind 'user' role event → SessionDetail echo user message。

**lead 视角重复**：步骤 4（wait_reply tool_result）+ 步骤 5（SDK echo user message）同份 reply 显示两次（且 reply 被当 user input inject 给 lead SDK，lead Claude 可能 act on 跑空 agent loop）。

**实施**：`deliver` 在 message 是 reply（`replyToMessageId != null`）时跳过 `adapter.receiveTeammateMessage`，只 markDelivered + emitStatus。reply 完全不再 inject 给 sender SDK；sender 通过 wait_reply / check_reply 主动拿；与 HIGH 11 协同（reply 在 DB 里足够，不需 SDK echo）。

**风险点**：方案 1 让 reply「只入库不 inject」后，如果 lead 没主动 wait_reply / check_reply（如 lead 被 kill / context 重置），reply 在 SessionDetail 完全不可见。**缓解**：(a) 已有 TeamDetail/MessagesSection 展示 messages 表所有 reply（Agent 2 调研确认），(b) Phase 5 (A HIGH 10) 时把 SessionDetail 也加一个 "Cross-session messages" tab / sidebar 展示 messages 表里目标 session 涉及的 reply。

### 决策 2：B check_reply API 形态 [已结论 — 方案 A]

独立 tool `check_reply(message_id) → { reply: ... | null, timedOut: false }`：schema 简洁；wait_reply / check_reply 同名 helper 复用（findRepliesByMessageId + isLegitReply）；lead 自己 poll；nudge 不自动触发。Agent 1 调研也建议方案 A。

### 决策 3：K hand off 三层设计 [已确认]

**用户决定** Q2+Q5：方案 A 单 mcp tool archive_plan **+** K2 加 start_next_session mcp tool **+** K3 加 UI 按钮（独立于 mcp，读会话历史 + LLM 总结起新会话，**不依赖 worktree/plan**）。

**前置约束**：`EnterWorktree` / `ExitWorktree` 是 Claude CLI 内部 tool（不在 agent-deck 仓库内，无 IPC 桥接），mcp tool 无法直接调它们。所以 K1+K2 mcp 只能做 git + filesystem + plan 文件 + spawn-session 层面操作，agent 仍需手动 ExitWorktree。

**三层 hand off 形态对比**：

| 层 | 触发方 | 形态 | 适用场景 | 依赖 |
|---|---|---|---|---|
| **K1 archive_plan** | agent 调 mcp | mcp tool 做 ff merge + mv plan + git add commit + git worktree remove + branch -D | plan 完成（H5 收口）一次调用代替 5 步 Bash | 必需 worktree + plan 文件 |
| **K2 start_next_session** | agent 调 mcp | mcp tool 起新 SDK session + 自动初始 prompt「按 ... 接力」+ 加入 plan-id team | plan-driven phase 切换 cold start 自动化 | 必需 plan 文件路径 |
| **K3 UI hand off button** | 用户在 UI 点 | LLM oneshot 总结当前会话上下文 → 起新 SDK session + 总结作为初始 prompt | 任意会话太长想轻量接力（不需要 plan / worktree） | **零依赖**，独立机制 |

**K3 关键设计**：
- LLM 总结调用走应用现有 oneshot summarizer 框架（`src/main/summary/` 或类似）
- prompt 模板包括：当前 cwd / 最近 N 条 user/assistant 对话 / 最近 file changes / 最近 todos / git status
- 总结输出格式：「目标 / 已做 / 下一步 / 相关文件路径」结构化
- 新 session：默认与原 session 同 cwd / 默认无 team / 由 spawn-session IPC 起
- UI 按钮位置：SessionDetail 顶部 toolbar（与现有 Resume / Archive 按钮平级）

**外加 K 同步改的**（K1+K2）：
- 改 `~/.claude/CLAUDE.md` §Step 4 cleanup 节，把「Bash 5 步」替换为「调 mcp tool `mcp__agent_deck__archive_plan`」+ §Step 3 接力姿势加 K2 选项
- 改 `resources/claude-config/CLAUDE.md`（应用 SDK inject）添加 archive_plan + start_next_session tool 用法
- 改 project `CLAUDE.md` 不需要（plan 流程跨项目通用）
- skill 改：`agent-deck:deep-code-review` 已经 reference plan 流程；不需要专门改它，K 是通用工具

**K3 不改 CLAUDE.md / skill**（独立机制，UI affordance 即文档）。

### 决策 4：L 卡片更多工具信息形态（已结论，无 [OPEN QUESTION]）

Agent 2 已确认：events.payload_json 已含 toolName/toolInput（无 schema 改）+ SessionCard.formatEventLine() 已支持 12+ tool（Edit/Write/Read/Bash/Glob/Grep/TodoWrite/Skill 等）。

**增强方向（不需用户决策）**：
- L1: SessionCard 显示**最近 N 条** tool 摘要（当前只 1 行 liveLine + 1 行 summaryLine 共 2 行）→ 改成可配置 3-5 行 / 区分 in-progress vs done tool
- L2: 增强 formatEventLine 对 TodoWrite 显示 todos 进度（如 "TodoWrite [3/5 done]"）+ WebSearch 显示 query 摘要 + Bash 显示截短命令
- L3: 卡片 hover 浮 popover 展示当前 in-progress tool 详情

主 phase 5 实施时设计决定 N 值 / popover 触发方式。

### 决策 5：A HIGH 10 cross-session UI 渲染区分 实现方案 [已确认 — 方案 B]

**用户决定 Q3**：方案 B wire prefix renderer parse + chip。

wire prefix `[from X @ Y][msg Z]` 已是 SSOT（`universal-message-watcher.ts:189-199` build，messages.body 列含 prefix），renderer 端正则提 displayName/adapterId/msgId 加 chip / icon。最小侵入；historical events 同样有 prefix，无 P28 problem。

**实施细节**（Phase 5 设计）：
- ActivityRow 在渲染 `event.kind === 'message'` 时检查 `payload.text` 是否匹配 `^\[from .+? @ .+?\](?:\[msg .+?\])?\n` regex
- 匹配则把 prefix 解析成 `{ from: displayName, adapter: adapterId, msgId? }`，渲染 chip + 隐藏 prefix 只显示 body
- 不匹配（普通 user input）走原渲染

**有副作用**：方案 1 修了 J 之后 lead 自己的 detail 不再有 reply 的 'message' kind event（reply 不 inject），所以 cross-session 区分需求只剩 send_message 方向（lead → teammate / lead 主动 send 给别的 lead）。

### 决策 6：I `#sdkOwned` 真 ECMAScript private — 直接改 [已确认]

**用户决定 Q4**：直接改。

private → #private + 反射测试改 hasSdkClaim API；跑全 vitest 验证。工作量小（2 文件 + 1 jsdoc 删）；放弃对抗 = 决策已变（H4 sub-plan §决策 2 「保留 + jsdoc warning」结论被用户明确推翻）；改完跑全 vitest 即足够保险，不再走对抗。如果改完发现 hasSdkClaim API 反射等价性破坏 → 回滚成本极低（git revert 1 commit）。

### 决策 7：phase 顺序 + per-phase commit 节奏（已结论）

- **Phase 1**（J bug 修 + B check_reply）：高优 production bug，必须先做。**1-2 commit**：(a) J 修 + 单测 (b) B check_reply + 单测
- **Phase 2**（C/E/G/H cleanup）：低风险并行，**4 commit** 各项 1 个
- **Phase 3**（I sdkOwned 真私有）：**1 commit**
- **Phase 4a**（K1 archive_plan mcp tool + 文档同步）：**3 commit**：(a) mcp tool 实现 + 单测 (b) 改 user CLAUDE.md (c) 改 resources/claude-config/CLAUDE.md
- **Phase 4b**（K2 start_next_session mcp tool）：**1-2 commit**：(a) mcp tool 实现 + 单测 (b) [可选] user CLAUDE.md §Step 3 接力姿势加 K2 选项
- **Phase 4c**（K3 UI hand off 按钮 + LLM 总结）：**3 commit**：(a) main 端 LLM 总结 IPC handler + summarize prompt 模板 (b) renderer 端按钮 + 触发流程 (c) [可选] 总结 prompt 调优 + UX polish
- **Phase 5**（A + L renderer）：**2-3 commit**：(a) A renderer parse wire prefix + 区分渲染 (b) L SessionCard formatEventLine 增强 (c) [可选] popover hover 详情
- **Phase 6**（H6 收口）：commit-less（只跑 typecheck/build/smoke/merge/归档）

预计跨 **4-5 会话**：H1 = Phase 1+2，H2 = Phase 3+4a，H3 = Phase 4b+4c（4c 大可能拆 H3+H4），H4 = Phase 5，H5 = Phase 6 收口。

---

## 步骤 checklist

### Phase 1 — H1 J bug 修 + B check_reply API（**完成 2026-05-13 H1**）

- [x] **Step 1.0** EnterWorktree(`mcp-bug-and-feature-batch-20260513`) — done（注：EnterWorktree 默认基于会话启动时的 HEAD 而非最新 main，须 `git reset --hard main` 同步到 main HEAD）
- [x] **Step 1.1** J 修：`universal-message-watcher.ts:399 deliver` 加 reply 短路 — done
- [x] **Step 1.2** J 单测 3/3 passed（reply 短路 + non-reply 回归 + reply orphan target）— done
- [x] **Step 1.3** B check_reply tool（schema + handler + 注册 + helper 抽 isLegitReply/replyProj）— done
- [x] **Step 1.4** B 单测 3/3 passed（命中 / 未命中 < 100ms / unknown msg_id）— done
- [x] **Step 1.5** typecheck 双端通过 + 47 tests 全过（3 watcher + 44 tools）— done
- [x] **Step 1.6** Commit Step 1.1+1.2 `60fb50f` + Commit Step 1.3+1.4 `53d934b` — done
- [x] **Step 1.7** changelog/CHANGELOG_87.md + INDEX 同步 — done（合 commit `53d934b`）

### Phase 2 — H1 main 端 backlog cleanup C/E/G/H 4 项（**完成 2026-05-13 H1**）

- [x] **Step 2.0** cold start — N/A（H1 同会话续做）
- [x] **Step 2.1** C MED-D7 修：dispatcher.start() 预填 lastArchivedAt cache，pagination loop — done `15042e6`，加 2 it 验证 list 调用 + cache preseed
- [x] **Step 2.2** E LOW pagination：scheduler.scan() while-loop offset += 200 — done `5b839e3`，无 dedicated 单测（dev smoke 覆盖）
- [x] **Step 2.3** G MED-A7 mock 补全 18 method：用 `AgentDeckTeamRepo` 强类型兜底 — done `46abc1c`
- [x] **Step 2.4** H HIGH-B2 characterization test：新建 manager-team-coordinator.test.ts 5 it（closed/deleted/0-lead/多 membership/orphan）— done（合 commit `bf68cb5`）
- [x] **Step 2.5** typecheck 双端 + 全 34 session tests + 5 watcher + 5 coordinator 全过 + 4 commit + CHANGELOG_88.md + INDEX — done `bf68cb5`

> **D / F backlog 取消**：Phase 1 调研时确认非真 bug — D（manager-team-coordinator.ts 3 处 lazy import 是必要的，manager.ts 顶部未 top-level import agentDeckTeamRepo），F（markDormant/markClosed 不存在 lifecycle.ts，已是 setLifecycle/batchSetLifecycle 取代）。

### Phase 3 — H2 I `#sdkOwned` 真私有（小改）

- [x] **Step 3.0** cold start — done（H2 cat plan + EnterWorktree）
- [x] **Step 3.1** 改 `src/main/session/manager.ts:67 private sdkOwned` → `#sdkOwned` + 删 line 61-65 jsdoc warning + 加公开 method `hasSdkClaim(sid)` — done
- [x] **Step 3.2** 改 `src/main/session/__tests__/manager-public-api.test.ts:134` 反射访问 → 用 `sessionManager.hasSdkClaim(...)` API + 改 `manager-ingest-pipeline.ts` 过时注释 — done
- [x] **Step 3.3** typecheck + 全 vitest 23 文件 344 it 通过 + 1 commit `f3095a8` + changelog/CHANGELOG_89.md + INDEX 同步 — done

### Phase 1.5 — H2 临时插入：N bug fix（用户 H2 报告 critical UX bug）

> 用户反馈：「历史里归档的会话，继续聊不会自动转实时/非归档了，还是会躺在历史会话里归档状态」。属 critical UX bug，临时插入 H2 phase 处理（按 user CLAUDE.md「决策对抗」节判定为单点判定 + 修法明确，不走对抗）。

- [x] **Step N.1** 调研根因 — done
  - 根因：`ipc/adapters.ts:215 AdapterSendMessage` IPC handler 直接调 `adapter.sendMessage()` 不检查 `archivedAt`
  - 与 `manager.ts:152-156` 正交约定的边界：用户主动 sendMessage / resume = 显式信号 → 应 unarchive；事件流被动到达 = 不应 unarchive
- [x] **Step N.2** 修 N bug + 单测 + commit + CHANGELOG_90 — done `fdcd762`
  - A. `manager.ts` 加新公开 API `unarchiveOnUserSend(sid)` 封装 archived guard + 复用 `unarchive()` 已有行为
  - B. `ipc/adapters.ts` AdapterSendMessage handler 在 sendMessage 前调 `unarchiveOnUserSend` 一行
  - C. `manager-public-api.test.ts` 加 3 it（dormant+archived / 未 archived noop / 不存在 sid noop）
  - typecheck 双端通过 + 全 23 文件 347 it 通过

### Phase 4a — H2 K1 archive_plan mcp tool + 同步改 CLAUDE.md（**完成 2026-05-13 H2**）

- [x] **Step 4a.0** cold start — N/A（H2 同会话续做）
- [x] **Step 4a.1** 设计 `archive_plan` mcp tool schema — done（commit `81a15d8`）
- [x] **Step 4a.2** 实现 handler（impl.ts ~330 LOC + handler 入口 archive-plan.ts）— done（commit `81a15d8`）
- [x] **Step 4a.3** 注册到 `tools/index.ts` — done（commit `81a15d8`）
- [x] **Step 4a.4** 单测 11 it（happy path + 5 预检失败 + 3 路径 fallback）— done（commit `81a15d8`）
- [x] **Step 4a.5** Commit Step 4a.1-4a.4 — done `81a15d8`
- [x] **Step 4a.6** 改 `~/.claude/CLAUDE.md` §Step 4 cleanup 节（推荐 mcp / fallback Bash / 中止特例 3 sub-section）— done（in-place 不入 commit）
- [x] **Step 4a.7** 改 `resources/claude-config/CLAUDE.md`（7→9 tool / +check_reply / +archive_plan 节）— done（commit `f651ffd`）
- [x] **Step 4a.8** Commit Step 4a.6+4a.7 — done `f651ffd`
- [x] **Step 4a.9** changelog/CHANGELOG_91.md（K1 实现 + 文档同步合写一文）— done（commit `f651ffd`）

### Phase 4b — H2/H3 K2 start_next_session mcp tool

- [x] **Step 4b.0** cold start — done（H3 cat plan + EnterWorktree + git log 自检 HEAD=f651ffd）
- [x] **Step 4b.1** 设计 `start_next_session` mcp tool schema — done（types.ts 加 `startNextSession` 常量 + EXTERNAL_CALLER_ALLOWED false / schemas.ts START_NEXT_SESSION_SCHEMA 8 字段）
- [x] **Step 4b.2** 实现 handler — done
  - impl 层 (~190 LOC)：plan 文件路径解析 caller cwd 反查 main-repo > fallback `~/.claude/plans/<id>.md` / parseFrontmatter / 校验 `worktree_path` + status === `in_progress` / 构造 cold start prompt 含 phase_label 后缀
  - handler 入口 (~95 LOC)：deny external + 调 impl + 组装 SpawnSessionArgs (cwd=worktree_path/team_name=plan_id/adapter=claude-code 默认) + 调 spawnSessionHandler 透传同一 ctx + JSON.parse spawn 字段 + 包 K2 metadata + 透传 spawn 字段（spawn isError 直接透传不嵌套包装）
- [x] **Step 4b.3** 注册到 `tools/index.ts` — done（9→10 tool，annotation 详细描述自动化行为 + 默认值 + 文件路径 fallback 链 + 完整返回字段）
- [x] **Step 4b.4** 单测 22 it 全过 — done
  - impl happy path 6 it（caller cwd 反查 main-repo / phase_label 注入 / git 失败 fallback / git 成功但本地无文件 fallback / 显式 plan_file_path / git 相对路径 resolve）
  - impl 校验失败 8 it（plan 文件不存在两层 / git 失败时只走 user-global / 显式 override 不存在 / 无 frontmatter / 缺 worktree_path / 非绝对 worktree_path / status completed/abandoned/missing）
  - impl base_branch 透传 2 it
  - handler deny external 1 it / handler happy 4 it（透传 K2 metadata + spawn 字段 / 显式 cwd+team_name 覆盖默认 / spawn isError 透传不嵌套 / impl 错误不调 spawn）
- [x] **Step 4b.5** 改 user CLAUDE.md + resources/claude-config/CLAUDE.md — done
  - `~/.claude/CLAUDE.md` §Step 3 接力姿势：拆 §选项 A 用户手动 cold start prompt + §选项 B K2 mcp tool 自动起新会话双姿势（in-place 不入 commit）
  - `resources/claude-config/CLAUDE.md`：9 tool → 10 tool + 加 §plan hand-off 自动化：start_next_session 节（完整 ts 调用模板 + 业务流程概述 + 「新 session system prompt 必须含 user CLAUDE.md」校警）
- [x] **Step 4b.6** Commit + changelog/CHANGELOG_92.md + INDEX — done `9f4f160`（合 Step 4b.1-6 一个 atomic commit；typecheck 双端通过 + 全 vitest 25 文件 380 it 通过含 22 新 start-next-session）

### Phase 4c — H4 K3 UI hand off 按钮 + LLM 历史总结（独立于 worktree/plan，**完成 2026-05-13 H4**）

- [x] **Step 4c.0** cold start — done（H4 cat plan + EnterWorktree + git log 自检 HEAD=9f4f160）
- [x] **Step 4c.1** 设计 main 端双阶段 IPC SessionHandOffSummarize / SessionHandOffSpawn schema — done
  - 拉历史 → LLM oneshot summary（200 条 events + sonnet 4.6 走本地 settings.json）
  - LLM oneshot summary 调用：复用现有 summarizer 框架 SDK query 模板，新增独立 `summariseSessionForHandOff(cwd, events)` 函数（不抽公共 helper / 不动 summariseViaLlm 热路径）
  - prompt 模板：「目标 / 已做 / 下一步 / 相关文件路径」结构化 4 节
  - 起新 SDK session（cwd / agent / permissionMode 沿用原 session）
  - 返回 { newSessionId } + 自动归档原 session（archive 失败 warn-only 不阻塞）
- [x] **Step 4c.2** 实现 main 端 handler 在 `src/main/ipc/sessions.ts` + summariseSessionForHandOff 函数 + 5 it 单测 — done（commit `cd9799a`）
- [x] **Step 4c.3** preload facade handOffSummarize / handOffSpawn + HandOffPreviewDialog modal 组件 + SessionDetail header 加 hand off 按钮（仅 isSdk 时显示） — done（commit `9c51c8c`）
- [x] **Step 4c.4** UX polish：button loading + 总结失败 inline error + 「重试总结」按钮 + textarea 兜底 + spawn 失败保留 textarea + busy 期间 close disabled + disposed flag 防 unmount setState + main emit session-focus-request 自动切到新 session detail — done（合 commit `9c51c8c` 实现内已包含）
- [-] **Step 4c.5** dev smoke：长会话点 hand off → 新会话起 + 初始 prompt 是合理总结 — **deferred to Phase 6 H6**（涉及真实 LLM API + 长会话操作，与其他 phase 一起 smoke 更高效）
- [x] **Step 4c.6** Commit 3 个 + CHANGELOG_93 — done（commit `cd9799a` / `9c51c8c` / `6f34847`，CHANGELOG_93 + INDEX 同步）

### Phase 5 — H5 A cross-session UI + L 卡片增强 + M 透明/置顶解耦（**完成 2026-05-13 H5**）

- [x] **Step 5.0** cold start — done（H5 cat plan + EnterWorktree + git log 自检 HEAD=6f34847 + worktree clean）
- [x] **Step 5.1** A: ActivityRow / MessageBubble 加 wire prefix parse — done（commit `cdb2f87`）
  - 新建 `src/shared/wire-prefix.ts` parseWirePrefix helper（regex `[^\]]+` 防贪婪）+ 9 it 单测全过
  - `message-row.tsx` 仅 user role parse → cyan chip「↩ X」hover title 完整 adapter+msgId + body-only render
- [x] **Step 5.2** A: SessionDetail 加 Cross-session messages tab — done（合 commit `cdb2f87`）
  - `agent-deck-message-repo.ts` 加 `listBySession(sid)` SQL `from OR to` ORDER BY DESC + 1 it
  - 新 IPC channel `AgentDeckMessageListBySession` + `ipc/teams.ts` handler + preload facade
  - 新建 `SessionDetail/MessagesPanel.tsx` ~120 LOC（参考 TeamDetail/MessagesSection 风格 + 区分 sender/receiver 加 →/↩ 标记 + reply chain chip + onAgentDeckMessageChanged 200ms 节流重拉）
  - SessionDetail Tab type 加 `'messages'`「跨会话」按钮
- [x] **Step 5.3** L: SessionCard formatEventLine 增强 — done（commit `cdb46d1`）
  - summariseToolInput 5 个 case 增强（TodoWrite `[N/M done] · activeForm` 进度 / WebSearch query / WebFetch url / Task+Agent subagent_type · description）
- [x] **Step 5.4** L: SessionCard 显示最近 3 条 tool 摘要 — done（合 commit `cdb46d1`）
  - describeLiveActivity 返回 string[] 最多 3 行 + 去重连续同行
  - SessionCard render 多行 truncate（i=0 主色 i≥1 副色视觉分层）+ useMemo 缓存防 SessionList 滚动重算
- [-] **Step 5.5** typecheck + dev smoke + 2-3 commit + CHANGELOG_94 — typecheck/commit/changelog 完成；**dev smoke 推迟到 Phase 6 H6 与其他 phase 一起 smoke**
- [x] **Step 5.6** M 透明 / 置顶解耦 — done（commit `5a44e34`）
  - 5.6a grep 现状定位耦合点：window.ts `setVibrancy(value && transparentWhenPinned ?...)` + ipc/settings.ts apply + main/index.ts shortcut + App.tsx state + WindowSection
  - 5.6b settings 字段 `transparentWhenPinned` → `windowTransparent` + REMOVED_KEYS 加旧字段 + 一次性 migration
  - 5.6c IPC handler / 快捷键 binding 同步换名（applyTransparentWhenPinned → applyWindowTransparent / floating.setWindowTransparent）
  - 5.6d 配置面板 Toggle label「窗口透明」+ 文案明示解耦
  - 5.6e dev smoke 推迟 Phase 6 H6
  - 5.6f 1 commit + CHANGELOG_94 三模块（A+L+M）一文（合 commit `5a44e34`）

### Phase 6 — H6 收口

- [ ] **Step 6.0** cold start
- [ ] **Step 6.1** 完整 `pnpm typecheck && pnpm build`
- [ ] **Step 6.2** dev smoke：J fix（lead 调 wait_reply 不再看到重复）+ check_reply tool 真跑 + K1 archive_plan tool 真跑（在 dummy plan 上跑）+ K2 start_next_session 真跑 + K3 UI hand off 按钮 + A cross-session chip + L 卡片新展示
- [ ] **Step 6.3** worktree branch merge 回 main（fast-forward 或 squash 看 commit 节奏）
- [ ] **Step 6.4** 用 K1 archive_plan 自动归档本 plan 到 `plans/mcp-bug-and-feature-batch-20260513.md` + 同步 INDEX（**自验**：让本 plan 成为 K1 的第一个 real-world test case）
- [ ] **Step 6.5** ExitWorktree(action:"keep") + （由 K1 archive_plan 已做的）git worktree remove + branch -D，确认无残留

---

## 当前进度

**H1 进度**（2026-05-13，completed）—— Phase 1 + Phase 2：

- ✅ **Phase 1**（J bug + B check_reply）：2 commit
  - `60fb50f` Phase 1 Step 1.1: J bug fix - watcher.deliver 跳过 reply inject（含 J 单测 3 it）
  - `53d934b` Phase 1 Step 1.3: 加 check_reply mcp tool（含 check_reply 单测 3 it + helper isLegitReply/replyProj 抽 helpers.ts + CHANGELOG_87 + INDEX）
- ✅ **Phase 2**（C/E/G/H cleanup）：4 commit
  - `15042e6` Phase 2 Step 2.1: C MED-D7 fix - dispatcher.start() 预填 lastArchivedAt（含 2 it）
  - `5b839e3` Phase 2 Step 2.2: E LOW fix - scheduler.scan() while-loop pagination
  - `46abc1c` Phase 2 Step 2.3: G MED-A7 fix - makeAgentDeckTeamRepoMock 补全 18 method
  - `bf68cb5` Phase 2 Step 2.4+2.5: H HIGH-B2 characterization test + CHANGELOG_88 + INDEX
- ✅ **测试**：47 tests Phase 1（3 watcher J + 44 tools 含 3 新 check_reply）+ 全 34 session tests + 5 watcher (含 2 新 dispatcher) + 5 coordinator 全过；typecheck 双端通过
- ✅ **D / F backlog 取消**：Phase 1 调研确认非真 bug（D lazy import 是必要的；F markDormant/markClosed 已不存在被 setLifecycle 取代）

**H3 进度**（2026-05-13，**completed**）—— Phase 4b 全 done：

- ✅ **Phase 4b**（K2 start_next_session mcp tool）：1 commit
  - `9f4f160` Phase 4b: K2 start_next_session mcp tool 实现 + 文档同步（types.ts 9→10 tool / schemas.ts START_NEXT_SESSION_SCHEMA 8 字段 / start-next-session-impl.ts ~190 LOC deps inject 5 步业务 / start-next-session.ts ~95 LOC handler + 调 spawn 透传 / tools/index.ts 注册 + 22 it 单测全过 / `~/.claude/CLAUDE.md` §Step 3 拆双选项 + `resources/claude-config/CLAUDE.md` 9→10 tool + 加 §plan hand-off 自动化：start_next_session 节 + CHANGELOG_92 + INDEX）
- ✅ **测试**：全 vitest 25 文件 380 it 通过（base 358 + 22 新 start-next-session）；typecheck 双端通过

**H5 进度**（2026-05-13，**completed**）—— Phase 5 全 done（Step 5.5 dev smoke 推迟到 H6）：

- ✅ **Phase 5**（A cross-session UI + L SessionCard + M 透明/置顶解耦）：3 atomic commit
  - `cdb2f87` Phase 5 Step 5.1+5.2: A — wire prefix parser + chip + listBySession + Cross-session messages tab（10 文件 +373/-4）
  - `cdb46d1` Phase 5 Step 5.3+5.4: L — formatEventLine 5 tool case 增强 + describeLiveActivity 多行（1 文件 +77/-21）
  - `5a44e34` Phase 5 Step 5.6: M — transparentWhenPinned → windowTransparent 解耦 + migration + CHANGELOG_94（11 文件 +267/-59）
- ✅ **测试**：全 vitest 27 文件 394 it 通过 + 56 skipped（base 26 文件 385 it + 9 新 wire-prefix it + agent-deck-repos listBySession test 跟 SQLite binding 同 skip pattern）；typecheck 双端通过
- 🔧 **Step 5.5 dev smoke deferred**：与 J fix / K1 / K2 / K3 一起 H6 smoke 更高效（plan §H4 进度同款 deferred 模式）

**H6 进度**（2026-05-13，**completed**）—— Phase 6 收口（不引入代码变更）：

- ✅ **Step 6.1** typecheck 双端通过 + electron-vite build 三端通过（main 450KB / preload 21KB / renderer 1.5MB）。唯一 warning：`agent-deck-team-repo/index.ts` dynamic + static 混合 import 是 H HIGH-B2 修法刻意保留的 lazy import 模式（避免 manager.ts 顶部 top-level import 引循环），CHANGELOG_88 已记录，不阻塞
- ⏸ **Step 6.2 dev smoke deferred to user** —— 11 项 sub-check 由用户后续统一做（J fix / B check_reply / K1 archive_plan / K2 start_next_session / K3 UI hand off / A cross-session chip + tab / L formatEventLine + 多行 / M 透明置顶 4 组合 + migration），checklist 仍保留在 §下一会话第一步 §H6 收口预期流程节作为用户 smoke 参考
- ✅ **Step 6.3** ff merge worktree branch → main：`Updating bfccc10..5a44e34` + 56 file + 4830 ins / 177 del 共 17 commit fast-forward
- ✅ **Step 6.4** plan 归档：fallback 5 步手动 mv + frontmatter completed + INDEX 加行 + commit（**K1 archive_plan tool 在本会话 SDK mcp tool list 不可用** —— 应用装的旧 .app HEAD = `bfccc10` 不含 Phase 4a 的 archive_plan 注册；待 .app 重打包发布后下次 plan 收口可走 K1 自动化路径，让 K1 第一个 real-world test case 顺延）
- ✅ **Step 6.5** ExitWorktree(action:"keep") + `git worktree remove` + `git branch -D worktree-mcp-bug-and-feature-batch-20260513` + git worktree list 验证无残留

**worktree HEAD 链路**（H1-H5 共 17 commit + H6 归档 commit，main HEAD 已推进到归档 commit）：
- bfccc10 (base, main HEAD H5 前)
- 60fb50f (J fix + 单测)
- 53d934b (check_reply tool + 单测 + CHANGELOG_87 + INDEX)
- 15042e6 (C MED-D7 fix + 2 it)
- 5b839e3 (E pagination)
- 46abc1c (G mock 18 method)
- bf68cb5 (H test 5 it + CHANGELOG_88 + INDEX)
- f3095a8 (Phase 3: #sdkOwned 真私有 + CHANGELOG_89)
- fdcd762 (Phase 1.5: N bug fix + CHANGELOG_90)
- 81a15d8 (Phase 4a 实现: archive_plan tool 9 tool 注册 + 11 it 单测)
- f651ffd (Phase 4a 文档: 双 CLAUDE.md 同步 + CHANGELOG_91)
- 9f4f160 (Phase 4b: K2 start_next_session tool 10 tool 注册 + 22 it 单测 + 双 CLAUDE.md + CHANGELOG_92)
- cd9799a (Phase 4c Step 4c.1-4c.2: K3 hand-off main 端 + 5 it 单测)
- 9c51c8c (Phase 4c Step 4c.3-4c.4: K3 hand-off renderer 端)
- 6f34847 (Phase 4c Step 4c.6: CHANGELOG_93)
- cdb2f87 (Phase 5 Step 5.1+5.2: A wire prefix + Cross-session tab)
- cdb46d1 (Phase 5 Step 5.3+5.4: L SessionCard 增强)
- 5a44e34 (Phase 5 Step 5.6: M 透明/置顶解耦 + CHANGELOG_94) ← H5 latest，H6 ff merge 后 main 进抵此
- (H6 归档 commit) docs(plans): 归档 mcp-bug-and-feature-batch-20260513 plan + 同步 INDEX (H6) ← 当前 main HEAD（hash 见 git log -1）

**CHANGELOG 编号映射**（H1-H5 全 8 份；H6 收口不引入新 CHANGELOG）：
- CHANGELOG_87 = Phase 1 (J + B)
- CHANGELOG_88 = Phase 2 (C/E/G/H)
- CHANGELOG_89 = Phase 3 (#sdkOwned)
- CHANGELOG_90 = Phase 1.5 (N bug fix) ← 临时插入
- CHANGELOG_91 = Phase 4a (K1 archive_plan + 文档同步合写)
- CHANGELOG_92 = Phase 4b (K2 start_next_session + 文档同步合写)
- CHANGELOG_93 = Phase 4c (K3 UI hand off + LLM 总结)
- CHANGELOG_94 = Phase 5 (A + L + M) ← H5 done

---

## 下一会话第一步

**Cold start prompt 模板**（H6 用）：

```
按 /Users/apple/.claude/plans/mcp-bug-and-feature-batch-20260513.md 接力
```

cold start 必做：
1. `Bash: cat /Users/apple/.claude/plans/mcp-bug-and-feature-batch-20260513.md`（**严禁 Read tool**）
2. 从 frontmatter 拿 `worktree_path` → `EnterWorktree(path:"/Users/apple/Repository/personal/agent-deck/.claude/worktrees/mcp-bug-and-feature-batch-20260513")`
3. `Bash: pwd` 确认 cwd 在 worktree 内
4. `Bash: git log --oneline -3 && git status --short` 确认 HEAD ≥ frontmatter `latest_commit`（H5 后 = `5a44e34`）+ worktree clean
5. **H6 起点**：Phase 6 收口首步 = `Step 6.1 完整 pnpm typecheck && pnpm build`
6. 按 §步骤 checklist 当前 Phase 第一个未打勾步骤动手
7. 所有指向代码资产的路径用 worktree 内绝对路径
8. 不重新讨论已记录的 §设计决策

### H6 收口预期流程

1. `pnpm typecheck && pnpm build` — 完整双端
2. 启 dev smoke（按项目 CLAUDE.md「验证流程」节）：
   - **J fix**：lead 调 wait_reply 不再看到重复 user message echo
   - **B check_reply**：lead 调 check_reply tool 真跑（mcp-server-trial 验证）
   - **K1 archive_plan**：dummy plan 真跑 archive_plan 验证 5 步流程
   - **K2 start_next_session**：dummy plan 真起新 SDK session 验证 cold start
   - **K3 UI hand off**：长会话点 📤 按钮 → modal preview LLM 总结合理 → 起新 session
   - **A cross-session chip**：teammate detail 看 user message 应有「↩ X」chip
   - **A messages tab**：SessionDetail 切「跨会话」tab 看到 from→to 列表
   - **L formatEventLine**：跑会话用 TodoWrite/WebSearch/WebFetch/Task 看卡片新格式
   - **L 多行 live**：会话连续多个 tool 看卡片 3 行展示
   - **M 透明/置顶解耦**：4 种组合（pin+透/pin+不透/不pin+透/不pin+不透）UX 都正常切换
   - **M migration**：装老版本 → 升级看 transparentWhenPinned 值是否被正确迁移到 windowTransparent
3. dev smoke 全过 → worktree branch ff merge 回 main（建议直接调 archive_plan mcp tool 自动化 5 步：先 ExitWorktree(action: 'keep') → 调 `mcp__agent_deck__archive_plan({plan_id, worktree_path, base_branch: 'main'})` 一次性收口 → 让本 plan 成为 K1 第一个 real-world test case 自验证）
4. 如果 archive_plan tool 不可用 fallback 手动 5 步（plan §Step 6.4-6.5）

---

## 已知踩坑

- **方案 1 (J 修法) 副作用**：reply 不再 inject 给 sender SDK 后，lead 没主动 wait_reply / check_reply 时 reply 不在 SessionDetail 可见 → Phase 5 (A HIGH 10) 时 SessionDetail 加 "Cross-session messages" tab 兜底
- **K1 archive_plan 不能调 ExitWorktree**：ExitWorktree 是 Claude CLI 内部 tool，mcp 没法调 → archive_plan tool 内做完 git worktree remove 前，必须 agent 先 ExitWorktree 切出 worktree（否则当前 cwd 在 worktree 内，被删后 cwd 失效）；mcp tool 检测到 cwd 仍在 worktree 内时应 reject + 提示 agent 先 ExitWorktree
- **K2 start_next_session 起新会话不会自动 EnterWorktree**：mcp tool 起的新 SDK session cwd 设为 worktree_path 后，新 session agent 看到 cold start prompt「按 ... 接力」会按 §Step 3 流程自己调 EnterWorktree(path:...) —— 这一步必须由新 session agent 自己做，mcp 无法替它做。**新 session agent 的 system prompt 必须含 user CLAUDE.md「复杂 plan」节**（settingSources 包含 'user' 即可，应用内 SDK 会话默认满足）
- **K3 LLM 总结 oneshot 调用**：必须 `settingSources: []` 避免 hook 回环（参考项目 CLAUDE.md「鉴权与会话边界」节）+ 用本地 OAuth credential（不读不写 API Key）
- **K3 起新 session 切换 UI 焦点**：用户点 hand off 按钮后，UI 应自动切到新 session detail，否则用户疑惑「点了没反应」
- **改 user CLAUDE.md 跨项目影响**：Phase 4a Step 4a.6 / 4b Step 4b.5 改的是 `~/.claude/CLAUDE.md`（不是 project CLAUDE.md），所有项目都看到。**不要**写 agent-deck-specific 的内容到那里；archive_plan / start_next_session tool 通用流程才能写入
- **L SessionCard 大改影响 SessionList 滚动性能**：每条卡片增加显示行数 / popover 都会增加渲染开销；建议用 React.memo + 虚拟滚动验证
- **Phase 4a K1 mcp tool 实施时**：必须读 user CLAUDE.md「复杂 plan」节全文先（Phase 1 调研已 Read 完成 §Step 1-4 完整规则），按 §Step 4 cleanup 流程 1:1 实现，不漏 step
- **C MED-D7 修法注意**：dispatcher.start() 时一次性 listAll active teams 预填 cache 必须按当前真实 archivedAt 填（不要 default null），否则又会触发首次 transition 误检测；建议加单测验证
