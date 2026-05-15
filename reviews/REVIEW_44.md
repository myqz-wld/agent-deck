---
review_id: REVIEW_44
title: archive-plan-content-overwritten-fix step 8b post-ff-merge invariant carry-forward + cleanup hint UX 4 轮异构对抗 review × fix
created_at: 2026-05-15
plan_id: archive-plan-content-overwritten-fix-20260515
worktree_path: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/archive-plan-content-overwritten-fix-20260515
base_commit: 33381fc
final_commit: fa0f0ec
parent_review_id: REVIEW_43
heterogeneous_dual_completed: true
---

# REVIEW_44 — archive-plan-content-overwritten-fix step 8b post-ff-merge invariant 4 轮异构对抗 review × fix

## 触发场景

`p4-baseadapter-d2-implement-20260515` plan 收口时实测撞 archive_plan tool bug：tool 在 ff-merge worktree branch 后用 step 6（ff-merge 前）read 的 stub planContent.body + 改 frontmatter 写归档文件 → ff-merge 进来的 caller 收尾 commit（[x] step checklist / 跳过理由 / 已知踩坑修正等）被覆盖回滚。手工 fix commit `30467f6` 复原后立 plan `archive-plan-content-overwritten-fix-20260515` 系统性根治：

- **bug root cause**：`src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts:228-235` step 6 read planContent → step 7-8 ff-merge → step 9-10 用 step 6 旧 planContent.body 写归档文件。ff-merge 进来的 caller body 被覆盖。
- **fix 修法 A**（不再争论 — plan §设计决策 §1 sign-off）：拆两次 read。step 6 预检阶段 read 拿 status check / base_branch fallback / fm 元数据（已用完，不参与写入）；step 8b ff-merge 后**重新 read** planContent + parseFrontmatter 拿 freshFm + freshContent → step 9-10 全部用 fresh 数据写归档。
- **不变量**：修法只改 frontmatter 字段（status / final_commit / completed_at），**不动 plan 正文（body）**；ff-merge 之前的预检阶段（status check / worktree_path / base_branch 解析）仍正常运行；现有 archive_plan unit test 不能 break；行为变化仅 plan 文件正文不再被回滚。

## 方法

### Scope = plan 7 commit / 2 文件 / 修 archive-plan-impl.ts 100+ LOC + 新加 archive-plan.impl-ff-merge-body.test.ts 6 case

**主线 7 commit**：

| commit | 说明 |
|---|---|
| `5403b71` | Phase 1+2 fix base：step 8b re-read 插入 + 2 失败兜底分支（fs ENOENT / fm block 缺失）+ 4 守门 case |
| `e53b152` | docs：plan 同步 Phase 1+2 完成 + 下一会话 cold-start 指向 Phase 3.1 review |
| `66df209` | docs：cold-start step 1 cat plan 用 worktree path 而非 main repo path |
| `39e7b14` | **R1 fix**：step 8c 加 `freshFm.status === 'in_progress'` re-check + line 426 INDEX summary 切 freshFm.description / freshFm.plan_id + 2 守门 case（case 5 description 漂移 / case 6 status 漂移到 abandoned）|
| `f377a11` | **R2 fix**：cleanup hint `git revert HEAD` → `git reset --hard ORIG_HEAD` + `git revert ORIG_HEAD..HEAD` 双选项 + PostFfMergePhase 注释 phase 计数 8→10 + 8b 注释 step 11 同步 + invariant 提醒 |
| `f974d2c` | **R3 fix**：cleanup hint 选项 (2) 闭合（reset → 仅 worktree 修 → re-call,防 caller 误编辑 main 撞 dirty working tree）+ line 19 docstring abandoned 描述与实现一致 + 文件头 docstring 加 step 11 / step 8c + PostFfMergePhase docstring 区分一般 phase vs 8b/8c 例外 |
| `fa0f0ec` | **R4 polish**：revert range 限定 abandoned 路径专用（防 revert+continue 走选项 (2) 时 main 带 revert commit 与 worktree 分叉,下次 ff-merge 失败）+ case 6 加 2 反向锚点 |

### 异构对抗 reviewer

**4 轮 heterogeneous_dual_completed: true**（应用 `agent-deck:deep-code-review` SKILL teammate 模式编排）。

| Reviewer | 模型 | sid | 跨轮复用 |
|---|---|---|---|
| **reviewer-claude** | Opus 4.7 default thinking | `9276ea32-c6f4-4b5d-bf23-8a4642b985b0` | R1→R2→R3→R4 同一 teammate 跨轮 mental model 持久化 |
| **reviewer-codex** | gpt-5.5 xhigh（wrapper） | `5ae4b15e-9275-4748-9e36-dd06dfcbe881` | R1→R2→R3→R4 同一 teammate（外部 codex CLI 仍每轮 fresh，但 wrapper 把上轮 codex 输出当 skip 字段塞下轮 prompt）|

R1 ✅ 双方独立 1 HIGH + 反驳轮 codex 单方独有 1 HIGH 共 2 HIGH 修；R2 ✅ codex 1 MED + claude 2 INFO 修；R3 ✅ codex 1 MED + 1 LOW + claude 2 INFO 修；R4 ✅ codex 1 LOW polish + 双方 ack 收口。team `archive-plan-fix-r1` (id `1894a8a1-f869-4c98-8475-9c28de15bc51`)。

## R1 三态裁决

### ✅ 共识 真问题（双方独立提出）

| ID | 严重度 | 内容 | 异构强证据 |
|---|---|---|---|
| **HIGH-A** | HIGH | `archive-plan-impl.ts:387` INDEX summary 仍读 step 6 stale `fm.description`,与本次 fix step 9-10 已切到 freshFm 不一致 — caller 在 worktree branch commit 更新 `description` 字段时,归档 plan body / frontmatter 用 fresh value 但 INDEX.md summary 用 stale value | reviewer-claude 提 HIGH（grep 实测 post-step-8b 仅 line 387 仍引用老 fm + 4 case 都未覆盖此场景）/ reviewer-codex 提 MED（同款 line 385 INDEX summary stale 不一致）— 双方独立从「fm/freshFm 同源不变量」角度提出，严重度取保守值 HIGH（同根因漏修破坏自承不变量）|

### ✅ 单方独有 + 反驳轮异构同源（HIGH 升 ✅ 必修）

| ID | 严重度 | 内容 | 反驳轮结论 |
|---|---|---|---|
| **HIGH-B** | HIGH | step 8b parseFrontmatter 后只校验 frontmatter block 是否为空,无 status re-check。caller 在 worktree branch commit 把 status 改 abandoned/completed/未知值时,ff-merge 把改动带进 main → step 9 `{ ...freshFm, status: 'completed' }` 静默归档 abandoned plan 为 completed,违反 user CLAUDE.md §Step 4 中止契约 + 回归 REVIEW_33 H2 已修过的 abandoned 防线 | codex 提 HIGH。**反驳轮**让 reviewer-claude 独立反驳 → reviewer-claude 同意 HIGH 成立（独立数据流演算 + 3 现实场景：(A) caller 中途变卦 / (B) hand_off_session 跨会话漂移 / (C) 多人协作 fork 接管）+ 给 4 个「契约硬破坏 + fix 引入 new vector + 写 git 不可逆 + 同根因 cluster」HIGH 论据。**异构强冗余 ✅ 必修** |

### ❓ 不修（INFO，pre-existing / 概率低 / scope 外）

| 来源 | 严重度 | 内容 | 不修理由 |
|---|---|---|---|
| reviewer-claude | INFO | `plans/INDEX.md` header 4 列 vs auto-append 行 2 列错位 | pre-existing 设计错配，与本次 fix 完全无关 |
| 双方 | INFO/LOW | step 7 ff-merge 与 step 8b re-read 之间理论 race window | 单 caller 串行实践不撞，加 fs.lock / hash check 收益 < 改动成本 |
| 双方 | INFO/LOW | `reread-plan-after-ffmerge` GENERIC hint 措辞偏泛 | 其他 7 phase 也走 GENERIC，独立分析成本高且风险敏感，本 plan scope 外（R3 已专门给 8c 加 phaseHint cleanup 指引）|

### R1 fix 实施（commit `39e7b14`）

- `archive-plan-impl.ts:357-385` 加 step 8c `freshFm.status !== 'in_progress'` re-check + 专用 phaseHint cleanup 指引（git revert HEAD + §Step 4 中止 path）
- `archive-plan-impl.ts:387` `fm.description ?? fm.plan_id` → `freshFm.description ?? freshFm.plan_id`
- `archive-plan.impl-ff-merge-body.test.ts` 加 case 5（description 漂移 → INDEX 用 fresh）+ case 6（status 漂移到 abandoned → postFfMergeErr 拒绝 + 不写 archive）
- 更新顶部 docstring `8 个 phase` → `10 个 phase`

## R2 三态裁决

### ✅ 单方独有 + lead 现场验证（MED 必修）

| ID | 严重度 | 内容 | 验证手段 |
|---|---|---|---|
| **MED-1** | MED | step 8c phaseHint 里 `git revert HEAD` 仅撤 ff-merge 后 tip 一个 commit,但 `git merge --ff-only` 可带入 worktree branch 多个 commit（实测本 plan 收口时已 4+ commit ahead of main）,caller 跟着指引走会撤不干净 | reviewer-codex 单方提 MED + lead `git revert --help` + worktree `git log main..HEAD | wc -l` 实测 4 commit 现场验证。修法：`git reset --hard ORIG_HEAD`（推荐 — 干净简单，archive_plan 失败前 main repo 不会有 caller 未提交改动 → destructive 风险低）+ `git revert ORIG_HEAD..HEAD`（history-preserving 选项,逐 commit revert 但 caller 需处理可能的 conflict）|

### ✅ 单方 INFO + reviewer 主动建议（顺手扫）

| ID | 严重度 | 内容 |
|---|---|---|
| **INFO-1** | INFO | reviewer-claude：`archive-plan-impl.ts:531` PostFfMergePhase 注释「8 个 phase」与实际 type union 10 项不符（R1 fix 改时数错）|
| **INFO-2** | INFO | reviewer-claude：`archive-plan-impl.ts:331-333` 8b 注释「step 9 / step 10 全部用 freshFm」遗漏 step 11（R1 HIGH-A 把 step 11 INDEX summary 切到 freshFm 但注释未同步）|

### R2 fix 实施（commit `f377a11`）

- `archive-plan-impl.ts:386` phaseHint range 修：`git reset --hard ORIG_HEAD`（推荐）+ `git revert ORIG_HEAD..HEAD`（history-preserving）双选项
- `archive-plan-impl.ts:531` 注释 `8 个` → `10 个`，step 范围 `step 8 / 8b / 10-14` → `step 8 / 8b / 10a / 10b / 11 / 12 / 13a / 13b / 14a / 14b`
- `archive-plan-impl.ts:331-333` 8b 注释加 step 11 + invariant 提醒（post-ff-merge 写入路径必须用 freshFm，严禁回到 step 6 fm/planContent — 未来添加新 post-ff-merge step 时务必遵守）
- `archive-plan.impl-ff-merge-body.test.ts` case 6 assertion 同步守门 reset / revert range 两命令

## R3 三态裁决

### ✅ 单方独有 + lead 现场验证（MED 必修）

| ID | 严重度 | 内容 | 验证手段 |
|---|---|---|---|
| **MED-2** | MED | reviewer-codex：step 8c phaseHint 选项 (2)「继续推进」分支不闭合 — 旧版「edit on both main repo and worktree branch」会让 caller 误编辑 main repo plan（uncommitted）→ re-call 时 step 7 ff-merge 撞 dirty working tree 拒绝（git 安全行为：ff-merge 不能修改 dirty 文件）| reviewer-codex 提 + lead 静态追踪 step 6→step 7 merge 路径验证（无 main repo clean preflight）。修法：两选项都先 `git reset --hard ORIG_HEAD` undo ff-merge → 选项 (2) 仅在 worktree branch 修 status: in_progress + commit + re-call（等价干净重跑；reset 已复 main 到 pre-archive 状态，worktree 修完再 ff-merge 自动带进 main）|

### ✅ 单方独有 + 文档实现矛盾（LOW 顺手）

| ID | 严重度 | 内容 |
|---|---|---|
| **LOW-1** | LOW | reviewer-codex：`archive-plan-impl.ts:19` 顶部 docstring step 6 描述「abandoned 也允许收口」,实际 line 250-269 三档分流明示 abandoned reject（REVIEW_33 H2）— 注释与实现矛盾，误导新读者 |

### ✅ 单方 INFO + 同款 doc drift cluster（顺手扫）

| ID | 严重度 | 内容 |
|---|---|---|
| **INFO-3** | INFO | reviewer-claude：`archive-plan-impl.ts:22-25` 文件头 docstring 业务流程清单缺 step 11（R1 HIGH-A 把 step 11 INDEX summary 切到 freshFm 但 docstring 没同步）+ 缺 step 8c 条目（R1 HIGH-B 加了 status re-check 但 docstring 没新增条目）|
| **INFO-4** | INFO | reviewer-claude：`archive-plan-impl.ts:539` PostFfMergePhase docstring「reset --hard 风险高」与 R2 fix 8c phaseHint「reset --hard ORIG_HEAD recommended」**同文件内对同命令安全性表述矛盾** |

### R3 fix 实施（commit `f974d2c`）

- `archive-plan-impl.ts:386-410` phaseHint 选项 (2) 闭合：双选项都先 reset → 选项 (2) 仅在 worktree branch 修 status: in_progress + commit + re-call
- `archive-plan-impl.ts:19-20` 顶部 docstring 改成「仅 in_progress 放行；completed 拒绝防误调；abandoned 拒绝并指向 user CLAUDE.md §Step 4 中止流程（REVIEW_33 H2）」与实现一致
- `archive-plan-impl.ts:22-31` 文件头 docstring 加 step 11 同步 + 加 step 8c 完整条目（fresh status re-check + 引 user CLAUDE.md §Step 4 / REVIEW_33 H2）
- `archive-plan-impl.ts:551-562` PostFfMergePhase docstring 区分「一般阶段（step 10a/10b/11/12/13/14）已累积写入 → reset --hard 风险高」vs「step 8b/8c 例外（无写入累积）→ reset --hard ORIG_HEAD 干净安全（详 8c phaseHint）」
- `archive-plan.impl-ff-merge-body.test.ts` case 6 加 2 反向锚点（`only on the worktree branch` / `do NOT edit main repo`）守门防 caller 误编辑 main

## R4 三态裁决

### ✅ 双方 ack 收口（0 HIGH / 0 MED）

| Reviewer | 结论 |
|---|---|
| **reviewer-claude** | ✅ 可合（grep 实测 0 残留 doc drift，cluster 真收干净）|
| **reviewer-codex** | ✅ 可合推 Phase 4（R3 fix 完整，R4 0 HIGH/MED）|

### ✅ 单方独有 LOW + lead git 拓扑推导（顺手 polish）

| ID | 严重度 | 内容 | 验证手段 |
|---|---|---|---|
| **LOW-2** | LOW | reviewer-codex：step 8c phaseHint 把 `git revert ORIG_HEAD..HEAD` 作为「First step (both choices)」入口,但 caller 选 revert 后走选项 (2) continue 会产生 git 拓扑分叉 — main 带 revert commit (R1..R3),worktree 不知道 → next ff-merge 失败 | lead git 拓扑推导验证（main + ff-merge → main = X + W1 W2 W3 → caller revert range → main = X + W1 W2 W3 + R1 R2 R3 → worktree fix W4 → next ff-merge: main 不是 worktree 祖先 → 失败）。修法：revert range 限定 abandoned 路径专用（选项 1 history-preserving 子分支），选项 (2) continue 显式约束「**must use `git reset --hard ORIG_HEAD`** (not revert)」|

### R4 polish 实施（commit `fa0f0ec`）

- `archive-plan-impl.ts:386-417` phaseHint 调整：「First step (both choices)」只列 `git reset --hard ORIG_HEAD`（干净 + 通用）；revert range 移到选项 (1) abandoned history-preserving 子分支（明确「only valid for option 1 — do NOT use revert for option 2」）；选项 (2) continue 显式约束「must use reset --hard ORIG_HEAD (not revert)」
- `archive-plan.impl-ff-merge-body.test.ts` case 6 加 2 反向锚点（`do NOT use revert for option 2` / `only valid for option 1`）守门未来 hint 措辞 drift 让 caller 撞 git 拓扑分叉

R4 polish 是 LOW 顺手 + reviewer 主动建议 + 用户授权常规流程不打扰，**不再 R5**（SKILL §收口三条件已满足：双方可合 + 0 HIGH/MED + R3 真问题已修通过）。

## 收口总结

### 跨 4 轮 finding 累计

| 轮次 | HIGH | MED | LOW | INFO | 备注 |
|---|---|---|---|---|---|
| R1 | **2**（双方独立 1 + 反驳轮 codex 1） | 1（与 HIGH-A 同根） | 0 | 3 | 反驳轮异构同源把 codex 单方 HIGH 升 ✅ 必修 |
| R2 | 0 | 1 | 0 | 2 | doc nit cluster 顺手扫 |
| R3 | 0 | 1 | 1 | 2 | 选项 (2) 闭合 + doc drift cluster 第二轮收尾 |
| R4 | 0 | 0 | 1 | 0 | LOW 顺手 polish 不 R5 |
| **合计** | **2** | **3** | **2** | **7** | 全 fix（除 ❓ INFO 不修 4 项 pre-existing/scope 外/概率低）|

### 工程价值

1. **ff-merge body overwrite root bug fix**：step 8b 拆两次 read，let `freshContent` + `freshFm` 在 step 9-10-11 全部使用，归档 plan body / frontmatter / INDEX summary 全部反映 caller 在 worktree branch 上的最后一笔收尾 commit
2. **post-ff-merge invariant 完整 carry-forward**：fm/freshFm 切割契约（pre-ff-merge 用 fm preflight + ff-merge target；post-ff-merge 用 freshFm 写入），grep 实测 0 stale 残留，docstring + inline 注释 + 实现代码三层完全对齐
3. **8c status re-check**：守住 user CLAUDE.md §Step 4 abandoned 契约 + 不回归 REVIEW_33 H2 已修过的 abandoned 防线（fix 引入 freshFm 通道后重新建立 invariant）
4. **cleanup hint UX 完整**：phaseHint 给 caller 具体可执行 cleanup 决策树（reset / revert 选哪个，revert 限 abandoned，continue 必须 reset，仅 worktree 修不动 main repo），避免 caller 拿到 GENERIC hint 不知如何下手或踩 git 拓扑分叉坑
5. **测试守门 robust**：6 个 case（4 既有 + 2 新）守门 fix 完整覆盖；case 6 hint anchor 累计 9 个（reset / revert range / §Step 4 / git worktree remove / status: in_progress / only on worktree / do NOT edit main / do NOT use revert for option 2 / only valid for option 1），任一未来 fix drift 即 break case

### 异构对抗节奏总结

R1 双方独立提出 1 HIGH + 反驳轮 codex 单方独有 1 HIGH 双成立 = SKILL §三态裁决「单方独有 + HIGH → 反驳轮」**真发挥作用** —— reviewer-claude R1 没看出 codex 的 status carry-forward 缺失,反驳轮 reviewer-claude 独立验证后给出比 codex 更系统的 HIGH 论据(3 现实场景 + 4 严重度论据);R2/R3 cluster 「fix 一处漏一处」doc drift 4 轮收敛干净;R4 codex 给的 git 拓扑边角 LOW 是 reviewer-claude 没想到的角度,异构对抗的边际价值。整个 plan 收尾质量高 — 是「fix 一处漏一处」cluster 的正向收尾示范。

### 测试基线

- archive-plan tests: **42/42 pass**（impl-core 12 + impl-r33 15 + handler 9 + ff-merge-body **6**，新加 2 case + 既有 4 case）
- 全套 vitest: **602/602 pass + 64 skip + 0 fail**
- typecheck: clean

### 已知 follow-up（不阻塞）

- `plans/INDEX.md` header 4 列 vs archive_plan auto-append 行 2 列错位（pre-existing）→ 留独立 plan
- archive_plan default 路径不查 `<main-repo>/plans/<id>.md`（本次 plan dogfooding archive 仍需 caller 显式传 plan_file_path）→ 留独立 plan（plan §Phase 5 stub）
- 7 个其他 phase（mkdir-plans-dir / write-archived-plan / sync-plans-INDEX / unlink-original-plan / git-add / git-commit / git-worktree-remove / git-branch-D）仍走 GENERIC hint，未来 archive_plan UX 收尾 plan 单独 polish

## 防退化护栏

- **fm/freshFm SSOT 切割契约**：pre-ff-merge phase（step 6/7）用 `fm`；post-ff-merge phase（step 8c 之后到 step 14）必须用 `freshFm` / `freshContent`。新增 post-ff-merge step 时务必遵守 invariant，已在 8b 注释 + PostFfMergePhase docstring 双处提醒
- **status re-check 不可省**：未来若 freshFm spread 流程改写,必须保留 step 8c re-check（防 caller worktree branch 漂移 status 漏检）
- **cleanup hint UX 测试守门**：case 6 hint anchor 9 项守门，未来 phaseHint 措辞改动必须同步 case 6 否则 break

## 引用

- 上游 plan：`archive-plan-content-overwritten-fix-20260515`
- 上游 fix commit：`30467f6`（manual fix p4-d2 plan body 被回滚）
- 触发 plan：`p4-baseadapter-d2-implement-20260515`（首次实测撞到 archive_plan body overwrite bug）
- 相关 review：REVIEW_33（H2 abandoned 防线初次建立 / H9 PostFfMergePhase 引入）
