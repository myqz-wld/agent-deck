# REVIEW_68 — 近期大改动 deep review（issue-tracker / runtime-logging / camelcase）

- 日期: 2026-05-30
- 类型: Deep code review（多轮异构对抗 + 三态裁决）
- 关联 plan: [deep-review-and-asset-polish-20260530](../plans/deep-review-and-asset-polish-20260530.md)
- 方法: `deep-review` SKILL 编排 reviewer-codex（gpt-5.5）+ reviewer-claude（Opus 4.7）异构对抗 + lead 三态裁决 + 现场静态验证

## 进度

| Batch | 范围 | 状态 |
|---|---|---|
| 1 | issue-tracker-mcp-20260529 | ✅ 本会话收口（HIGH 1 + MED 1 + LOW 4 处理，0 残留 HIGH/MED） |
| 2 | runtime-logging-electron-log-20260529 | ⏳ 待下个会话 |
| 3 | mcp-tool-camelcase-migration-20260529 | ⏳ 待下个会话 |

> **异构对抗记录（batch 1）**：reviewer-codex（mcp teammate）正常 Round-1 出 3 finding。reviewer-claude（mcp teammate）spawn 后 +13min 卡住 ~8min（疑似卡自身 PendingTab 工具审批，user 不在无人批）→ lead 按 SKILL §失败兜底 起**外部只读 claude CLI** 做 Round-2 backend 复审（与 codex 仍 Opus×gpt-5.5 异构对，严禁同源化）；随后 reviewer-claude 经 nudge 恢复并交付 Round-1（额外抓到下游 prompt 数据丢失放大 + IssueDetail 反应性）。最终覆盖 = codex R1 + claude R1 + 外部 claude R2，三路独立。

## Batch 1 — issue-tracker-mcp

### scope

后端核心 7 文件（`issue-repo.ts` / `v026_issues.sql` / `issue-lifecycle-scheduler.ts` / `report-issue.ts` / `append-issue-context.ts` / `ipc/issues.ts` / `types/issue.ts`）+ reviewer-claude 额外覆盖 renderer 3 文件（`IssuesPanel` / `IssueDetail` / `issues-store`）。

### 三态裁决 + 修复

**✅ HIGH-1 — IssuesUpdate 丢 appendices（编辑保存后现场消失 + 下游 prompt 数据丢失）**
- **双方独立提出**（codex 评 MED「update 返回/emit 丢 appendices」+ claude 评 HIGH，抓到关键下游放大）→ ✅ 升 HIGH。
- 根因：`issue-repo.ts:354` update() `return get(id)`（bare，无 appendices）→ `ipc/issues.ts:183` issuesUpdateHandler 返回/emit 裸记录（而 get/softDelete/undelete/resolve handler 都补 `listAppendices`）。
- **下游放大**（claude 抓，定 HIGH）：`IssueDetail.handleSave` 后 `setIssue(updated)` 抹掉本地 appendices → `ResolveInNewSessionDialog.buildDefaultPrompt` 从 `issue.appendices` 拼新会话首条 prompt → 用户「先保存编辑再起新会话解决」时新会话 prompt **丢失全部 append 现场 = 功能数据丢失**。
- 验证：get vs getWithAppendices(266-276) 实现差异 + 6 个 emit 点 grep 对比 + dialog buildDefaultPrompt 下游消费追踪。
- 修复：`ipc/issues.ts` issuesUpdateHandler emit/return 前补 `updated.appendices = issueRepo.listAppendices(validId)`（handler 层回填，与另 3 handler 对称）。
  - 取舍记录：claude 建议 repo 层单点修 `update() return getWithAppendices`；lead 选 handler 层——保 repo `get()/update()` 一致返裸记录、appendices enrich 统一在 IPC handler 层；2 个生产调用方（update / resolve handler）均已 backfill，无遗漏。

**✅ MED-2 — resolve 新会话 spawn race + 缺入口守门**（codex 提出 + lead 静态验证 + 外部 claude R2 + reviewer-claude R2 双确认）
- `ipc/issues.ts` issuesResolveInNewSessionHandler：① 无入口守门，直接 IPC / stale UI 可对 resolved/已删 issue 重新起会话；② `await createIssueResolutionSession` spawn 窗口内用户 resolve/soft-delete → 无条件 `status='in-progress'` 覆盖（`if(!updated)` 只挡 hardDelete）。
- 验证：get(248) 与 update 之间唯一 await 是 createSession；re-read→update 纯同步原子，窗口真收窄。
- 修复：spawn 前拒 `status==='resolved' || deletedAt!==null`；spawn 后 re-read，仅 `stillActionable` 才写 status，否则只回写 `resolutionSessionId` 保 link。

**↩️ LOW-4（曾评 MED，修复尝试被 Round-2 推翻 → 回退）— IssueDetail 本地 state 不订阅 store 更新（违反 §detail 视图权威）**（claude 单方提出）
- 原 finding：`IssueDetail.tsx:29` issueFromStore 订阅 store 但仅用于初始 useState，渲染全程用本地 state，detail 打开期间外部变更不实时（须重开）。claude 评 MED（convention 违反）。
- **修复尝试 → 回退**：lead 加 `issueFromStore → setIssue` sync useEffect。**reviewer-codex Round-2 抓出该 fix 引入新 MED regression**：sync 把 `issue` 同步成外部新值但 `editing` 草稿保持旧值；`handleSave` diff `editing.X !== issue.X` 对用户未改的字段也判为「改动」→ 把旧草稿写回，**反向覆盖外部更新（能把已 resolved issue 重新打开）**。
- **异构对抗裁决（reviewer 分歧 → lead 现场实证）**：reviewer-claude Round-2 **blessed** 此 fix（把该现象归为 INFO「固有并发 lost-update 极低概率」）；reviewer-codex Round-2 **rejected**（评 MED「能重开 resolved issue，还需改」）。lead before/after trace 判 codex 正确：**回退前** handleSave diff 基线 = fetched issue（稳定），未改字段 no-op diff → 外部变更被保留；**fix 后** issue 同步外部 → 未改字段 diff 非空 → 旧草稿写回覆盖外部 = fix 引入的 regression，**非固有**。reviewer-claude mis-severity（看到现象但归 INFO）。
- **处理**：**回退 sync useEffect**（不盲改无法 live test 的 renderer fix），IssueDetail 恢复 fetched-baseline diff（外部变更不被覆盖）。原 reactivity 需求（detail 不 live-update）降级 LOW 留 follow-up：正确修法是**独立 diff baseline / dirtyFields**（外部 store 变更只刷只读区 + 维护用户实改字段集，不动 diff 基线），需 live 浏览器实测，本会话不盲改。

**✅ LOW-1 — logsRef scopes overflow 写回重复**（codex + lead 验证 + claude R2 确认）
- `issue-repo.ts:237` mergeLogsRef union >32 项时丢已去重 `unioned` 用 raw `incomingScopes`（schema 不禁重复）→ `['x','x']` 留两个 x。
- 修复：overflow 改 `unioned.slice(0, SCOPES_MAX)`。

**✅ LOW-2 — append 不拒 soft-deleted issue（与 resolved-reject 不对称）**（外部 claude R2 + claude R2 确认）
- `append-issue-context.ts:53` 仅拒 resolved，无 deletedAt 守门 → source session 存活时用户软删后 agent 仍能 append 成功写进隐藏 issue。LOW（appendContext 不动 deleted_at，GC 时钟不受影响，无数据损坏，纯语义不对称）。
- 修复：加 `if(issue.deletedAt!==null) reject` 守门，与 resolved-reject 对称。

**✅ LOW-3 — store record appendices 被 updated event 覆盖**（claude 提出）→ 随 HIGH-1 修复连带消除（updated event 现含 appendices）。

### INFO（非阻断，记录）

- **INFO-1** `issue-repo.ts:308` create() logsRef 序列化 `JSON.stringify(x??null)==='null'?null:JSON.stringify(x)` 双 stringify + 字符串比较，与 update(336)/appendContext(435) 简洁写法不一致。功能正确，仅可读性。
- **INFO-2** `issue-lifecycle-scheduler.ts:73` GC `[...resolvedExpired,...softDeletedExpired]` 同 id 可出现两次；第二遍 hardDelete changes=0 → continue 兜住，无双 emit，仅多一次无谓 get。可 `new Set` 去重。
- **INFO-3** `v026_issues.sql:72` appendices 索引 `(issue_id, appended_at DESC)` 与 listAppendices `ORDER BY appended_at ASC` 反向；SQLite 反向扫描无 sort 代价。
- **INFO-4** MED-1 修复非 actionable 分支仍 emit 'updated' + 回写 resolutionSessionId（保 link 设计意图）；对 soft-deleted issue 发 'updated'，renderer 是否短暂复现隐藏 issue —— *未验证*（store 按 deletedAt 过滤大概率不显示，batch 后续可验）。
- **INFO-5** mergeLogsRef date 恒覆盖（plan §D17 明定行为）：跨天 append 后原始上报日指针丢失（tsRange 保 min-max，各 appendix 留各自 logs_ref）。符合 spec。
- **INFO-6** `IssuesPanel.tsx:43-52` selectFilteredIssues 手动构造完整 state 对象 + `as Parameters<...>[0]` 强转传 selector，反 zustand 模式（claude 提出），功能正确不影响合并。

### focus 项实践验证（均非问题，外部 claude + claude 出证据）

source-bound null 绕过 ✅ 无（`makeCallerContext` 空/null 归一 `__external__` + `EXTERNAL_CALLER_ALLOWED.{report_issue,append_issue_context}=false` deny）/ FK SET NULL + CASCADE ✅ 生效（PRAGMA foreign_keys=ON，issue-repo.test:61-63 覆盖）/ SQL 全参数化 ✅ / logsRef 入参 zod 校验 ✅（date regex + tsRange refine + scopes/note cap）/ GC×soft-delete × before-quit stop × 阈值热更新接线 ✅ / withMcpGuard deny external ✅ / scheduler snapshot-before-delete + 单条 try/catch ✅ / appendContext TOCTOU 已兜底 ✅。

### 验证

- ✅ `pnpm typecheck` 过（全部 fix type-clean，含 IssueDetail 回退后）
- ✅ **reviewer-codex Round-2 实跑 vitest**（worktree node_modules symlink）：`issue-tools.test.ts` + `issues.test.ts`（IPC handler）+ `issue-lifecycle-scheduler.test.ts` **83 tests / 3 files 通过**（验 ipc/issues.ts + append-issue-context.ts + scheduler 无 regression）。`issue-repo.test.ts` 因 better-sqlite3 native ABI mismatch 全 skip（scopes LOW-1 仅静态验，未实测）。
- ⚠️ **为 4 处 fix 补回归 case 仍待做**（resolve entry-guard/re-read、update appendices 回填、append deletedAt reject、scopes dedup overflow）：现有 83 test 只证无 regression，未覆盖新行为。留 CI / 下会话（issue-repo SQLite 测试需按 CHANGELOG_42 binding 流程才能跑）。
- ⚠️ main 改动（ipc/issues.ts + issue-repo.ts + append-issue-context.ts）需重启 dev 才生效，本会话未跑 dev 实测。

### 收口判定

batch-1 **已收口**：HIGH 1 + MED 1 全修；LOW 4（LOW-1 scopes / LOW-2 append-deleted / LOW-3 store-overwrite 随 HIGH 连带 / LOW-4 IssueDetail reactivity 回退降级）；INFO 6 记录。残留 HIGH/MED = 0。
- **reviewer Round-2**：reviewer-codex ✅ 4 backend fix + 抓出 Fix-5（IssueDetail sync）引入 stale-draft clobber regression → lead 回退；reviewer-claude ✅ 4 backend fix（**误 bless Fix-5**，把 clobber 归 INFO「固有 lost-update」）。
- **异构对抗价值（案例）**：两路对 Fix-5 严重度分歧（codex MED「还需改」vs claude INFO「不阻塞」）→ lead before/after trace 实证 codex 正确（回退前 fetched-baseline diff 保留外部变更；fix 后 synced-issue diff 用旧草稿覆盖外部 = fix 引入非固有）→ 回退。**单 reviewer 会漏判**：若只 claude，Fix-5 会带 regression 合入；codex 强冗余抓出。`heterogeneous_dual_completed: true`

## Batch 2 / 3 — 待下个会话

下个会话从 plan §下一会话第一步 接力：spawn 新 reviewer pair 跑 batch 2（runtime-logging）+ batch 3（camelcase sanity），结论 append 到本 REVIEW_68。
