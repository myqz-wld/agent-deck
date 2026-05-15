---
plan_id: "archive-plan-tool-ux-followup-20260515"
created_at: "2026-05-15"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/archive-plan-tool-ux-followup-20260515"
status: "in_progress"
base_commit: "99f1e61"
base_branch: "main"
parent_plan_id: "archive-plan-content-overwritten-fix-20260515"
parent_review_id: "REVIEW_44"
---

# archive-plan-tool-ux-followup-20260515 — archive_plan tool UX 完善 4 项一并 followup

## 总目标 & 不变量

REVIEW_44(plan archive-plan-content-overwritten-fix-20260515 收口)留 4 条同主题 followup 一次性收口,**全部属 archive_plan tool UX 完善范畴**(default 路径 / INDEX append 行为 / INDEX 列数错位 / 7 phase GENERIC hint),不动 step 8b/8c invariant carry-forward(已 REVIEW_44 收口)。

**触发场景**:任何 plan 收口走 archive_plan 都会撞 (a)(b);(c) 在 plans/INDEX.md 渲染时露脸;(d) 在 step 10a/10b/11/12/13/14 任一 phase 失败时 caller 拿到 GENERIC hint 不知如何 cleanup。

**不变量**:
- 不动 archive-plan-impl.ts step 6/7/8/8b/8c 已收口的 invariant(REVIEW_44 范围已稳)
- 不动 archive_plan tool 的 abandoned 拒绝路径 / archive_caller opt-out / planFilePathOverride 等正确行为
- 现有 42 个 archive-plan tests 不能 break(impl-core 12 + impl-r33 15 + handler 9 + ff-merge-body 6)
- 全套 vitest baseline 602/602 不能回归

## 设计决策(待异构对抗 + 用户 sign-off)

下面 4 条都需独立设计 review,本 stub 给 hint level 推荐方向,实施会话 lead 自决细节:

### (a) archive_plan default 路径不查 `<main-repo>/plans/<id>.md`

**现状**:`archive-plan-impl.ts` step 5 解析 plan 文件路径优先级 = 显式 `plan_file_path` arg > `<main-repo>/.claude/plans/<id>.md` > `~/.claude/plans/<id>.md`,**不查** `<main-repo>/plans/<id>.md`(项目内 git 归档目的地)。本应用 plans/ 目录是 stub plan 在 in_progress 阶段的实际位置(看 plans/INDEX.md in_progress 行集中在 plans/),caller 调 archive_plan 时必须显式传 plan_file_path 才找到。

**问题**:每次 plan 收口 caller 都得显式传 plan_file_path arg(本 plan 父 plan archive-plan-content-overwritten-fix-20260515 + p4-baseadapter-d2-implement-20260515 都撞过)。降级 archive_plan tool 的 ergonomics。

**hint level 推荐**:扩 fallback 链加 `<main-repo>/plans/<id>.md`(在 `.claude/plans/` 之前还是之后?需 review 决定 — 之前会让 in_progress local 草稿被忽略,之后 OK)。

### (b) archive_plan INDEX 防重复 append 检查跳过 update 现有行

**现状**:`archive-plan-impl.ts` step 11 同步 plans/INDEX.md 时,`if (!indexContent.includes(`(${input.planId}.md)`))` 才 append 新行,否则跳过 update。这意味着如果 plan 文件本身在 in_progress 阶段已经被 caller 手工写到 plans/INDEX.md(典型场景:stub plan 创建时手工加索引行 + 描述),archive_plan 收口时**不会**自动把那行从 in_progress → completed + 关联 changelog。

**问题**:本 plan 父 plan archive-plan-content-overwritten-fix-20260515 收口时撞到(commit 99f1e61 message 提到)— archive_plan tool 没把 INDEX.md 那行从 in_progress 改 completed,需要 caller 手工修改并补一笔 commit。

**hint level 推荐**:把「跳过」改成「smart update」— 检测到 plans/INDEX.md 已含 plan_id 行时,parse 那行 + 替换 status 列为 completed + 替换 changelog 列为最新 X(需要 caller 传 `changelog_id` arg?或者 archive_plan 自己 ls changelog/ 找最新 X?设计 decision)+ 替换 description 列为 freshFm.description(同 step 11 fallback 链)。

### (c) plans/INDEX.md header 4 列 vs archive_plan auto-append 行 2 列错位

**现状**:`plans/INDEX.md` header 是 4 列 `| 文件 | 状态 | 关联 changelog | 概要 |`,但 archive_plan auto-append 行 `archive-plan-impl.ts:395` 写的是 2 列 `| [X.md](X.md) | summary |`。markdown 渲染时 auto-append 行后半空白,「状态 / 关联 changelog」列丢失。这是 pre-existing 设计错配(REVIEW_44 reviewer-claude R1 INFO 提及但 scope 外)。

**hint level 推荐**:auto-append 行也写 4 列,「状态」固定 `completed`(archive_plan 调用时刻 status 必然 completed),「关联 changelog」从 (b) smart update 同款 changelog_id arg 拿 / 或者 archive_plan 写「TBD」让 caller 后续手工补。需 review (b)+(c) 一起设计。

### (d) 7 个其他 phase 仍走 GENERIC hint(reread/reread-empty 已 polish,其他没)

**现状**:`PostFfMergePhase` 10 个 phase 中,只有 `'reread-plan-after-ffmerge'`(step 8b/8c 共用)有专用 phaseHint(REVIEW_44 R3 polish)。其他 7 个(`mkdir-plans-dir / write-archived-plan / sync-plans-INDEX / unlink-original-plan / git-add / git-commit / git-worktree-remove / git-branch-D`)失败时仍走 `POST_FF_MERGE_HINT_GENERIC`,caller 知道「ff-merge 已完成,按 phase 标识手工补完」但具体怎么补不直白。

**hint level 推荐**:每 phase 加专用 phaseHint(类似 8c 的 cleanup 决策树):
- `mkdir-plans-dir`:`mkdir -p <main-repo>/plans` 后 retry archive_plan(retry-safe,ff-merge no-op)
- `write-archived-plan`:fs 错误(disk full / perm denied),修后 retry 同款
- `sync-plans-INDEX`:INDEX 写失败(罕见 race),修后 retry
- `unlink-original-plan`:rm 原 plan 失败(perm denied / 文件已被外部删),手工 rm 后 retry
- `git-add` / `git-commit` / `git-worktree-remove` / `git-branch-D`:git 操作失败,具体 git error 提示对应 cleanup

每个 phase hint 简短(~3 行)给具体动作,不要写成长说明。

### (e) follow-up: stub plan 创建惯例改进(REVIEW_44 §follow-up (f))— 见 §相关 followup

(详 §相关 followup,作为 stretch scope,不强制本 plan 修)

## 步骤 checklist

### Phase 1: 设计 review

- [ ] **Step 1.1 — 读 archive-plan-impl.ts 现状 + 4 条 followup 各自影响范围 grep**:确认 (a)(b)(c)(d) 各自不冲突 + 实施顺序(建议 (a)→(b)→(c)→(d) 或先并行后整合,看 scope)
- [ ] **Step 1.2 — 单点决策对抗 (a)+(b)**:这两条耦合(都涉及 step 11 INDEX 行为),走 user CLAUDE.md §决策对抗主路径双 Bash 起异构外部 CLI(scope 较窄不走多轮 SKILL teammate 模式),决定 fallback 链顺序 + smart update vs 跳过 vs caller 手工
- [ ] **Step 1.3 — (c) 单点决策**:与 (b) 联动,confirmed 后 inline 实施
- [ ] **Step 1.4 — (d) 7 phase hint 措辞**:每 phase 写 ~3 行 cleanup 决策树,先写好草稿再 review

### Phase 2: 实施

- [ ] **Step 2.1 — (a) 改 step 5 fallback 链**:加 `<main-repo>/plans/<id>.md`,加新加守门 case
- [ ] **Step 2.2 — (b) 改 step 11 INDEX 行为**:smart update existing line,加新加守门 case(模拟 INDEX 已含 in_progress 行 → archive 后 status 改 completed + changelog X)
- [ ] **Step 2.3 — (c) 改 step 11 auto-append 行格式 4 列**:与 (b) 共用 changelog_id arg,加新加守门 case
- [ ] **Step 2.4 — (d) 7 phase hint 措辞 inline**:加测试守门 7 phase 各自 hint anchor

### Phase 3: 异构对抗 review × fix

- [ ] **Step 3.1 — 异构对抗 review**:scope = archive-plan-impl.ts diff + 新加 守门 case + plans/INDEX.md 格式变更 / focus = (a)(b)(c)(d) 各自实施是否完整 + 是否引入新 race / cluster 检查 / 7 phase hint 措辞一致性

### Phase 4: 收口

- [ ] **Step 4.1 — REVIEW_X.md(若 ≥ 2 HIGH)或并入 CHANGELOG**
- [ ] **Step 4.2 — CHANGELOG_X.md + plans/INDEX.md 同步**(注意:本 plan 收口走 archive_plan tool,如果 (b) fix 真生效,plans/INDEX.md 会被 smart update 而非 caller 手工修)
- [ ] **Step 4.3 — `mcp__agent-deck__archive_plan` 自动归档**(dogfooding,验证 (a)+(b)+(c)+(d) fix 真生效:archive 后 plan 文件 [x] + INDEX 自动改 completed + 关联 changelog X + 4 列对齐)

## 当前进度

- ⬜ stub 创建,待新会话接力 Phase 1 起手

## 下一会话第一步

按 user CLAUDE.md cold-start 流程:

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/plans/archive-plan-tool-ux-followup-20260515.md` 全文读 plan(强制 cat 不用 Read)
2. `EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/archive-plan-tool-ux-followup-20260515")` 进 worktree
3. 自检 worktree HEAD == 99f1e61(本 stub 创建时 main HEAD):
   ```bash
   git -C /Users/apple/Repository/personal/agent-deck/.claude/worktrees/archive-plan-tool-ux-followup-20260515 log --oneline -3
   ```
4. **node_modules 共享 main repo**(worktree 创建时 git worktree add 默认共享或 fresh,需自检):若不共享 → `cd worktree && pnpm install` 或 symlink 到 main repo node_modules
5. **从 Phase 1 起手** — 读 archive-plan-impl.ts step 5 / step 11 / PostFfMergePhase 现状 + grep 各 caller(看 (a) 影响 / (b) 现有 INDEX 写法 / (c) 当前 4 列 INDEX 例子 / (d) 7 phase 现状 hint)
6. 按 §设计决策 顺序推进 (a)(b)(c)(d),先单点对抗(a)+(b) 耦合决策 → 其他 inline → Phase 3 异构对抗 4 项一起 review

## 已知踩坑

- **mcp server 不 hot reload**(本 stub 创建时 in-process MCP server 实测不 hot reload,详 plan mcp-server-hot-reload-investigation-20260515 — followup 兄弟 plan):本 plan 收口 dogfooding 同样会撞 — 准备 manual fix recipe `git show <last-worktree-commit>:plans/<id>.md` + 改 frontmatter(同 commit 30467f6 / 445eace recipe)
- **EnterWorktree(name:) CLI stale base bug**:必走 Bash `git worktree add` + `EnterWorktree(path:)`(详 user CLAUDE.md §Step 1 末尾 callout)— 本 stub worktree 已用此 recipe 创建
- **worktree 内绝对路径**:Edit / Read / Write / Grep / Glob / Bash `git -C` 全部带 worktree 前缀,否则操作主仓库文件
- **(b) smart update 边角**:caller 在 in_progress 阶段写的 INDEX 行格式可能与 auto-append 不一致(描述列长度 / 关联 changelog 列填空),smart update 时需要边角处理(parse 失败 → 不 update,只 warn?或者退化到原 append behavior)

## 相关 followup

- **(e) mcp-server-hot-reload-investigation-20260515**:in-process MCP server 不 hot reload 的根因调查 + 解决方案 stub(本 stub 创建时同步建,留独立 plan)
- **(f) stub plan 创建惯例改进**:本 stub 创建过程中沉淀的 process 改进候选,已入 `conventions/tally.md` count: 1(累计 3 次后走「升级约定」流程,不在本 plan scope)。具体内涵:stub plan 创建时最小内容标准(frontmatter 必填字段 / 设计决策最小粒度 / 步骤 checklist 最小颗粒 / 已知踩坑 vs 当前进度 vs 下一会话第一步 三 section 模板化)。本 stub 自身已经按通用 plan template 写,可作 reference 之一

## 会话风格授权

承袭 user CLAUDE.md §决策对抗 + 本 plan 性质(纯 UX 完善 4 项收口,scope 严格收限 archive_plan tool):
- **设计决策对抗** Phase 1 单点对抗 (a)+(b) 耦合;(c)(d) inline → 异构对抗 review 4 项一起
- **新增非本 stub 决策点**(如顺手改 archive_plan abandoned 路径 / 改 step 8b/8c invariant)必须告诉用户征得确认或拆 followup
- **真不能拆的决策点**(如 (a) fallback 链顺序冲突 / (b) smart update 与 caller 手工 INDEX 冲突)拿不准时停下问用户
- **session 1 (2026-05-15) 用户授权传递**(原 plan archive-plan-content-overwritten-fix-20260515 起手时):「你一路推进吧,hand off 的时机你自己决定」+「把上面这个授权也加入到 hand off 里」— 本 stub 同步继承,后续每 session 自主推进 + 自定 hand-off 时机
