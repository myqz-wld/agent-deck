# CHANGELOG_169 — Deep-Review 批 A fix (mcp tools handler)

> 计划文件: `/Users/apple/.claude/plans/glowing-mapping-badger.md`（in_progress）
>
> 本批 fix 收口 deep-review 批 A（mcp tools 核心 handler）异构对抗多轮 review 三态裁决出的
> **2 HIGH + 8 MED = 10 条必修 finding**。reviewer 双方独立提出 + 反驳轮验证 + 主 agent 现场
> Grep/Read 验证后实施修法。

## 范围

- 拆分（F1 + F9）：archive-plan-impl.ts 抽 2 个 sub-module + 4 个 impl 共用 default deps
- 功能修复（F2-F10）：plan_id binding / worktree-missing cwd 校验 / archive_caller=false 行为对齐
  schema 文案 / preserve-team 实测 membership / INDEX TOCTOU 单飞锁 / spike-reports 边界 / marker
  release 提前
- 不动文件保护清单：schemas.ts (1215 LOC) / hand-off-session.ts (1249 LOC)

## 变更内容

### 拆分 (F1 + F9)

- **F1 archive-plan-impl.ts 拆分（1488 → ~1170 行）**：
  - 抽 `tools/handlers/archive-plan/precheck-helpers.ts`：mainRepo dirty precheck（`assertMainRepoCleanForArchive`）+ base_branch 命名校验（`assertBaseBranchIsNamedBranch`）。原文件 re-export 让 4 个 test 文件直接 import 这些函数的 path 零改动
  - 抽 `tools/handlers/archive-plan/index-sync-helpers.ts`：INDEX markdown table escape（`escapeTableCell` / `formatChangelogCell`）+ INDEX 行级 smart update（`syncPlansIndex`）+ 老 2 列 header 升级 4 列（`upgradeIndexHeader`）。同款 re-export 模式
- **F1 schemas.ts (1215) + hand-off-session.ts (1249)「真不能拆」保护清单**：在文件顶部加注释 + 本 changelog 写明理由（schemas.ts 70% 是 tool description SSOT 集中维护；hand-off-session.ts handler 主体闭包 10+ 变量，强行抽 sub-module 需打包 10+ args dict 反而降可读性，test 直接 mock handler 非 sub-module）。阈值调整属约定升级走「决策对抗」三态裁决，不在本批 fix 范围
- **F9 共用 DEFAULT_DEPS 抽到 `tools/handlers/_shared/default-impl-deps.ts`**：4 个 impl（archive-plan / hand-off-session / enter-worktree / exit-worktree）通过 spread import 共用 runGit / readFile / writeFile / unlink / mkdir / mvDir / exists / realpath / cwd / homedir 10 个 fs/process helper。共用核心是「行为单点」（默认行为变更时一处改全部生效），不是「减少 LOC」

### 功能修复 (F2-F10)

- **F2 [HIGH] archive_plan plan_id ↔ worktree_path frontmatter cross-check**（reviewer-codex finding，双方反驳轮裁决 HIGH）：archive-plan-impl.ts step 7 ff-merge 之前加 frontmatter 与 input 一致性校验。`fm.plan_id` / `fm.worktree_path` 字段存在 → 严格校验 realpath / 字符串相等；缺失 → soft warn 不 reject（D7 向后兼容老 plan）。可选第三道防御：branch 命名约束 `worktreeBranch === worktree-<planId>` soft warn。防 caller 误传另一 plan 的 worktree_path 触发 silent corruption（plan-A 错标 completed + plan-B worktree 被删 + ff-merge 合错 commit）
- **F3 [MED] hand-off worktree-missing finalCwd 限定 mainRepo subtree**（reviewer-codex finding）：hand-off-session.ts:388 加 `finalCwd === mainRepo || finalCwd.startsWith(mainRepo + '/')` 校验。修前条件只 reject `finalCwd === worktreePath || !isInternalWorktree`，caller 显式传 args.cwd=/tmp 时被静默放行，新 session 落到错 cwd → cold-start enter_worktree ENOENT。修法与注释 line 381 「finalCwd === mainRepo 才走 graceful warn」契约对齐
- **F4 [MED] baton-cleanup archive_caller=false 跳过 phase 1**（reviewer-codex finding）：baton-cleanup.ts:219 加 `if (input.archiveCaller === false) skip phase 1 shutdown teammates`，标新 skipped reason `'archive-caller-false-keep'`。同步更新 schemas.ts archive_caller 文案 + baton-cleanup.ts 注释 + shutdown-teammates-on-baton.ts ShutdownTeammatesResult.skipped union 加第六态。修代码符合 schema 文案承诺「caller 仍可看 reviewer reply」（teammates 也保留 alive）
- **F5 [MED] preserve-team safety 用 repo 查询替代信任 spawnData.teamId**（reviewer-codex finding）：hand-off-session.ts:1130 改用 `agentDeckTeamRepo.findActiveMembershipIn(teamId, newSpawnedSid)` 实测 active membership。修前信任 spawnData.teamId（spawn handler addMember 失败只 warn 不置 null teamId），导致 task 已转给 newSid 但写权限 reject 不被 unadopted warning 捕获。零改动 spawn handler return 字段，blast radius 最小
- **F6 [MED] archive_plan INDEX read-modify-write 单飞锁**（reviewer-claude finding，reviewer-codex 反驳后部分成立降级 MED）：archive-plan-impl.ts 加 module-level `indexSyncFlight: Map<string, Promise<void>>` 单飞锁包 INDEX RMW 段。参考 `sdk-bridge/recoverer.ts:50, 232-245` 已有 pattern：IIFE 包 async RMW + .then(_, _) swallow rejection in Map + finally delete。防 caller A/B 同进程并发 archive 不同 plan_id 触发 INDEX 行写丢失（silent corruption）。仅 in-process 防御（mcp tool deny external caller）
- **F7 [MED] archive_plan spike-reports rmdir 失败 push warnings**（reviewer-claude finding）：archive-plan-impl.ts:1044 rmdir 失败不再 swallow，push 到 warnings 数组（含 sibling artifacts 残留提示）。rmdir 同时改走 deps 注入（之前直接 dynamic import 'node:fs/promises'），让 mock test 可控。配套加 `ArchivePlanDeps.rmdir` 字段
- **F8 [MED] archive_plan srcSpikeDir == dstSpikeDir 边界 guard**（reviewer-claude finding）：archive-plan-impl.ts:1033 加 `path.resolve(srcSpikeDir) !== path.resolve(dstSpikeDir)` guard，相等 skip + `spikeReportsArchived` 保 null（语义 = 未做归档动作）。修前 plan_file_path 已在 ref/plans/ 时 mv same → no-op + rmdir parent fail swallow + 误返 spikeReportsArchived non-null 误导 caller。复用 step 12 line 1008 同款 path.resolve guard 模式
- **F10 [MED] archive_plan marker release 提前到 step 13 commit 成功后**（reviewer-claude finding）：archive-plan-impl.ts marker release 从 step 14b 后挪到 step 13 archive-rev-parse-HEAD 成功之后。修前 step 14a/14b 失败时 marker 残留，但 plan 已 commit + INDEX 已更新 + frontmatter status=completed → caller 无法重试 archive_plan；若 caller session 后续再调 archive_plan 跑别的 plan_id 会撞 stale marker reject（4-state cwd dispatch (d) 路径）。修后 archive 本质完成 → 立即 release，step 14 worktree/branch 清理失败也不影响

### Test 更新

- 4 个 archive-plan test 文件的 worktree branch 名从 `worktree-mcp-bug-fix` 改为 `worktree-mcp-bug-fix-20260513` 匹配 F2 enter_worktree 约定
- `archive-plan/_setup.ts` 加 in-memory `rmdir` mock（F7 配套）
- `archive-plan.impl-followup-20260515.test.ts` 自归档 warn 测试改用更精确断言（只查 silent-override warn，不要求 warnings 数组 empty）
- `baton-cleanup.test.ts` case 11（archiveCaller=false）期望改为 phase 1 也跳过 + skipped='archive-caller-false-keep'（F4 修法）
- `hand-off-session.handler-deny-happy.test.ts` archive_caller=false test 同款期望调整
- `hand-off-session.task-reassign.test.ts` case e 加 `findActiveMembershipIn` mock（F5 改 API 配套）

## 验证

- `pnpm typecheck`：通过
- `pnpm exec vitest run`：80 test files / 968 tests passed / 158 skipped / 0 failed / 0 errors
- `pnpm build`：通过（warnings 是已知历史 — agent-deck-team-repo 既 dynamic 又 static import）

## 关联 review

REVIEW_X.md（本批 fix 同步写入）：批 A 异构对抗多轮 review 完整过程 + 三态裁决表 + reviewer 双方独立 finding 对比。
