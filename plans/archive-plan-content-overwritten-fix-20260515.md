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

- [ ] **Step 1.1 — 复现 bug + 写 1 case 守门 fail-first 验证**:在 archive_plan unit test 框架内复现 bug(模拟 caller 在 worktree branch commit plan 回写 → ff merge → archive_plan → assert body 保留)。先让 case 在现 archive-plan-impl.ts fail,然后 Step 1.2 fix 让它 pass(red-green test 模式)。
- [ ] **Step 1.2 — 修 archive-plan-impl.ts:228-235 拆两次 read**:
  - 保留预检阶段 read planContent + parseFrontmatter(已有)
  - 在 ff merge 后(line ~310-330 step 8 后)加「重新 read」一段(`fmFreshContent = await deps.readFile(planFilePath)` + `parseFrontmatter` 拿 fresh fm + body)
  - step 10 用 fresh body + 改 frontmatter 写新文件
  - 失败兜底:fresh read fail → throw + git revert(用现有 `postFfMergeErr` helper 类似模式)
- [ ] **Step 1.3 — 跑 Step 1.1 case + 现有 archive-plan unit tests**:Step 1.1 case 必须 green(行为变化兑现);现有 unit tests 全过(行为不变)

### Phase 2: regression test + 边角

- [ ] **Step 2.1 — 加边角 case**:caller 没在 worktree branch commit plan 回写(plan 在 worktree branch 仍是 stub)→ archive_plan 仍正常 → main repo plan body 仍是 stub + frontmatter status=completed(预期行为不变)
- [ ] **Step 2.2 — 跑全 vitest**:typecheck + 全套 vitest 一遍(确认 fix 不破坏其他模块)

### Phase 3: 异构对抗 review

- [ ] **Step 3.1 — 异构对抗 review**:起 `agent-deck:deep-code-review` SKILL,reviewer-claude + reviewer-codex teammate
  - scope = archive-plan-impl.ts diff + 新加 unit test
  - focus = 「拆两次 read 是否真覆盖 bug 场景 / 是否引入新 race window / 失败兜底是否完整 / 其他 archive_plan 路径(abandoned / archive_caller opt-out)是否受影响」
  - 三态裁决修 ✅ HIGH

### Phase 4: 收口

- [ ] **Step 4.1 — REVIEW_X.md(可选)**:若 Phase 3.1 异构对抗有 ≥ 2 HIGH finding → 单独入 review;否则合并到 CHANGELOG
- [ ] **Step 4.2 — CHANGELOG_X.md + plans/INDEX.md 同步**
- [ ] **Step 4.3 — `mcp__agent-deck__archive_plan` 自动归档**(注意:本 plan 的 archive 会用**修复后**的 archive_plan tool — 是 dogfooding 验证,如果本 plan 的 step checklist `[x]` 标记在 archive 后保留,bug fix 真有效)

### Phase 5(可选): archive_plan default 路径修复 — 留独立 plan

archive_plan 默认查 `.claude/plans/<id>.md` 和 `~/.claude/plans/<id>.md`,**不查** `<main-repo>/plans/<id>.md`(本次 p4-d2 plan 实测要 caller 显式传 plan_file_path)。这是独立行为,scope 超本 plan,**留 followup**。

## 当前进度

- ⬜ **stub 状态**:本 plan 已建文件 + commit stub。未启动实施。
- ⬜ Step 1.1 起手(先复现 bug 写 fail-first case)

## 下一会话第一步

按 user CLAUDE.md cold-start 流程:

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/plans/archive-plan-content-overwritten-fix-20260515.md` 全文读 plan(强制 cat 不用 Read,详 user CLAUDE.md §Step 3 末尾 callout)
2. **避开 EnterWorktree CLI stale base bug**(详 user CLAUDE.md §Step 1 末尾 callout):用 Bash 显式建 worktree(隐式用 HEAD 作 base):
   ```bash
   git -C /Users/apple/Repository/personal/agent-deck worktree add -b worktree-archive-plan-content-overwritten-fix-20260515 /Users/apple/Repository/personal/agent-deck/.claude/worktrees/archive-plan-content-overwritten-fix-20260515
   ```
   然后 `EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/archive-plan-content-overwritten-fix-20260515")` 进入(注意是 path 不是 name)
3. 自检 worktree HEAD == main HEAD == frontmatter `base_commit` (`30467f6`):
   ```bash
   git -C /Users/apple/Repository/personal/agent-deck/.claude/worktrees/archive-plan-content-overwritten-fix-20260515 rev-parse HEAD
   git -C /Users/apple/Repository/personal/agent-deck rev-parse HEAD
   ```
   不等 → `git -C <worktree-abs-path> reset --hard <main-HEAD>` 修正
4. `Bash: cat` 读 archive-plan-impl.ts 主体 + 已有 unit tests:
   ```bash
   cat /Users/apple/Repository/personal/agent-deck/.claude/worktrees/archive-plan-content-overwritten-fix-20260515/src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts
   ls /Users/apple/Repository/personal/agent-deck/.claude/worktrees/archive-plan-content-overwritten-fix-20260515/src/main/agent-deck-mcp/__tests__/archive-plan*
   ```
5. **从 Step 1.1 开始动手**(先复现 bug 写 fail-first case,模拟 caller 在 worktree branch commit plan 回写后 archive_plan 用 stub body 覆盖)
6. 改完每步:
   - **路径全用 worktree 内绝对路径**(详 user CLAUDE.md §Step 1 末尾 callout)
   - `pnpm typecheck` + 跑相关 archive-plan unit tests 必跑
   - commit message 含「(archive-plan-fix Step <X.Y>)」
7. 决策点(非 plan 内已 SSOT 决定的)告诉用户征得确认

⚠️ **跨会话第一次读「长期存在 + 其他会话动过的文件」必须用 `Bash: cat` 而非 `Read` 工具**(详 user CLAUDE.md §Step 3 末尾 callout)— 包括本 plan / archive-plan-impl.ts / unit tests / 第一次接触的代码文件

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
