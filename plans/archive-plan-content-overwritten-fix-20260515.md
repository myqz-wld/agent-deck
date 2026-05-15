---
plan_id: "archive-plan-content-overwritten-fix-20260515"
created_at: "2026-05-15"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/archive-plan-content-overwritten-fix-20260515"
status: "in_progress"
base_commit: "30467f6"
base_branch: "main"
parent_plan_id: "p4-baseadapter-d2-implement-20260515"
---

# archive-plan-content-overwritten-fix-20260515 — archive_plan tool 写 frontmatter 时覆盖 plan 正文 bug fix

## 总目标 & 不变量

修 `mcp__agent-deck__archive_plan` tool 在 ff merge worktree branch 后,把 worktree branch 上的 plan 回写改动用 stub 旧 body 覆盖回滚的 bug。现状让 plan 归档时 `[x]` 完成标记 / 跳过理由 / 已知踩坑修正等 archive 前最后一笔回写**全部丢失**,只剩 frontmatter 改对(status=completed + final_commit + completed_at + parent_rfc_chapter "1")。

**触发场景**:任何 plan 收口走 archive_plan,如果 caller 在 ff merge 之前在 worktree branch 上 commit 了 plan 文件回写(典型 Phase 5 收尾 commit 把 step checklist 状态 / 跳过理由 / 当前进度 全部更新到 final 状态),archive_plan 会用 stub 旧 body 覆盖。本 bug 由 plan `p4-baseadapter-d2-implement-20260515` 实测撞到 + manual fix commit `30467f6`(`docs(plans): 修复 p4-d2 plan 正文被 archive_plan 回滚`)记录。

**Root cause 已实证**:
- `src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts:228-235` step 6 在 ff merge **之前** read planContent
- step 7-8 ff merge worktree branch → main
- step 9-10 用 step 6 读的旧 planContent.body + 改 frontmatter 写新文件 → ff merge 进来的回写被覆盖

**不变量**:
- 修法**只改 frontmatter 字段**(status / final_commit / completed_at / parent_rfc_chapter),**不动 plan 正文**(body 部分)
- ff merge 之前的预检阶段(status check / worktree_path / base_branch 解析)仍正常运行
- 现有 archive_plan unit test 不能 break(预期可能要加 1-2 个 case 守门 ff merge 后 body 保留)
- 行为变化**仅 plan 文件正文不再被回滚**,frontmatter 改动 / git ff merge / 同步 plans/INDEX.md / commit / worktree remove + branch -D / caller session shutdown 全保不变

## 设计决策(不再争论)

### 1. 修法选 A:拆两次 read

**方案 A**(推荐): step 6 拆成两阶段:
- **预检阶段**(ff merge 前): read planContent → parseFrontmatter → status check / 拿 worktree_path / base_branch / parent_rfc_chapter / parent_plan_id 等元数据
- **真写阶段**(ff merge 后,step 9-10 之间): **重新 read** planContent → 拿 fresh body → 改 frontmatter → 写新文件

**方案 B**(不选): frontmatter-only update — 只 sed-like patch frontmatter line 不动 body。**拒绝** — 正文格式可能变(用户手动改 indent / 加 separator),sed 不可靠;parseFrontmatter + stringifyFrontmatter 是结构化解析靠谱。

### 2. 跨 fs / git race 兜底

**方案 A**(推荐): 真写阶段 read 失败(fs 异常 / file 已删)→ throw + git revert ff merge(把 main HEAD 回退到 ff merge 前)。caller 看到 archive_plan 失败,plan 文件状态保持 ff merge 前(stub + frontmatter 未改)。

**方案 B**(不选): fall back 到 step 6 的 planContent + frontmatter 改动 — **拒绝** — 这就是当前 bug 的根因,不能 fall back 到旧 body。

### 3. 单测覆盖

新加 `_R{N}` 测试 case(N=archive-plan tests 现有最大编号 + 1):
- **case 1**: caller 在 worktree branch commit plan 回写(模拟 worktree branch 上 plan 文件 status=in_progress + body 含 `[x]` step) → ff merge 后 archive_plan → assert main repo plan 文件 body 含 `[x]` step + frontmatter status=completed
- **case 2**: caller 没在 worktree branch commit plan 回写(plan 在 worktree branch 仍是 stub) → ff merge 后 archive_plan → assert main repo plan 文件 body 仍是 stub + frontmatter status=completed(预期行为不变)

### 4. 不动其他 archive_plan 行为

scope 严格限 frontmatter-update overwrites plan body bug,**不修**:
- archive_plan default 路径 `.claude/plans/<id>.md` vs `<main-repo>/plans/<id>.md` 选项(本次实测要 caller 显式传 plan_file_path 才找到 — 是 separate behavior 留独立 plan)
- archive_plan abandoned plan handling(已正确)
- 其他 archive_plan tool 边角

## 步骤 checklist

### Phase 1: 实现修复

- [x] **Step 1.1 — 复现 bug + 写 1 case 守门 fail-first 验证**:done by lead-handoff-1 on 2026-05-15, commit 5403b71. 在 archive_plan unit test 框架内用 deps inject custom `runGit` hijack 在 `merge --ff-only` 调用时 mutate `state.files[planFilePath]` 模拟 ff-merge 把 caller worktree branch 回写带进 main working tree。fail-first 验证 ✅(red phase 实测 expected `[x] Step 1.1 — done by lead`,actual `# Plan body content\n\nSome details.` 旧 stub body)。
- [x] **Step 1.2 — 修 archive-plan-impl.ts:228-235 拆两次 read**:done by lead-handoff-1 on 2026-05-15, commit 5403b71. 在 step 8(rev-parse HEAD)后插 step 8b 重新 `await deps.readFile(planFilePath)` + `parseFrontmatter` 拿 `freshContent` + `freshFm`,step 9 / step 10 全部用 freshFm + freshContent。**两层失败兜底**:(a) fresh re-read fail → `postFfMergeErr('reread-plan-after-ffmerge', err)` 与现有 post-ff-merge 失败统一姿势;(b) freshFm 缺 frontmatter block(caller 误删) → 同款 postFfMergeErr 提示责任方修后再调。新增 PostFfMergePhase 值 `'reread-plan-after-ffmerge'`,docstring 也加了 step 8b 描述。
- [x] **Step 1.3 — 跑 Step 1.1 case + 现有 archive-plan unit tests**:done by lead-handoff-1 on 2026-05-15, commit 5403b71. green phase ✅(Step 1.1 case 由 fail → pass)。现有 36 个 archive-plan tests(impl-core 12 + impl-r33 15 + handler 9)全过。

### Phase 2: regression test + 边角

- [x] **Step 2.1 — 加边角 case**:done by lead-handoff-1 on 2026-05-15, commit 5403b71. 在 `archive-plan.impl-ff-merge-body.test.ts` 加 3 case 共 4 个:(1) 主 case caller 在 worktree branch commit 回写 → fresh body 保留;(2) regression caller 没改 plan → 归档 body == stub(行为不变);(3) fresh re-read 失败(state.files.delete 模拟 fs ENOENT) → postFfMergeErr;(4) fresh fm 缺 frontmatter block(caller 误删) → postFfMergeErr 提示责任方。
- [x] **Step 2.2 — 跑全 vitest**:done by lead-handoff-1 on 2026-05-15, commit 5403b71. typecheck pass(无 error)。全套 vitest:**45 file pass / 3 skip / 600 tests pass / 64 skip / 0 fail**。无回归。

### Phase 3: 异构对抗 review

- [x] **Step 3.1 — 异构对抗 review**:done by lead-handoff-2 on 2026-05-15. 起 `agent-deck:deep-code-review` SKILL,team `archive-plan-fix-r1`(id `1894a8a1`)。reviewer-claude `9276ea32` + reviewer-codex `5ae4b15e` 跨 R1+R2+R3+R4 复用同对 teammate(in-process backend SDK 自动 resume)。**4 轮异构对抗 finding 累计**:R1 双方独立 1 HIGH(line 387 INDEX summary stale fm.description)+ 反驳轮 codex 单方独有 1 HIGH(step 8b 后未 re-validate status)被 reviewer-claude 反驳轮异构同源 ✅ 必修(commit 39e7b14 修)+ R2 codex 1 MED(cleanup hint `git revert HEAD` 仅撤 tip)+ claude 2 INFO doc nit(commit f377a11 修)+ R3 codex 1 MED(选项 (2) 闭合防 dirty working tree)+ codex 1 LOW(line 19 docstring abandoned 矛盾)+ claude 2 INFO doc drift(commit f974d2c 修)+ R4 双方 ack ✅ 可合 + codex 1 LOW polish(revert+continue git 拓扑分叉,commit fa0f0ec)。共 2 HIGH + 3 MED + 2 LOW + 7 INFO 全 fix(除 ❓ INFO 4 项 pre-existing/scope 外/概率低不修)。reviewer × 2 已 shutdown,heterogeneous_dual_completed: true。

### Phase 4: 收口

- [x] **Step 4.1 — REVIEW_44.md(2 HIGH 单独存档)+ INDEX 同步**:done by lead-handoff-2 on 2026-05-15。`reviews/REVIEW_44.md` 全文档化 4 轮异构对抗节奏 / R1 双方独立 + 反驳轮 ✅ 必修 / R2 R3 R4 cluster 收敛 / 三态裁决全程 / 工程价值 / 防退化护栏 + `reviews/INDEX.md` 加行
- [x] **Step 4.2 — CHANGELOG_122.md + INDEX 同步**:done by lead-handoff-2 on 2026-05-15。`changelog/CHANGELOG_122.md` 全文档化 fix base + 4 轮 R1/R2/R3/R4 fix 实施细节 + 工作量 / 影响 / follow-up + `changelog/INDEX.md` 加行
- [ ] **Step 4.3 — `mcp__agent-deck__archive_plan` 自动归档**:**dogfooding 关键** — 本 plan 的 archive 会用**修复后**的 archive_plan tool。如果 archive 后 main repo 的归档 plan 文件含 Phase 3.1+4.1+4.2 [x] 标记 + freshFm 透传(包括本节内容)→ bug fix 真生效。如果 [x] 标记丢 → mcp server 没 hot reload 跑的还是旧 buggy 版本,需重启 dev / 重新打包后再 archive,或者手工修像 commit `30467f6` 那样

### Phase 5(可选): archive_plan default 路径修复 — 留独立 plan

archive_plan 默认查 `.claude/plans/<id>.md` 和 `~/.claude/plans/<id>.md`,**不查** `<main-repo>/plans/<id>.md`(本次 p4-d2 plan 实测要 caller 显式传 plan_file_path)。这是独立行为,scope 超本 plan,**留 followup**。

## 当前进度

- ✅ **Phase 1 完成** (Step 1.1+1.2+1.3,commit 5403b71):fix archive-plan-impl.ts 拆两次 read + 1 个 fail-first case 守门
- ✅ **Phase 2 完成** (Step 2.1+2.2,commit 5403b71):regression baseline + 失败兜底 case + 全套 vitest 600 pass / 0 fail
- ✅ **Phase 3.1 完成** (4 轮异构对抗 review × fix,commit 39e7b14 / f377a11 / f974d2c / fa0f0ec):2 HIGH + 3 MED + 2 LOW + 7 INFO 全 fix。reviewer × 2 已 shutdown,heterogeneous_dual_completed: true
- ✅ **Phase 4.1 完成**:`reviews/REVIEW_44.md` 4 轮异构对抗全文档化 + `reviews/INDEX.md` 同步加行
- ✅ **Phase 4.2 完成**:`changelog/CHANGELOG_122.md` 全文档化 + `changelog/INDEX.md` 同步加行
- ⬜ **Phase 4.3 待 dogfooding archive**:本 plan archive 用修复后的 archive_plan tool 验证 [x] 标记保留

## 下一会话第一步

按 user CLAUDE.md cold-start 流程:

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/worktrees/archive-plan-content-overwritten-fix-20260515/plans/archive-plan-content-overwritten-fix-20260515.md` 全文读 plan(强制 cat 不用 Read,详 user CLAUDE.md §Step 3 末尾 callout)。**注意路径是 worktree 内的 plan**(latest 内容在 worktree branch,main HEAD 还没 ff-merge),非 main repo `<main>/plans/...md`(那是 stub 旧版)。
2. `EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/archive-plan-content-overwritten-fix-20260515")` 进 worktree(注意是 path 不是 name;worktree 已存在不需要再建)
3. 自检 worktree HEAD == 最新 commit(应是包含 Phase 1+2 fix 的 commit `5403b71` + plan 更新 commit):
   ```bash
   git -C /Users/apple/Repository/personal/agent-deck/.claude/worktrees/archive-plan-content-overwritten-fix-20260515 log --oneline -5
   ```
4. **node_modules 已 symlink**(上一会话建的 `<worktree>/node_modules → <main-repo>/node_modules`)— 直接 `pnpm exec vitest run ...` 即可。**不要** `pnpm install` / 重建 worktree(会覆盖)。
5. **从 Phase 3.1 起手 — 起 deep-code-review SKILL**:调 Skill tool `agent-deck:deep-code-review`
   - 给 SKILL 的 scope:`src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts` (diff vs base `33381fc`) + `src/main/agent-deck-mcp/__tests__/archive-plan.impl-ff-merge-body.test.ts` (新文件)
   - 给 SKILL 的 focus:
     - **拆两次 read 是否真覆盖 bug 场景** —— step 8b re-read 时机是否正确(必须在 ff-merge 后,step 8 rev-parse HEAD 是 read-only 不影响) / freshFm 替换 fm 是否引入字段语义偏移
     - **是否引入新 race window** —— ff-merge 与 step 8b re-read 之间(fs race / 外部并发改 plan 文件 / git index lock)
     - **失败兜底是否完整** —— `'reread-plan-after-ffmerge'` PostFfMergePhase 值是否合适 / 失败时 main HEAD 已动 caller 该如何手工 cleanup / 缺 frontmatter block 报错措辞
     - **其他 archive_plan 路径是否受影响** —— abandoned plan 仍在 step 6 短路(不到 step 8b)/ archive_caller opt-out / planFilePathOverride 路径 / freshFm 透传可能引入意外字段(如 caller 在 worktree branch commit 添加新 fm 字段是否安全 echo back)
   - 三态裁决:双方独立提出 = ✅ 必修 / 单方独有 + HIGH → 起对方反驳轮 → 仍 ✅ 修 / 单方独有 + MED → lead 自己 grep / 写 mini-test 验证 / 双方都说没问题 = ✅ 可合
6. **review 出 ≥ 1 HIGH finding 必修**:在同 worktree 内改 archive-plan-impl.ts / 测试文件 → 再跑 archive-plan tests + 全套 vitest 验证 → commit message 含「(archive-plan-fix Step 3.1 review fix)」
7. **Phase 3.1 收口后 → Phase 4**:
   - **Step 4.1**:Phase 3.1 异构对抗有 ≥ 2 HIGH finding → 写 `reviews/REVIEW_44.md`(下一个 X 是 44,本 worktree 跑 `ls /Users/apple/Repository/personal/agent-deck/reviews/ | grep -oE 'REVIEW_[0-9]+' | sort -t_ -k2 -n | tail -1` 自检最新);否则合并到 CHANGELOG
   - **Step 4.2**:写 `changelog/CHANGELOG_X.md`(同样 `ls` 自检最新 X)+ `changelog/INDEX.md` 加行 + `plans/INDEX.md` 后续 archive 时同步(archive_plan tool 自动)
   - **Step 4.3 dogfooding archive**:调 `mcp__agent-deck__archive_plan` 显式传:
     - `plan_id: 'archive-plan-content-overwritten-fix-20260515'`
     - `worktree_path: '/Users/apple/Repository/personal/agent-deck/.claude/worktrees/archive-plan-content-overwritten-fix-20260515'`
     - `plan_file_path: '/Users/apple/Repository/personal/agent-deck/plans/archive-plan-content-overwritten-fix-20260515.md'`(default 路径不查 `<main>/plans/`,所以必须显式传)
     - `base_branch: 'main'`(也可不传,frontmatter 已记录)
     **调前**先 `ExitWorktree(action: keep)`(mcp tool 不能调 CLI 内部 ExitWorktree,caller 必须 cwd 不在 worktree 内)
   - **Step 4.3 dogfooding 验证关键**:archive 完毕回项目 root 看 `<main>/plans/<plan-id>.md` 内容,**步骤 checklist 的 [x] 标记应该全部保留**(如果保留 = 本次 fix 真生效;如果丢 = mcp server 没 hot reload 跑的还是旧 buggy 版本,需重启 dev / 重新打包后再 archive,或者手工修像 commit `30467f6` 那样)

⚠️ **跨会话第一次读「长期存在 + 其他会话动过的文件」必须用 `Bash: cat` 而非 `Read` 工具**(详 user CLAUDE.md §Step 3 末尾 callout)— 包括本 plan / archive-plan-impl.ts / 已写 tests / 第一次接触的代码文件。但本会话内自己刚改 / 刚建 / 已 Read 过的文件用 Read 正常。

⚠️ **mcp server hot reload 假设需验证**:archive_plan tool 实现(`archive-plan-impl.ts`)的修改是否需要重启 Electron dev / 重新打包 .app 才生效?如果不 hot reload,Step 4.3 dogfooding 调用走的是旧 buggy mcp 进程内的代码 — bug 仍在,plan body 仍被覆盖。**新会话起 deep-review 之前可先**:`zsh -i -l -c "ps -ef | grep -E '(electron|Agent Deck)' | grep -v grep"` 看 mcp server 在哪个 Electron 进程内,判断是 dev mode 还是已装 .app(dev 改 ts 一般要重启;.app 装的版本完全无法 hot reload)。

## 已知踩坑

- **EnterWorktree(name:) CLI stale base bug**:必走 Bash `git worktree add` + `EnterWorktree(path:)`(详 user CLAUDE.md §Step 1 末尾 callout)
- **worktree 内绝对路径**:Edit / Read / Write / Grep / Glob / Bash `git -C` 全部带 worktree 前缀,否则操作主仓库文件
- **archive-plan-impl.ts 拆两次 read 时机**:第二次 read **必须**在 ff merge 之后(line 8 step 后),不能提前;否则仍读旧 body
- **Step 4.3 dogfooding 验证**:本 plan archive 时用的是**修复后**的 archive_plan tool(同会话内修完直接生效?需确认 mcp server 是否 hot reload OR 重启 dev 才生效) — 如 mcp server 不 hot reload,本 plan 的 archive_plan 调用仍用旧 buggy 版本,需 manual fix(参 p4-d2 plan archive 后 commit `30467f6` 同款手动修)
- **不动 frontmatter 字段集**:fix 仍只改 status / final_commit / completed_at,**不要顺手加** parent_rfc_chapter "1"(本次 archive 把它从 `1` 改 `"1"` 是 yaml 序列化副作用,不要扩大 scope 主动修)

## 相关 followup

- **archive_plan default 路径修复**(本 plan §Phase 5):default 查 `.claude/plans/` 不查 `<main-repo>/plans/`,留独立 plan
- **mcp server hot reload**:archive_plan tool fix 后是否需要重启 dev / 重新打包 .app 才生效,影响 dogfooding 验证 + 后续 plan archive 体验

## 会话风格授权

承袭 user CLAUDE.md §决策对抗 + 本 plan 性质(纯 bug fix,scope 严格收限):
- **修法 A 拆两次 read** 不再争论 — RFC 设计 §1 已 sign-off,实施细节 lead 自主判断
- **Phase 3.1 异构对抗 review HIGH finding** 默认采纳;反驳轮裁决属常规流程不打扰用户
- **新增非 RFC 决策点**(如修 archive_plan 顺手加 mcp hot reload / 改 default 路径)必须告诉用户征得确认或拆 followup
- **真不能拆的决策点**(如 fix 引入新 race / unit test 框架是否要重组)拿不准时停下问用户
- **session 1 (2026-05-15) 用户额外授权**(原话:「你一路推进吧，hand off 的时机你自己决定」+「把上面这个授权也加入到 hand off 里」):后续每个 session 都自主一路推进 + 自己判断 hand-off 时机(不需要每个 phase 中间 stop 问用户),hand-off 时把本授权显式带到下一会话 cold-start prompt 里持续生效。
