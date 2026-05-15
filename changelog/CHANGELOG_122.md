# CHANGELOG_122 — archive_plan tool step 8b post-ff-merge invariant carry-forward + cleanup hint UX 完整修

## 概要

`archive-plan-content-overwritten-fix-20260515` plan 收口（`p4-baseadapter-d2-implement-20260515` plan archive 实测撞 archive_plan body overwrite bug + commit `30467f6` manual fix 后立 plan 系统性根治）。修 `mcp__agent-deck__archive_plan` tool step 9-10 写归档文件用 step 6（ff-merge 前）read 的 stub planContent.body 覆盖 ff-merge 进来的 caller 收尾 commit（[x] step checklist / 跳过理由 / 已知踩坑修正等）回滚 bug。

修法 A 拆两次 read（plan §设计决策 §1 sign-off）：step 6 预检阶段 read 拿 status check / base_branch fallback / fm 元数据；step 8b ff-merge 后**重新 read** planContent + parseFrontmatter 拿 freshFm + freshContent → step 9-10-11 全部用 fresh 数据写归档。R1 反驳轮异构同源把 codex 单方 HIGH「step 8b 后未 re-validate status」升 ✅ 必修（防 caller worktree branch 漂移 status 静默归档 abandoned 为 completed），R2 修 cleanup hint range / R3 修 cleanup hint 选项 (2) 闭合 + doc drift cluster / R4 polish revert+continue git 拓扑分叉 — 共 4 轮异构对抗 review × fix 收口完整。

## 变更内容

### Phase 1 fix base（commit `5403b71`）

- **`src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts`** step 8b 加重新 read planContent + parseFrontmatter 拿 freshFm + freshContent。step 9-10 切到 freshFm + freshContent
- **失败兜底两路**：fresh re-read fail（fs ENOENT / 外部并发删 plan）→ `postFfMergeErr('reread-plan-after-ffmerge', err)` / freshFm 缺 frontmatter block（caller 误删 frontmatter）→ 同款 postFfMergeErr 提示责任方
- **新增 `'reread-plan-after-ffmerge'` PostFfMergePhase value** + docstring 同步加 step 8b 描述
- **新增 `src/main/agent-deck-mcp/__tests__/archive-plan.impl-ff-merge-body.test.ts`** 4 案：(1) 主 case caller 在 worktree branch commit 回写 → fresh body 保留 / (2) regression caller 没改 plan → 归档 body == stub / (3) fresh re-read 失败 → postFfMergeErr / (4) fresh fm 缺 frontmatter → postFfMergeErr 提示责任方

### R1 review fix（commit `39e7b14`）

- **`archive-plan-impl.ts:357-385`** step 8c 加 `freshFm.status === 'in_progress'` re-check + 专用 phaseHint cleanup 指引（防 caller worktree branch commit 把 status 改 abandoned/completed/未知值，ff-merge 把改动带进 main → step 9 spread 静默归档为 completed，违反 user CLAUDE.md §Step 4 中止契约 + 回归 REVIEW_33 H2 已修过的 abandoned 防线）
- **`archive-plan-impl.ts:387`** INDEX summary `fm.description ?? fm.plan_id` → `freshFm.description ?? freshFm.plan_id`（同根因漏修：本次 fix step 9-10 已切到 freshFm 但 step 11 INDEX summary 仍用 stale fm）
- **case 5+6** 加守门：(5) caller worktree branch 改 description → INDEX 用 fresh description 而非 stub plan_id fallback / (6) caller worktree branch commit `status: abandoned` → archive_plan 必须 postFfMergeErr 拒绝 + 不写 archive 文件 / 不 unlink 原 plan

### R2 review fix（commit `f377a11`）

- **`archive-plan-impl.ts:386`** cleanup hint range 修：`git revert HEAD` → `git reset --hard ORIG_HEAD`（推荐，干净简单）+ `git revert ORIG_HEAD..HEAD`（history-preserving 选项）— `git merge --ff-only` 可带入 worktree branch 多个 commit（实测本 plan 收口时已 4+ commit ahead of main），`git revert HEAD` 仅撤 tip 一个不完整
- **`archive-plan-impl.ts:531`** PostFfMergePhase 注释 phase 计数 `8 个` → `10 个`，step 范围 `step 8 / 8b / 10-14` → 完整 `step 8 / 8b / 10a / 10b / 11 / 12 / 13a / 13b / 14a / 14b`
- **`archive-plan-impl.ts:331-333`** 8b 注释加 step 11 同步 + invariant 提醒（post-ff-merge 写入路径必须用 freshFm，严禁回到 step 6 fm/planContent — 未来添加新 post-ff-merge step 时务必遵守）
- **case 6 assertion 同步**守门 reset / revert range 两命令

### R3 review fix（commit `f974d2c`）

- **`archive-plan-impl.ts:386-410`** phaseHint 选项 (2) 闭合：双选项都先 `git reset --hard ORIG_HEAD` undo ff-merge → 选项 (2) 仅在 worktree branch 修 status: in_progress + commit + re-call（等价干净重跑）。**修前**: 旧版「on both main repo and worktree branch edit」会让 caller 误编辑 main repo plan（uncommitted）→ re-call 时 step 7 ff-merge 撞 dirty working tree 拒绝（git 安全行为：ff-merge 不能修改 dirty 文件）
- **`archive-plan-impl.ts:19-20`** 顶部 docstring step 6 「abandoned 也允许收口」与实际 line 250-269 三档分流（abandoned reject）矛盾 → 改成「仅 in_progress 放行；completed 拒绝防误调；abandoned 拒绝并指向 user CLAUDE.md §Step 4 中止流程（REVIEW_33 H2）」与实现一致
- **`archive-plan-impl.ts:22-31`** 文件头 docstring 业务流程清单加 step 11 carry-forward + 加 step 8c 完整条目（fresh status re-check + 引 user CLAUDE.md §Step 4 / REVIEW_33 H2 契约）
- **`archive-plan-impl.ts:551-562`** PostFfMergePhase docstring 区分「一般阶段（step 10a/10b/11/12/13/14）已累积写入 → reset --hard 风险高」vs「step 8b/8c 例外（无写入累积）→ reset --hard ORIG_HEAD 干净安全（详 8c phaseHint）」— 修前同文件内对同命令安全性表述矛盾
- **case 6 加 2 反向锚点**（`only on the worktree branch` / `do NOT edit main repo`）守门防 caller 误编辑 main

### R4 polish（commit `fa0f0ec`）

- **`archive-plan-impl.ts:386-417`** phaseHint 调整：「First step (both choices)」只列 `git reset --hard ORIG_HEAD`；revert range 移到选项 (1) abandoned history-preserving 子分支（明确「only valid for option 1 — do NOT use revert for option 2」）；选项 (2) continue 显式约束「**must use `git reset --hard ORIG_HEAD`** (not revert)」— 防 caller 选 revert 后走 continue 路径让 main 带 revert commit (R1..R3) 与 worktree 分叉,下次 ff-merge 失败
- **case 6 加 2 反向锚点**（`do NOT use revert for option 2` / `only valid for option 1`）守门未来 hint 措辞 drift 让 caller 撞 git 拓扑分叉

## 异构对抗 4 轮 finding 累计

| 轮次 | HIGH | MED | LOW | INFO | 备注 |
|---|---|---|---|---|---|
| R1 | **2**（双方独立 1 + 反驳轮 codex 1） | 1（与 HIGH-A 同根） | 0 | 3 | 反驳轮异构同源把 codex 单方 HIGH 升 ✅ 必修 |
| R2 | 0 | 1 | 0 | 2 | doc nit cluster 顺手扫 |
| R3 | 0 | 1 | 1 | 2 | 选项 (2) 闭合 + doc drift cluster 第二轮收尾 |
| R4 | 0 | 0 | 1 | 0 | LOW polish 不 R5（双方 ack 收口）|
| **合计** | **2** | **3** | **2** | **7** | 全 fix（除 ❓ INFO 不修 4 项 pre-existing/scope 外/概率低）|

## 测试基线

- archive-plan tests **42/42 pass**（impl-core 12 + impl-r33 15 + handler 9 + ff-merge-body **6** = 老 4 case + 新 2 case）
- 全套 vitest **602/602 pass + 64 skip + 0 fail**（Phase 2.2 baseline 600 + 新 2 case = 602）
- typecheck 双端 clean

## 工作量 / 影响

- 7 commit / 2 文件 / +328/-23 LOC（archive-plan-impl.ts step 8b 拆 read + step 8c status re-check + cleanup hint 完整 UX + 多次 doc drift 同步 / archive-plan.impl-ff-merge-body.test.ts 6 case 含 9 个 hint anchor）
- 行为变化仅 plan 文件正文不再被回滚 + status 漂移到 abandoned 自动拒绝 + cleanup hint 给 caller 完整决策树
- 0 行 src/ 业务逻辑代码改动（仅 archive_plan tool 内部 invariant + UX 完善）

## Follow-up（不阻塞）

- `plans/INDEX.md` header 4 列 vs archive_plan auto-append 行 2 列错位（pre-existing）→ 留独立 plan
- archive_plan default 路径不查 `<main-repo>/plans/<id>.md`（本次 plan dogfooding archive 仍需 caller 显式传 plan_file_path）→ 留独立 plan（plan §Phase 5 stub）
- 7 个其他 phase（mkdir-plans-dir / write-archived-plan / sync-plans-INDEX / unlink-original-plan / git-add / git-commit / git-worktree-remove / git-branch-D）仍走 GENERIC hint，未来 archive_plan UX 收尾 plan 单独 polish

详 [REVIEW_44.md](../reviews/REVIEW_44.md) + [`plans/archive-plan-content-overwritten-fix-20260515.md`](../plans/archive-plan-content-overwritten-fix-20260515.md)。
