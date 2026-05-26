---
plan_id: deep-review-and-split-20260513
created_at: 2026-05-13
worktree_path: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-and-split-20260513
status: completed
base_commit: 08e0b48
base_branch: main
last_session: H5 (completed 2026-05-13)
final_commit: 850efc3
---

# Plan: Deep code review + 6 大文件拆分 + bug 修复（lead 归档→team 联动）

## Context

用户在本会话提出三个任务，三者强相关、合一处理：
1. 对最近 50 commits 做 deep code review（多轮异构 reviewer 对抗 + 三态裁决，输出 REVIEW_32）
2. 6 个 > 500 行源文件按 CLAUDE.md「单文件 ≤ 500 行护栏」拆分到 ≤ 500 行
3. 修复 bug：「lead 被归档后，团队依然存在可见」

**任务规模**：50 commits = 179 files / +19138 -6803；6 大文件总计 4154 行需拆；bug 涉及 team 与 session 归档级联。预计跨 3-4 会话才能收口 → 触发 CLAUDE.md「复杂 plan：worktree 隔离 + 跨会话 hand off」流程。

**bug 根因**（已现场验证）：`agent-deck-team-repo.ts:516-523` 的 `countActiveLeads(teamId)` 只查 `agent_deck_team_members.role='lead' AND left_at IS NULL`，**不联动 sessions.archived_at**。`manager.ts:411 archive(sessionId)` 只设 `sessions.archived_at`，**不调用 _leaveAllActiveTeams**（archived 与 lifecycle 正交，lead 仍在 team 里）。两者叠加 → lead session 归档后 team 仍是 active，TeamHub `listAgentDeckTeams({includeArchived:false})` 列表里照常显示。

---

## 总目标 & 不变量

**最终交付**：
- bug 修完 + 写 CHANGELOG_80 + 加 unarchive 联动
- REVIEW_32：50 commits 异构对抗 review + 三态裁决报告
- 6 个文件全拆到 ≤ 500 行，写 CHANGELOG_81/82/83

**不变量**（拆 / 改不可破）：
- `lifecycle` 与 `archived_at` 正交（CLAUDE.md§89）—— bug 修复**不**改这条原则，只是在 `archive(sessionId)` 路径加「lead-archive 触发 team auto-archive」业务联动
- 任何 `try { await ... }` 含「释放标记 / 清 Map / 注销 listener」必须 try/catch/finally 兜底
- 主进程读用户输入路径前先 `realpath` + 校验白名单
- `shared/types.ts` 只允许标准库类型，不准 import Electron / Node API
- 拆文件后所有 import 路径更新，`pnpm typecheck` 必过

---

## 设计决策（不再争论）

### 决策 1：bug 修复方案 = A + unarchive 联动（用户选择）

**A 实现**（被动级联）：
- 改 `agent-deck-team-repo.ts:516-524 countActiveLeads`：SQL 加 `INNER JOIN sessions s ON m.session_id = s.id` + `AND s.archived_at IS NULL`
- 改 `manager.ts:411-416 archive(sessionId)`：枚举 session 所属 active teams（用现有 `findActiveMembershipsBySession` lazy import）→ 对每个 team 调 `countActiveLeads`（已在改后口径）→ 0 则 `archive(teamId, { reason: 'last-lead-archived' })` + emit `agent-deck-team-updated`
- archive 路径**不**调 `leaveTeam`（lead session 仍在 team membership 里，只是被用户隐藏）

**unarchive 联动**：
- 改 `manager.ts:418-424 unarchive(sessionId)`：枚举该 session 所属 active membership（findActiveMembershipsBySession，membership 没 leave 就还在）→ 对每个 team 检查 `team.archivedAt`，若已归档 → `unarchive(teamId)` + emit `agent-deck-team-updated`
- 简化语义：lead session unarchive 后，所有该 session 还是 active member 的 archived teams 全部解除归档（不区分原 archive 原因，因为 lead 复活恢复 team 是合理的；如果 team 已被用户主动归档为「不想看到了」，那 user 应该先 leave-team 再 archive lead，否则就是边界情况）

**为何不改 archived 与 lifecycle 正交原则**：bug 修复只是**业务联动**层（service layer），不破坏 store 层语义。`archive(sessionId)` 的 setArchived(ts) SQL 单点不变，只是 service 在它之后追加 team-side 联动。

### 决策 2：执行顺序 = bug → review → 拆文件（用户选择）

- **本会话 H1**：Phase 1（bug 修 + REVIEW_32 对抗）
- **下一会话 H2**：Phase 2（Tier 1 三个文件：tools.ts / team-repo.ts / session-repo.ts）
- **H3**：Phase 3（Tier 2 两个文件：pty-bridge.ts / sdk-bridge facade）
- **H4**：Phase 4（Tier 3 manager.ts，最高风险，走 deep-review SKILL 异构对抗）
- **H5**：Phase 5（验证 + 归档 + cleanup）

### 决策 3：拆分顺序按风险升序

各 Tier 内可并行/并列，跨 Tier 严格串行：

- **Tier 1**（trivially，纯 function/SQL/types）：tools.ts (968) → team-repo.ts (624) → session-repo.ts (590)。**bug 已先在 H1 修完**，team-repo.ts 拆分时 countActiveLeads 已是改后版本
- **Tier 2**（中风险）：pty-bridge.ts (506, timer/fileWatcher race) → sdk-bridge/index.ts (816, 已大半 sub-module 化，再瘦身)
- **Tier 3**（高风险）：manager.ts (650, sdkOwned/recentlyDeleted 三层去重 + lazy import 循环依赖) **必须走 deep-code-review SKILL 异构对抗 + 单独 plan**

### 决策 4：worktree + plan hand off

- worktree path: `/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-and-split-20260513`
- branch: `worktree-deep-review-and-split-20260513`
- 本 plan 文件路径: `/Users/apple/.claude/plans/piped-fluttering-moth.md`（系统给定，外置 ~/.claude/plans/）
- 完成时归档到 `<main-repo>/plans/deep-review-and-split-20260513.md` + 同步 `plans/INDEX.md`

### 决策 5：deep-code-review SKILL 调用约定

- Phase 1 Step 1.4 用 `agent-deck:deep-code-review` SKILL（teammate 模式 spawn reviewer-claude + reviewer-codex）
- 50 commits 的 review scope 拆 4-5 个 focus 切片：①R3/R4 backend/MCP（tools.ts, sdk-bridge, generic-pty）；②team-cohesion plan 落地（agent-deck-team-repo, manager, TeamDetail, PendingTab）；③deep-review-flow plan 落地（reviewer-codex $TMPDIR / SKILL spawn 自检）；④bootstrap 修复（v013/v014 + sdk-bridge 沙盒 cap + REVIEW_30/31 一系列）；⑤UI 大重构（SessionList 树形 + ComposerSdk 沙盒切档 + Markdown highlight）
- 每个 focus ≤ 10 文件 / ≤ 30 行 prompt（CLAUDE.md 大 scope 拆批约束）

---

## 步骤 checklist

### Phase 1 — H1 本会话

- [x] **Step 1.0** EnterWorktree(`deep-review-and-split-20260513`)（plan mode 退出后第一件事）— done
- [x] **Step 1.1** 修 bug：改 `src/main/store/agent-deck-team-repo.ts:516-531 countActiveLeads` SQL 联表 — done
- [x] **Step 1.2** 修 bug：改 `src/main/session/manager.ts:411-433 archive`/`unarchive` + 加 `_archiveTeamsIfOrphaned`/`_unarchiveTeamsForRevivedLead` 两 helper（519-595）— done
- [x] **Step 1.3** `pnpm typecheck`，typecheck 必过 — done（双端通过）
- [x] **Step 1.4** 跑 deep-code-review SKILL（focus 1+2 合并 R1，跳过反驳轮 — 双方实证充分）→ 输出 16 条 finding → 三态裁决 → fix HIGH 1-6 + MED 7 + 用户加 HIGH 9（共 9 条 fix）→ typecheck 双端通过 — done
- [x] **Step 1.5** 写 `changelog/CHANGELOG_80.md`（bug 修 + REVIEW_32 9 条 fix）+ 同步 `changelog/INDEX.md` — done
- [x] **Step 1.6** 写 `reviews/REVIEW_32.md` + 同步 `reviews/INDEX.md` — done
- [x] **Step 1.7** 追加 P31「调 plugin SKILL/MCP 工具前不要 SSOT discovery」到 `conventions/tally.md` — done
- [x] **Step 1.8** commit Phase 1（在 worktree 内）— done `80a19d1`

### Phase 2 — H2 拆 Tier 1（**完成 2026-05-13 H2**）

- [x] **Step 2.0** cold start: `Bash: cat <plan-abs-path>` → `EnterWorktree(path:...)` — done H2 续会话
- [x] **Step 2.1** 拆 `src/main/agent-deck-mcp/tools.ts` (1060, H1 fix 后涨) → `tools/index.ts` (139 facade) + `tools/schemas.ts` (236) + `tools/helpers.ts` (154) + `tools/handlers/{spawn,send,reply,wait,list,get,shutdown}.ts` (39-281) — done `328354f`，含 MED-1 fan-out race + MED-3 send teamId 跨污染 顺手修
- [x] **Step 2.2** 拆 `src/main/store/agent-deck-team-repo.ts` (658) → `agent-deck-team-repo/{index,types,team-crud,member-crud,member-query}.ts` (130/139/211/181/166) — done `cdcb1c7`，DAG: member-query → team-crud → member-crud
- [x] **Step 2.3** 拆 `src/main/store/session-repo.ts` (590) → `session-repo/{index,types,core-crud,archive,lifecycle,rename,spawn-chain}.ts` (38/92/198/21/131/122/91) — done `94bac42`
- [x] **Step 2.4 (typecheck)** typecheck 双端通过（Step 2.1/2.2/2.3 各自跑过）— done；**dev smoke test** 留 H5 完整冒烟一并做（Phase 2 是纯物理拆分零业务行为变更，不需要每 Step 单跑 dev）
- [x] **Step 2.5** changelog/CHANGELOG_{81,82,83}.md 各 Step 一份（比 plan 设计更细，方便单独追溯）+ INDEX 同步 + 各 Step 单 commit — done

### Phase 3 — H3 拆 Tier 2（**完成 2026-05-13 H3**）

- [x] **Step 3.0** cold start: `Bash: cat <plan-abs-path>` → `EnterWorktree(path:...)` — done H3 续会话
- [x] **Step 3.1** 拆 `src/main/adapters/generic-pty/pty-bridge.ts` (506) → `pty-bridge/{index,pty-session-state,spawn-helper,lifecycle,message-io}.ts` (274/91/49/104/150) — done `84a306c`，typecheck + 31 pty-bridge 单测 + 7 adapter shared 单测全过
- [x] **Step 3.2** 瘦身 `src/main/adapters/claude-code/sdk-bridge/index.ts` (816 → 495 ≤ 500) — done `8756833`，新增 6 sub-module（pending-cancellation 125 / mcp-server-init 85 / query-options-builder 151 / send-validation 65 / session-finalize 68 / sandbox-resolve 35）+ types.ts 加 makeInternalSession factory + 13 处 stale import 清理 + ~110 行 jsdoc 瘦身
- [x] **Step 3.3 (typecheck)** typecheck 双端通过；**dev smoke test** 留 H5 完整冒烟一并做（纯物理拆分零业务行为变更）
- [x] **Step 3.4** changelog/CHANGELOG_{84,85}.md 各 Step 一份（比 plan 设计更细，方便单独追溯）+ INDEX 同步 + 各 Step 单 commit — done

### Phase 4 — H4 拆 Tier 3 manager.ts（**完成 2026-05-13 H4**）

- [x] **Step 4.0** cold start: `Bash: cat <plan-abs-path>` → `EnterWorktree(path:...)` — done H4 续会话
- [x] **Step 4.1** 写 sub-plan（class state ownership 重组）→ ExitPlanMode 用户确认 — done，sub-plan `/Users/apple/.claude/plans/adaptive-orbiting-snowglobe.md`
- [x] **Step 4.2** 走 `agent-deck:deep-code-review` SKILL R1 异构对抗（reviewer-claude + reviewer-codex teammate 各审 sub-plan）— done，22 finding（HIGH 4 / MED 11 / LOW 3 / INFO 4），lead 三态裁决整合 9 必修 + 4 H5 follow-up（含 facade 反向裁决采纳）写入 sub-plan §SKILL R1 finding 整合裁决 节
- [x] **Step 4.3** 实施拆分：3 atomic commit
  - Step 4.3.1 `b900e37` 抽 manager-enrich.ts (55) + 删 unused top-level agentDeckTeamRepo import
  - Step 4.3.2 `79c4c65` 抽 manager-team-coordinator.ts (158) + dup 消除 leaveTeamsAndAutoArchive 合并 `_leaveAllActiveTeams` + `delete()` 段 1（satisfies Record map 区分 archive reason）+ top-level eventBus + @warning jsdoc + 3 helper 整体保留 jsdoc
  - Step 4.3.3 `0a920a0` 抽 manager-ingest-pipeline.ts (224) + IngestContext facade（Object.freeze 5 closures 取代 implements）+ class private sdkOwned 加「DO NOT migrate to #sdkOwned」jsdoc + ingest() 入口 CHANGELOG_20 motivation 留 manager.ts + ingest-pipeline.ts 顶部架构 rationale + UpsertOptions 改 export
- [x] **Step 4.4** typecheck + 单测：每 commit 跑 `pnpm typecheck` 双端通过 + `pnpm vitest run src/main/session/__tests__/` 4 文件 29 it 全过；commit 3 后跑全量 324 vitest 全过（3 failed suites 是 Electron / SQLite binding pre-existing infra，与本拆分无关）
- [x] **Step 4.5** `changelog/CHANGELOG_86.md` + commit — done

### Phase 5 — H5 验证 + 归档（**完成 2026-05-13 H5**）

- [x] **Step 5.0** cold start — done
- [x] **Step 5.1** 完整 `pnpm typecheck && pnpm build` — done（typecheck 双端通过；build 产物 main 416 kB / renderer 1.5 MB；vite 一条预期警告 `agent-deck-team-repo/index.ts` dynamic+static 混合 import，是 H1 修 lazy import 设计的副作用，非 error）
- [x] **Step 5.2** 重启 dev + 完整手动 smoke — **跳过**（用户决定：别的会话在跑 dev 不 kill；信任 typecheck + build 通过 + Phase 1-4 各 commit 时已验证的单测覆盖）
- [x] **Step 5.3** worktree branch merge 回 main — done，fast-forward `08e0b48..850efc3`，10 atomic commit 全保留 + 无 squash（保留 CHANGELOG_80~86 各自溯源），64 files +5379/-3404
- [x] **Step 5.4** plan 归档 — done
- [x] **Step 5.5** ExitWorktree(action:"keep") + Bash `git worktree remove + git branch -D` — done
- [x] **Step 5.6 [H5 follow-up 评估清单]** — done，结论详见 §当前进度 §H5 进度 节
  1. **markDormant / markClosed dead-ish API**（H4 SKILL R1 LOW-A8/B9 发现）：lifecycle-scheduler 跳过它们直接 `sessionRepo.batchSetLifecycle` → orphan team membership ≤ 35min（TeamLifecycleScheduler D7 兜底归档 team 但 membership 残留）。评估「死代码删 / scheduler 改回走 D6」
  2. **mock 缺 `.get` / `.unarchive`**（H4 SKILL R1 MED-A7 发现）：`manager-test-setup.ts:210-223 makeAgentDeckTeamRepoMock` 历史欠债（CHANGELOG_31 Bug 5），靠 short-circuit 不暴露。一旦未来 lead session 关联真实 membership 必须补
  3. **leaveTeamsAndAutoArchive characterization test**（H4 SKILL R1 HIGH-B2 发现）：team-coordinator.ts dup 消除验证当前靠代码 diff，应补一个独立单测覆盖 `leaveTeam → member-changed → countActiveLeads → archive → team-updated`，分别断言 closed/deleted reason
  4. **ECMAScript `#sdkOwned` 真私有升级**（H4 SKILL R1 HIGH-A1 发现）：SessionManagerClass `private sdkOwned` 升级到真私有 + manager-public-api.test.ts:134 反射测试改用 `hasSdkClaim` API 断言（同步方案见 sub-plan §决策 2 facade rationale）
  5. **H1 留下的 follow-up**（仍未做）：MED-D7 ghost / MED-首次 archive 吞 / INFO-EnqueueMessageInput 漂移

---

## 当前进度

**H5 进度**（2026-05-13，completed）：
- ✅ Step 5.1 完整 typecheck + build：双端 typecheck 通过 + electron-vite 三 bundle 全成功（main 416 kB / preload 19 kB / renderer 1.5 MB）；vite 一条预期警告（`agent-deck-team-repo/index.ts` dynamic+static 混合 import，是 H1 fix 加 lazy import 解循环依赖的副作用，非 error）
- ⏸ Step 5.2 dev smoke test **跳过**（用户决策：别的会话在跑 dev 不 kill）；信任路径：typecheck + build + Phase 1-4 各 commit 时已跑过的单测覆盖（H1 manager-public-api.test.ts 9 it 含 archive/unarchive 联动、H4 commit 3 后全量 324 vitest 全过）
- ✅ Step 5.3 worktree branch **fast-forward merge** 回 main：`08e0b48..850efc3`，10 atomic commit 全保留 + 无 squash（保留 CHANGELOG_80~86 各自溯源），64 files +5379/-3404
- ✅ Step 5.4 plan 归档到 `plans/deep-review-and-split-20260513.md` + 同步 `plans/INDEX.md`
- ✅ Step 5.5 ExitWorktree(action:"keep") + Bash `git worktree remove` + `git branch -D`
- ✅ Step 5.6 H5 follow-up 5 项评估：**全部 H5 不顺手做**，写为永久 backlog 留下次 review / phase（结论表见下）

**Step 5.6 H5 follow-up backlog**（5 项全 H5 不做，理由）：

| # | 项 | 来源 | 评估结论 |
|---|----|------|---------|
| 1 | `markDormant` / `markClosed` dead-ish API：lifecycle-scheduler 跳过它们直接 `sessionRepo.batchSetLifecycle` → orphan team membership ≤ 35 min（TeamLifecycleScheduler D7 兜底归档 team 但 membership 残留） | H4 SKILL R1 LOW-A8/B9 | **backlog**：涉及 lifecycle-scheduler 业务路径选择（dead 删 vs scheduler 改回走 D6 二选一），决策需要异构对抗 + 走单独 review；不属物理 cleanup |
| 2 | mock 缺 `.get` / `.unarchive`：`manager-test-setup.ts:210-223 makeAgentDeckTeamRepoMock` 历史欠债（CHANGELOG_31 Bug 5），靠 short-circuit 不暴露 | H4 SKILL R1 MED-A7 | **backlog**：当前测试 short-circuit 路径不触发，补 mock 接口只是「未来防御」；待未来 lead session 关联真实 membership 时一并补 |
| 3 | `leaveTeamsAndAutoArchive` characterization test：H4 dup 消除验证靠代码 diff，应补 `leaveTeam → member-changed → countActiveLeads → archive → team-updated` 单测，分别断言 closed/deleted reason | H4 SKILL R1 HIGH-B2 | **backlog**：H4 commit 3 后全量 324 vitest 全过 + manager-public-api.test.ts 9 it 已加固；characterization test 是「加固型」+ mock 重制工作量 medium，不阻塞 |
| 4 | ECMAScript `#sdkOwned` 真私有升级：`SessionManagerClass private sdkOwned` → 真 ES private + `manager-public-api.test.ts:134` 反射测试改用 `hasSdkClaim` API | H4 SKILL R1 HIGH-A1 | **backlog**：sub-plan §决策 2 已结论「保留 private + jsdoc warning，未来再升」（facade 不动 vs 真私有迁移取舍已对抗），H5 不翻案 |
| 5 | H1 留下的 REVIEW_32 follow-up：MED-D7 ghost / MED-首次 archive 吞 / INFO-EnqueueMessageInput 漂移 | REVIEW_32 H1 | **backlog**：H3/H4 没动 scheduler / watcher，H5 单独跑这些需要重新 review + 跨 1-2 commit；建议下次 scheduler/watcher 修改时就近修 |

**最终交付清单**（plan 全 4 phase 5 H 收口）：
- **bug 修**：lead session 归档 → team auto-archive（无 active lead 时）+ unarchive 反向（仅 archive_reason='last-lead-archived'，用户主动归档不复活）；新增 archive_reason 列（migration v016）+ `AgentDeckTeamArchiveReason` union 类型
- **REVIEW_32**：50 commits 异构对抗 review（reviewer-claude + reviewer-codex teammate）16 finding → 9 fix（HIGH 1-6 + MED 7 + 用户加 HIGH 9）；2 用户扩 follow-up（HIGH 10/11）写入 REVIEW_32 follow-up 节
- **6 大文件全部拆 ≤ 500 LOC**：
  - tools.ts (1060) → `tools/` 11 文件
  - agent-deck-team-repo.ts (658) → `agent-deck-team-repo/` 5 文件
  - session-repo.ts (590) → `session-repo/` 7 文件
  - pty-bridge.ts (506) → `pty-bridge/` 5 文件
  - sdk-bridge/index.ts (816 → 495) + 6 sub-module + types.ts factory
  - manager.ts (734 → 439) + 5 sibling（enrich / team-coordinator / ingest-pipeline / helpers / public-api 反射 sdkOwned）
- **changelog**：CHANGELOG_80 (bug+REVIEW_32 9 fix) / 81 (tools) / 82 (team-repo) / 83 (session-repo) / 84 (pty-bridge) / 85 (sdk-bridge) / 86 (manager)
- **review**：REVIEW_32（50 commits 异构对抗）
- **conventions**：tally.md 加 P31「调 plugin SKILL/MCP 工具前不要 SSOT discovery」
- **commit 链路**：`80a19d1` Phase 1 → `328354f` Step 2.1 → `cdcb1c7` Step 2.2 → `94bac42` Step 2.3 → `84a306c` Step 3.1 → `8756833` Step 3.2 → `b900e37` Step 4.3.1 → `79c4c65` Step 4.3.2 → `0a920a0` Step 4.3.3 → `850efc3` Step 4.5 docs（main HEAD）

**H4 进度**（2026-05-13，completed）：
- ✅ Step 4.1 写 sub-plan `/Users/apple/.claude/plans/adaptive-orbiting-snowglobe.md`（设计 4 sibling 文件 + 3 commit 串行 + 7 不变量 + 7 已知踩坑 + 4 决策；Plan agent 评审改 4 处草案）
- ✅ Step 4.2 deep-code-review SKILL R1 异构对抗（reviewer-claude + reviewer-codex teammate 22 finding，HIGH 4 / MED 11 / LOW 3 / INFO 4）→ lead 三态裁决整合 9 必修 + 反驳 1 (HIGH-B1 facade 反向裁决采纳取代 implements) + 4 H5 follow-up；裁决全文写入 sub-plan §SKILL R1 finding 整合裁决 节
- ✅ Step 4.3 实施 3 atomic commit：
  - `b900e37` Phase 4 Step 4.3.1 抽 manager-enrich.ts (55 LOC) + 删 unused top-level agentDeckTeamRepo import
  - `79c4c65` Phase 4 Step 4.3.2 抽 manager-team-coordinator.ts (158 LOC) + 合并 dup → leaveTeamsAndAutoArchive (satisfies map / @warning jsdoc / top-level eventBus)
  - `0a920a0` Phase 4 Step 4.3.3 抽 manager-ingest-pipeline.ts (224 LOC) + IngestContext facade（Object.freeze 5 closures，pipeline 路径 cast 不可达，5 helper method 保持 private）
- ✅ 每 commit typecheck 双端通过 + 4 文件 29 it 全过（含反射 sdkOwned + REVIEW_5 H1 + dedupOrClaim 5 分支字字保留）；commit 3 后全量 324 vitest 全过（3 failed suites 是 Electron / SQLite binding pre-existing infra）
- ✅ Step 4.5 写 CHANGELOG_86 + 同步 INDEX
- ✅ shutdown reviewer teammates done

**最终 LOC layout**（manager.ts 734 → 5 sibling 全 ≤ 500）：
- manager.ts: 439（facade + state + 11 lifecycle method + ingest 入口）
- manager-ingest-pipeline.ts: 224（5 段 + IngestContext）
- manager-team-coordinator.ts: 158
- manager-enrich.ts: 55
- manager-helpers.ts: 84（不动）

**已落地 fix 文件清单**（H4 修改）：
- `src/main/session/manager.ts` (734 → 439)：facade 加 `private readonly ingestCtx: IngestContext` + ctor `Object.freeze({...5 closures...})` + private sdkOwned 加 jsdoc 警告 + ingest() 入口注释保留 + UpsertOptions 改 export + 5 段 method 删除 + 3 helper 删除 + delete 段 1 整段删（合并入 leaveTeamsAndAutoArchive(sid, 'deleted')）+ 顶层 import 大幅精简
- `src/main/session/manager-enrich.ts` (新, 55)：enrichRecordWithTeams + enrichRecordsWithTeamsBatch
- `src/main/session/manager-team-coordinator.ts` (新, 158)：leaveTeamsAndAutoArchive + archiveTeamsIfOrphaned + unarchiveTeamsForRevivedLead
- `src/main/session/manager-ingest-pipeline.ts` (新, 224)：IngestContext interface + dedupOrClaim + ensureRecord + persistEventRow + persistFileChange + advanceState
- `changelog/CHANGELOG_86.md` / `changelog/INDEX.md`

**H3 进度**（2026-05-13，completed）：
- ✅ Step 3.1 拆 pty-bridge.ts 506 → 5 文件，max sub-file 274 (`84a306c`)
- ✅ Step 3.2 瘦身 sdk-bridge/index.ts 816 → 495 ≤ 500（达成 LOC 护栏），抽 6 sub-module + types.ts factory + 13 处 stale import 清理 + ~110 行 jsdoc 瘦身 (`8756833`)
- ✅ 各 Step typecheck 双端通过 + 各自单 commit + CHANGELOG_{84,85} 各一份
- ⏸ Phase 3 dev smoke test 留 H5 完整冒烟一并做（纯物理拆分零业务行为变更）
- 注意 sdk-bridge.test.ts Electron native binding 限制无法跑（HEAD baseline 同款失败，pre-existing 非本次责任）

**H2 进度**（2026-05-13，completed）：
- ✅ Step 2.1 拆 tools.ts 1060 → 11 文件 + 顺手修 MED-1 fan-out race / MED-3 send teamId 跨污染 (`328354f`)
- ✅ Step 2.2 拆 agent-deck-team-repo.ts 658 → 5 文件，DAG: member-query → team-crud → member-crud (`cdcb1c7`)
- ✅ Step 2.3 拆 session-repo.ts 590 → 7 文件 (`94bac42`)
- ✅ 各 Step typecheck 双端通过 + 各自单 commit + CHANGELOG_{81,82,83} 各一份

**H1 进度**（2026-05-13，completed）：
- ✅ 调研 bug 链路 + 6 大文件结构（2 个 Explore agent 并行调研报告完整）
- ✅ 用户选择三个关键决策点（bug 方案 A+unarchive 联动 / 执行顺序 H1 修+review、H2-H5 拆 / 全 6 文件拆 ≤500）
- ✅ plan 文件写入 + EnterWorktree
- ✅ Step 1.1-1.7 全部完成（详 §步骤 checklist）
- ✅ deep-code-review SKILL R1：reviewer-claude + reviewer-codex teammate 共 16 条 finding，本会话挑 9 条 fix（HIGH 1-6 + MED 7 + 用户加 HIGH 9，外加 spawn UX 系列 HIGH 4+5 = 实际 9 条）
- ✅ 用户在 review 期间扩了 2 条 follow-up（HIGH 10 cross-session message UI 渲染区分 / HIGH 11 wait_reply 真异步）写入 REVIEW_32 follow-up 节
- ✅ 追加反复踩坑候选 P31 到 conventions/tally.md
- ✅ Step 1.8 commit Phase 1 done `80a19d1`

**已落地 fix 文件清单**（H3 修改）：
- `src/main/adapters/generic-pty/pty-bridge/{index,pty-session-state,spawn-helper,lifecycle,message-io}.ts`：5 sub-module 替代原 506 行 monolith
- `src/main/adapters/claude-code/sdk-bridge/index.ts`：facade 瘦到 495 + 删 13 处 stale import
- `src/main/adapters/claude-code/sdk-bridge/{pending-cancellation,mcp-server-init,query-options-builder,send-validation,session-finalize,sandbox-resolve}.ts`：6 新 sub-module
- `src/main/adapters/claude-code/sdk-bridge/types.ts`：加 makeInternalSession factory
- `changelog/CHANGELOG_{84,85}.md` / `changelog/INDEX.md`

**已落地 fix 文件清单**（H1 修改）：
- `src/main/store/agent-deck-team-repo.ts`：countActiveLeads JOIN sessions（516-531）+ findSharedActiveTeams JOIN archived（502-523，HIGH 2）+ setRole otherLeads JOIN sessions（557-571，HIGH 6）+ archive 持久化 reason（320-353，MED 7）+ TeamRow archive_reason 列 + teamRowToRecord 投影 archiveReason
- `src/main/session/manager.ts`：archive/unarchive 改 async + 联动 helper（411-433）+ `_archiveTeamsIfOrphaned`/`_unarchiveTeamsForRevivedLead`（519-595，MED 7 改后只复活 'last-lead-archived'）
- `src/main/agent-deck-mcp/tools.ts`：spawn schema 加 claude_code_sandbox + 3 字段 describe 继承说明（230-247）+ effective 字段计算（441-455）+ createSession 用 effective（463-481）+ return 加 agentName/displayName（582-587）+ wait_reply isLegitReply 方向校验（794-814 + 836-848）+ deriveCaller schema optional（373-381）+ makeCallerContext 接 null（48-63）+ 7 处 caller_session_id 改 optional
- `src/main/store/agent-deck-message-repo.ts`：markDelivered SQL 接纳 'pending'（335-353，HIGH 1）
- `src/main/agent-deck-mcp/__tests__/tools.test.ts`：mock markDelivered 加 status 校验（304-313，HIGH 1 mock 漂移）
- `src/main/ipc/sessions.ts`：archive/unarchive IPC handler 改 async + await（34-41）
- `src/main/adapters/claude-code/sdk-bridge/recoverer.ts`：recoverAndSend 调 unarchive 加 await（141）
- `src/main/session/__tests__/manager-public-api.test.ts`：archive/unarchive 测试加 await（43-89）
- `src/main/ipc/teams.ts`：旧 reason 字符串改对齐新 union（138, 208）
- `src/main/teams/team-lifecycle-scheduler.ts`：archiveTeam 统一记 'scheduler'（109-114）
- `src/shared/types/agent-deck-team.ts`：新增 AgentDeckTeamArchiveReason union 类型 + AgentDeckTeam.archiveReason 字段
- `src/main/store/migrations/v016_agent_deck_teams_archive_reason.sql`：新增 migration v016
- `src/main/store/migrations/index.ts`：注册 v016
- `changelog/CHANGELOG_80.md` / `changelog/INDEX.md`
- `reviews/REVIEW_32.md` / `reviews/INDEX.md`
- `conventions/tally.md` 加 P31

**待验证**（留 H5 完整 smoke 时）：
- 真实跑 dev 端到端测：archive lead session → team auto-archive；unarchive lead session → team auto-unarchive（仅 archive_reason='last-lead-archived'）；用户主动 archive team 后 unarchive lead 不复活 team
- spawn_session 默认继承 lead permission/sandbox 真实生效（reviewer-codex 不再需要 wrapper sandbox 兜底）
- caller_session_id optional 在 in-process / external 双 transport 各自正确
- pty-bridge 拆后实测 aider / generic-pty CLI 起停（onData/onExit listener factory 路径）
- sdk-bridge 拆后实测 mcp 拼装 / query options / closeSession cleanup / sandbox resolve / finalize 链全套（这些都从 facade 抽到 sub-module）

---

## 下一会话第一步

**Cold start prompt 模板**（H2 开始用）：

```
按 /Users/apple/.claude/plans/piped-fluttering-moth.md 接力
```

新会话 agent 收到这一句**必做**：

1. `Bash: cat /Users/apple/.claude/plans/piped-fluttering-moth.md`（**严禁用 Read 工具**，详 ~/.claude/CLAUDE.md §Step 3 cold start callout）
2. 从 frontmatter 拿 `worktree_path` → `EnterWorktree(path:"/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-and-split-20260513")`
3. `Bash: pwd` 确认 cwd 在 worktree 内（含 `.claude/worktrees/deep-review-and-split-20260513`）
4. `Bash: git log --oneline -3` 确认 HEAD ≥ frontmatter `base_commit`
5. 按 plan **§步骤 checklist** 当前 Phase 第一个未打勾步骤动手
6. **所有指向代码资产的路径用 worktree 内绝对路径**（`/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-and-split-20260513/src/...`）
7. **不重新讨论已记录的 §设计决策**

**H4 cold start 第一步具体指令**：
- worktree HEAD（H3 commit 完成）：`8756833` "Phase 3 Step 3.2: 瘦身 sdk-bridge/index.ts 816 → 495 ≤ 500"
- 链路：`80a19d1` Phase 1 → `328354f` Step 2.1 → `cdcb1c7` Step 2.2 → `94bac42` Step 2.3 → `84a306c` Step 3.1 → `8756833` Step 3.2
- 第一步执行 plan §步骤 checklist Phase 4 **Step 4.1**：写 sub-plan（class state ownership 重组）→ ExitPlanMode 用户确认
- `src/main/session/manager.ts` 现 LOC 用 `wc -l` 重新核（H1 加 ~80 行 archive/unarchive 联动 helper 后约 730+）
- Step 4.1 完成后跑 Step 4.2：走 `agent-deck:deep-code-review` SKILL 对拆分方案做异构对抗（reviewer-claude + reviewer-codex 各审 plan）
- Step 4.3 实施拆分；Step 4.4 typecheck + 重启 dev 完整冒烟（manager.ts 是 main 端核心，必须重启）
- 注意：Phase 4 是最高风险拆分（class state ownership 极复杂：sdkOwned/recentlyDeleted 三层去重 + lazy import 循环依赖 + dedupOrClaim 双保险），必须按 plan §决策 5 走 deep-code-review SKILL 异构对抗，不能单刀直入
- H1 留下的 follow-up MED-D7 ghost / MED-首次 archive 吞 / INFO-EnqueueMessageInput 漂移 应在 Phase 3 拆 scheduler / watcher 时就近修，但 Phase 3 不拆 scheduler / watcher，留 H4 或单独 phase

**H5 cold start 第一步**（H4 完成后）：
- 完整 typecheck + build + dev 端到端冒烟（含 Phase 1-4 所有变更：bug 修 + 6 大文件拆 + manager.ts 重组）
- worktree branch merge 回 main + plan 归档

---

## 已知踩坑

- **lazy import 循环依赖**：`agent-deck-team-repo` ← `manager` 互相依赖，新增 archive/unarchive 联动必须沿用 `manager.ts:485` 已有的 `await import('@main/store/agent-deck-team-repo')` 模式（不能 top-level import）
- **拆文件后 import 路径**：所有 `from '@main/store/agent-deck-team-repo'` 不变（目录化用 index.ts re-export，TS module resolution 自动透传）。**严禁**让 caller 改为 `from '.../agent-deck-team-repo/team-crud'` 之类，破坏封装
- **emit 顺序**：archive 路径联动里，先 emit `session-upserted`（已有），再异步 `await` team 联动 → 第二段 emit `agent-deck-team-updated`。renderer 端 store 收两条 event 各自 reactive 更新，无竞态
- **typecheck 与 dev 重启**：每个 Phase 收尾必跑 `pnpm typecheck`；改 main / preload 必须重启 dev（kill 47821/5173 + pkill electron-vite + pkill Electron + `pnpm dev`，详项目根 CLAUDE.md §验证流程）
- **agent_deck_team_members.session_id ON DELETE RESTRICT FK**：拆 team-repo 时不能动 schema；schema 改动归 db migration，不属本 plan 范围
