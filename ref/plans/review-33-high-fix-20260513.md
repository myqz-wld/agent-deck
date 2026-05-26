---
plan_id: "review-33-high-fix-20260513"
created_at: "2026-05-13"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/review-33-high-fix-20260513"
status: "completed"
base_commit: "e7c9be7"
base_branch: "main"
final_commit: "357864249525197538836167fbc9b3ce811ae29d"
completed_at: "2026-05-14"
---
# Plan: REVIEW_33 9 条 HIGH 修复

## Context

deep-code-review SKILL 4 批异构对抗（reviewer-claude × Opus 4.7 + reviewer-codex × gpt-5.5 xhigh）+ lead 自己 grep/read 验证 6 条单方 HIGH 后挖出 **9 条 HIGH 真问题** + 12 条 MED + 13 条 LOW/INFO，详 reviews/REVIEW_33.md（待写）。

base 跨 commits `bfccc10..e7c9be7`（mcp-bug-and-feature-batch-20260513 plan 18 commits + CHANGELOG_95 1 commit），共 19 commits / 67 files / ~5500 行变更。

注意：HEAD `e7c9be7` 是用户在另一个会话做的 CHANGELOG_95 fix（修了之前一轮 review 的 9 条 HIGH，含 disposedRef → requestSeqRef 替换 = 我刚的 M7 finding 已被 fix 无需修）。9 条 HIGH 中只有 H7 文件被它改过，但仍存在双击问题（入口缺同步 ref guard）。

---

## 总目标 & 不变量

### 最终交付（9 条 HIGH 各 1 commit + plan 收口 1 commit + REVIEW_33.md 1 commit）

按设计对齐顺序（用户已确认 4 个 design choice）：
- H1: archive_plan ff-merge 前 `git checkout base_branch`
- H2: archive_plan reject `abandoned`，hint 走手工 cleanup
- H3: wait_reply nudge 路径 deny external caller
- H4: scheduler.scan() 两阶段（先收集 后批量 archive）
- H6: handOffSpawn 透传 `codexSandbox` / `claudeCodeSandbox`
- H7: renderer ref guard + main inflight Map dedupe + 并发单测
- H8: 删 `autoApproveTeammateMode` IPC 孤儿 validation + parser
- H9: archive_plan ff-merge 后 error 加 phase code prefix
- H10: archive_plan / start_next_session 加 worktree_path / cwd 存在性预检

### 不变量

- **不破坏既有 mcp tool 协议**（H1/H2/H3/H9/H10 改 archive_plan / start_next_session 不能破坏 in-flight 协议）
- **wait_reply 仍允许 external caller**（H3 仅 deny external nudge 路径，read-only wait 本身保持开放）
- **lifecycle 与 archived 正交**（H4 改 scheduler 不能破坏正交）
- **CLAUDE.md§188 即改即生效**（H8 删 autoApproveTeammateMode IPC 路径不能引入新 setting 漏分发）
- **typecheck 双端必过**

---

## 设计决策（用户已确认 4 项）

| HIGH | 决策 | 备注 |
|---|---|---|
| H1 | a. checkout base_branch 再 ff-merge | merge 后不切回，假设 main 是默认工作分支 |
| H2 | a. reject abandoned，hint 走手工 cleanup | 与 user CLAUDE.md§Step 4 abandoned cleanup 对齐 |
| H4 | b. 两阶段：先收集 teamId 后批量 archive | 性能 + 鲁棒兼具，避免 cursor pagination 复杂度 |
| H7 | 1+2+3 全选：renderer ref guard + main inflight Map + 并发单测 | 双管齐下 |

H3/H6/H8/H9/H10 修法直白，无 design choice。

---

## 步骤 checklist

- [x] **Step 0** 写 plan 文件（此文件） + 写 reviews/REVIEW_33.md 沉淀本轮 review 结论 — done commit `72d45b3`
- [x] **Step 1** H8 修：删 settings.ts:209-212 + _helpers.ts:147 parseAutoApproveTeammateMode + import — done commit `e5b6ef9`（-33 行 / typecheck 双端通过）
- [x] **Step 2** H1 修：archive-plan-impl.ts ff-merge 前 `git checkout base_branch` + branch 存在性 verify + 单测 — done commit `958c828`（+115 / -14；archive-plan.test 14/14 passed）
- [x] **Step 3** H2 修：archive-plan-impl.ts reject `abandoned` + hint + 单测 — done commit `a978a9e`（+98 / 17/17 passed）
- [x] **Step 3.5** Merge main 进 worktree branch（main 期间推进 30+ commit / 删 wait+check+reply tool / start_next_session rename → hand_off_session / archive_plan default 归档 caller）— done commit `ef11087`
  - **作废 H3**（wait.ts 被 main 删）
  - **H2 措辞收敛**到 main Phase A4 R1 deep review 版本（双方共识，main 措辞引用 §Step 4 中止流程更准确）
- [x] **Step 5** H4 修：team-lifecycle-scheduler.ts 两阶段（先收集 teamId 列表 → 后批量 archive）+ 单测 — done commit `5c2f856`（+222 / -2；6/6 passed）
- [x] **Step 6** H6 修：sessions.ts handOffSpawn 透传 codexSandbox / claudeCodeSandbox + 单测 — done commit `810e223`（+136 / -5；7/7 passed）
- [x] **Step 7** H7 修：HandOffPreviewDialog ref guard + sessions.ts SessionHandOffSpawn inflight Map dedupe + 单测 — done commit `2a5f261`（+262 / -33；14/14 passed）
- [x] **Step 8** H9 修：archive-plan-impl.ts post-ff-merge 9 个 try/catch 加 `phase` prefix + 单测 — done commit `3185fb6`（+191 / -15；6/6 passed）
- [x] **Step 9** H10 修：archive-plan-impl.ts + hand-off-session-impl.ts worktree_path / cwd 加 `deps.exists()` 预检 + 单测 — done commit `fb38064`（+76 / 4/4 passed）
- [x] **Step 10** typecheck 双端 + 全 vitest 通过（465/465）+ 写 CHANGELOG_101.md + 更新 INDEX — done commit `e09bae9`（+120 / -2）
- [ ] **Step 11** ExitWorktree(action: "keep") + mcp__agent_deck__archive_plan ff merge → main + cleanup

---

## 当前进度

Step 0-10 全 done。Step 11 待跑 ExitWorktree + archive_plan tool 收口。

## 下一会话第一步

无（plan 已收口，Step 11 在本会话直接执行）。

## 下一会话第一步

按 Step 5 开始 H4 fix（剩余 5 条 HIGH 按 plan 顺序逐条修，每条 1 commit）：

1. read `/Users/apple/Repository/personal/agent-deck/.claude/worktrees/review-33-high-fix-20260513/src/main/teams/team-lifecycle-scheduler.ts:84-118` 的 scan() while-loop pagination
2. **H4 根因**：scan() 边迭代边调 `_archiveTeam`（line 89/110）。`_archiveTeam` 把 `archived_at` 从 NULL 改非 NULL → 下次 `agentDeckTeamRepo.list({ activeOnly: true, limit: PAGE_SIZE, offset })` active list 缩 → `offset += PAGE_SIZE` 跳错 → 漏扫 N 条 ghost team
3. **修法**（用户已确认 b. 两阶段）：
   - first pass：while-loop 收集所有满足 archive 条件的 teamId（不调 `_archiveTeam`）→ 候选 list
   - second pass：循环候选 list 调 `_archiveTeam` 批量收尾
4. 加单测：mock 500 条全 ghost active team → 修前模拟边迭代边 archive 漏扫 N → 修后必须 archive 500/500
5. typecheck + vitest + commit

剩余 Step 6-11 按 checklist 顺序。每条 1 commit 节奏。

完成全部 Step 9 后跑 Step 10：typecheck + vitest 全套 + 写 changelog/CHANGELOG_101.md（按 reviews/REVIEW_33.md 引用归档形态，重点写「9 条 HIGH 实际修法 + H3 作废 + H1+H2+H8 已落地 + 落地 commit + 单测覆盖」）+ 更新 changelog/INDEX.md。

最后 Step 11：`ExitWorktree(action: "keep")` → `mcp__agent_deck__archive_plan({ plan_id: 'review-33-high-fix-20260513', worktree_path: '/Users/apple/Repository/personal/agent-deck/.claude/worktrees/review-33-high-fix-20260513', base_branch: 'main' })`。

---

## 已知踩坑

- worktree 路径陷阱：所有指向**代码资产**的路径必须前缀 `.claude/worktrees/review-33-high-fix-20260513/`；plan 文件本身路径不变
- worktree 基底 HEAD 是 e7c9be7（不在 main HEAD 之前），EnterWorktree 自动跟 HEAD 不需要 reset
- HandOffPreviewDialog.tsx 已被 CHANGELOG_95 改过；H7 fix 时不要回退它的 requestSeqRef 改造
