# CHANGELOG_101

## 概要

REVIEW_33 9 条 HIGH 修复（plan `review-33-high-fix-20260513`）：5 条原子 commit 落地 H1/H2/H4/H6/H7/H9/H10，H3 因 main `7639b23` 删 wait_reply/check_reply/reply_message 自然作废，H8 落地后 main 已无相关字段引用。

完整 review 推理（4 批异构对抗 reviewer-claude × Opus 4.7 + reviewer-codex × gpt-5.5 xhigh + lead grep/read 验证 6 条单方 HIGH）+ 三态裁决见 `reviews/REVIEW_33.md`。本 changelog 只记落地修法 + 测试覆盖。

## 变更内容

### REVIEW_33 修复落地

- **H1** archive_plan ff-merge 前 `git checkout base_branch` + branch 存在性 verify（`958c828`）：旧实现直接在 mainRepo 当前 HEAD 上 ff，caller 在 feature-x 时把 worktree branch 合错分支。修法在 `archive-plan-impl.ts` 加 `rev-parse --verify <baseBranch>` + `checkout <baseBranch>` 双步。新增 `REVIEW_33 H1 base_branch checkout` describe 3 case。
- **H2** archive_plan reject `abandoned` + unknown status（`a978a9e` + merge 时收敛到 main `438a613` Phase A4 同款修法）：旧实现只 reject `completed`，让 abandoned 走完归档污染 git。修法三档分流 + hint 引用 user CLAUDE.md §Step 4 中止流程。新增 `REVIEW_33 H2 status 三档分流` describe 3 case。
- **H4** team-lifecycle-scheduler.ts scan() 两阶段（`5c2f856`）：边迭代边 archive 让 archived_at 改非 NULL → 下次 list active 缩 → offset += PAGE_SIZE 跳错 → reviewer-claude 实测 500 条全 ghost 漏扫 200 条。修法 first pass 收集候选 teamId 列表（不调 _archiveTeam）→ second pass 批量 archive。新建 `team-lifecycle-scheduler.test.ts` 6 case（500 全 ghost / PAGE_SIZE 边界 / 小于 PAGE_SIZE / 混合 fixture / grace 未到 / 300 条跨页顺序）。
- **H6** sessions.ts handOffSpawn 透传 codexSandbox / claudeCodeSandbox（`810e223`）：旧实现仅透传 cwd / prompt / permissionMode，用户切沙盒后 hand-off 起的新 session 落 settings 全局默认 = 隐性沙盒 downgrade。修法抽 `buildHandOffCreateSessionOpts` 到独立 `sessions-hand-off-helper.ts`（让单测能纯 import 不触发 Electron 链）+ 透传两沙盒字段。新建 `sessions.test.ts` 7 case。
- **H7** HandOffPreviewDialog ref guard + main inflight Map（`2a5f261`）：renderer setSummarizing/setSpawning 走 React state 16-200ms batch 内 button 仍 enabled，双击起多次 sonnet IPC + spawn 多个 SDK。修法两层闸：(a) `summarizeInFlightRef` / `submitInFlightRef` 同步赋值入口守门；(b) main 端抽 `dedupHandOff(sourceSid, work)` wrapper 同 sid 复用 in-flight Promise（resolve/reject 后 strict-equal 守门删 entry 防误删）。`sessions.test.ts` 加 7 个并发单测（同 sid 单飞 / 不同 sid 独立 / resolve/reject 后清 / strict equal 保护）。
- **H8** 删 settings.ts:209-212 + _helpers.ts:147 `parseAutoApproveTeammateMode` IPC 孤儿 validation（`e5b6ef9`）：CHANGELOG_56 起字段已搬到 settingsStore 直读，IPC 路径残留 33 行死代码。
- **H9** archive-plan-impl.ts post-ff-merge 9 个 try/catch 加 `[post-ff-merge:<phase>]` 前缀（`3185fb6`）：ff-merge 之后失败 caller 拿 generic error 不知道 main HEAD 已动 → 简单 retry 撞「branch already merged」/「INDEX 行 dup」一系列 redundant 失败。新增 `PostFfMergePhase` union 9 phase + `postFfMergeErr(phase, e, phaseHint?)` helper（默认通用 hint「不能简单 retry，按 phase 标识手工补完」+ git-worktree-remove / git-branch-D 精细 phaseHint override）。新增 `REVIEW_33 H9 post-ff-merge phase prefix` describe 6 case（rev-parse-HEAD / git-add / git-commit / worktree-remove / branch-D / pre-ff-merge 不应含 prefix）。
- **H10** archive-plan + hand-off-session 加 `worktreePath` exists 预检（`fb38064`）：archive_plan step 4 cwd realpath 在 worktree 已删时被 ENOENT 吞，hand-off-session-impl line 244 只校 absolute 不查存在 → spawn_session 拿不存在的 cwd 起 SDK ENOENT 一片。修法各加 step 0 / 第 244 行后 `deps.exists(worktreePath)` 显式预检 + 结构化 error/hint 提示重建 worktree / 改 plan frontmatter。`archive-plan.test.ts` 加 2 case + 修原 4 个非-fixture 测试占位；`hand-off-session.test.ts` 加 2 case + 改 makeDeps fallback（`.claude/worktrees/` 路径默认存在 + `state.missingWorktree` 显式控制 / 非约定路径需占位）。

### Merge main 进 worktree

worktree 期间 main 推进 30+ commit（CHANGELOG_96-100 + cwd-resilience + mcp-handoff-fix-and-skill-timer + mcp-tool-simplify）：
- 删 `reply_message` / `wait_reply` / `check_reply` 三 mcp tool（mcp-tool-simplify）→ **作废 H3**（wait.ts nudge 路径 deny external，目标文件不存在）
- `start_next_session` rename → `hand_off_session`（mcp-handoff-fix-and-skill-timer）→ H6/H10 影响范围调整
- `archive_plan` default 归档 caller（CHANGELOG_99）+ Phase A4 R1 deep review MED-3 已加 abandoned reject → H2 在 worktree 与 main 同时修同一处 → merge 时 keep main 措辞（双方共识，main 引用 §Step 4 中止流程更准确）

merge commit `ef11087` 解决 archive-plan-impl.ts + archive-plan.test.ts 双方都改的冲突。

## 验证

- typecheck 双端通过
- 全套 vitest **465/465 通过**（hand-off-session.test.ts 修复 makeDeps + worktree fixture 占位后 21 fail 全过；archive-plan.test 31/31 通过）
- worktree 跑 vitest 需先 link 主仓库 electron binding（`node_modules/.pnpm/electron@*/node_modules/electron/{path.txt,dist}`，否则 Electron failed to install correctly），与 plan 修法无关

## 落地 commit

| HIGH | 修法 | commit |
|---|---|---|
| H8 | 删孤儿 IPC validation | `e5b6ef9` |
| H1 | ff-merge 前 checkout base_branch | `958c828` |
| H2 | reject abandoned + unknown status | `a978a9e`（merge 时收敛 main 措辞 `ef11087`）|
| — | merge main | `ef11087` |
| H4 | scheduler 两阶段 | `5c2f856` |
| H6 | handOffSpawn 透传 sandbox | `810e223` |
| H7 | dialog ref guard + inflight Map | `2a5f261` |
| H9 | post-ff-merge phase prefix | `3185fb6` |
| H10 | worktreePath exists 预检 | `fb38064` |

H3 作废（无 commit）。

## 已知踩坑

- worktree 跑 vitest 时 Electron binding 未自动安装，需手工 `cp path.txt + ln -sf dist` 主仓库到 worktree 的 `.pnpm/electron@33.4.11/node_modules/electron/`
- merge 时 plan 自身 commit `a978a9e` 的 H2 单测期望措辞与 main `438a613` 实际 string 不一致，重写 expect 对齐 main impl 措辞（merge 中双方 review 自然收敛）
- hand-off-session-impl 的 H10 改动是 1:1 复制 archive-plan 的修法，单测在 worktree electron link 后跟 archive-plan H10 case 同结构验证
