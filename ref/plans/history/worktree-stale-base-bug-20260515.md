---
plan_id: "worktree-stale-base-bug-20260515"
created_at: "2026-05-15"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/worktree-stale-base-bug-20260515"
status: "completed"
base_commit: "91c4568"
base_branch: "main"
parent_session_observation: "R37 archive_plan 收口后 hand-off 准备阶段实测撞到"
final_commit: "8af36a53cfb2eb2a2c26b1b74524a67641048dc0"
completed_at: "2026-05-15"
---
# worktree-stale-base-bug-20260515 — EnterWorktree CLI 工具创 worktree 用 stale base 排查

## 总目标 & 不变量

排查 application 内部 EnterWorktree CLI 工具创 worktree 时**未使用当前 mainRepo HEAD 作为 base**,而是从 stale source(可能是 application 内部缓存 / 某个 git ref / commit hash 死字段)取 base 的 bug。

**实测复现 trace**(2026-05-15 R37 plan archive_plan 收口后立刻 hand-off 准备阶段):

| 项 | 实际值 |
|---|---|
| mainRepo HEAD(`git rev-parse HEAD`) | `91c4568a7acd7d4e1d5444b1527b8bfd2646ff64`(R37 archive_plan commit) |
| mainRepo `git worktree list` 显示 | `91c4568 [main]` ✓ |
| mainRepo `git branch --show-current` | `main` ✓ |
| ORIG_HEAD | `ffcb663d1be600447dcb6737cbcec9a83f2b9421`(R37 base_commit) |
| FETCH_HEAD | `faad493c9a4d645d030b13bb1eab9487fcec700b` |
| reflog HEAD@{0} | `91c4568 commit: docs(plans): 归档 deep-review-and-refactor-r37-20260515 plan ...` |
| reflog HEAD@{2} | `ffcb663 checkout: moving from main to main`(疑似 archive_plan 内部 cwd 切换) |
| 调 EnterWorktree(name: "codex-claude-adapter-symmetry-20260515") | 创新 worktree branch `worktree-codex-claude-adapter-symmetry-20260515`,**HEAD = `f253794`(落后 main 20 commits!)** |
| f253794 commit message | `docs(claude-config): hand-off 临时文件路径简化为 /tmp(不用清理)` |
| f253794 是 91c4568 的 ancestor | ✓(`git merge-base --is-ancestor` 验证) |
| f253794 不是任何当前 ref 的值 | ✓(HEAD / ORIG_HEAD / FETCH_HEAD / main 都不是 f253794) |
| 修正 | Bash `git -C <worktree-path> reset --hard 91c4568` 后 worktree HEAD = 91c4568 ✓ |

**核心异常**:EnterWorktree 没用当前 HEAD 91c4568 作 base,而用了 f253794(20 commits 之前的某个 commit)。

**潜在影响**:
- 新 worktree base 偏移 → worktree 上 commit 后 ff-merge 到 main 失败(non-ff)→ archive_plan tool 失败
- 用户在新 worktree 修代码,看到的代码是 stale state(20 commits 前的 codebase),改动可能与 main 上已有改动冲突
- 新 worktree 跑测试时 fail / pass 判断基于 stale base,验证不可信

**严重度**:HIGH(影响所有 worktree-based plan 工作流的可靠性)

**不变量**:
- 所有改动 worktree 内跑,主仓库零污染
- **新会话进 worktree 不要再用 EnterWorktree(name:...) 创 worktree**(已被本 plan worktree 覆盖,且会撞同款 bug);用 EnterWorktree(path: <worktree-path>) 进入已建好的 worktree
- 改完 typecheck + 全套 vitest 必跑(若涉及代码改动)
- 行为零变化为目标(纯 bug fix)
- 不引入新功能

## 设计决策(不再争论)

1. **plan worktree 用 Bash 显式 base 创建**:本会话(R37 archive 收口 caller)用 `git worktree add -b worktree-<plan-id> <worktree-path> 91c4568` 直接显式 base,绕开 EnterWorktree CLI bug 保 plan worktree 干净。新会话进入用 `EnterWorktree(path: ...)` 模式(进入已有 worktree,不重新创)
2. **复现实验在临时目录**:新会话排查时若需要复现 bug,**不要在 plan worktree 内**复现(避免污染);用 `Bash: git worktree add /tmp/repro-X` 之类的临时目录走外部 git cli 对照 + 应用内 EnterWorktree CLI 调用做 A/B 对照
3. **排查方向优先级**(reviewer R1 也按此 focus):
    - **方向 A (high)**:application EnterWorktree CLI 实现定位 — grep `worktree add` / `git_worktree` / EnterWorktree handler / IPC channel,看是否用了 cached / hardcoded base
    - **方向 B (high)**:application 内部 worktree state(DB / fs)是否 cache base hash;archive_plan 操作是否 invalidate 该 cache
    - **方向 C (med)**:git plumbing 调用方式 — 用 `git rev-parse HEAD` vs `git symbolic-ref refs/heads/main` vs application 自管 ref(可能拿到 stale 值)
    - **方向 D (med)**:并发 / 时序 — archive_plan 完成 commit 后立即 EnterWorktree,application internal git state cache 是否未 refresh
    - **方向 E (low)**:in-process SDK session 与真实 mainRepo state 之间是否有缓存层 stale
4. **异构对抗 R1 review**:同 R37 模式,reviewer-claude + reviewer-codex teammate 各自独立 audit。reviewer-claude 偏代码 grep + 实现 trace;reviewer-codex 偏 git plumbing + 时序 / race 推理
5. **fix vs document 决策**:R1 root cause 找到后:
    - root cause 清晰 + fix 路径 trivial(< 50 LOC) → 本 plan 内 fix
    - root cause 清晰 + fix 复杂(架构性 / 跨模块) → 本 plan 文档化 root cause + workaround,fix 留独立 plan
    - root cause 找不到 → 本 plan 文档化 trace + 各方向调研结果 + workaround(用 Bash 显式 base 创 worktree)+ 留 follow-up plan
6. **workaround 立即文档化**:无论 fix 还是 document,都在 user CLAUDE.md / 项目 CLAUDE.md 加一条「用 EnterWorktree CLI 创 worktree 后必须 `git log --oneline -3` 自检 HEAD = 当前 main HEAD,偏移则 `git -C <worktree> reset --hard <main-HEAD>` 修正」(typed warning)
7. **跨会话 hand-off**:同 R37,用 `mcp__agent-deck__hand_off_session(plan_id, phase_label)` 自动起新 session + archive caller;新 session **不传 team_name**(同 R37 R3 教训)

## 步骤 checklist

### Phase 1: 排查 + 复现

- [x] **Step 1.1 — 复现实验**:外部 git cli `git worktree add /tmp/wt-repro-cli/wt` baseline 完全正确(worktree HEAD = main HEAD = 91c4568)。reviewer-claude R1 内补做 A/B 实测:`git worktree add ... -b X1`(隐式 HEAD)→ 91c4568 ✓ 与 `git worktree add ... -b X2 origin/main`(模拟 CLI builtin)→ f2537947 ✓ 完全复现 stale base bug
- [x] **Step 1.2 — 代码定位**:grep 25 文件全部教学性 jsdoc / schema description / 用户文档,无 application 内实际 git worktree add 调用;EnterWorktree 是 Claude Code CLI v2.1.112 builtin,binary 在 `/Users/apple/.nvm/versions/node/v24.10.0/lib/node_modules/@anthropic-ai/claude-code/cli.js`,实现核心位置 byte ≈ 11794070
- [x] **Step 1.3 — 异构对抗 R1 review**:team `worktree-stale-base-r1` spawn reviewer-claude (Opus 4.7, sid `2f6292c1`) + reviewer-codex (gpt-5.5 xhigh, sid `551eda2a`) teammate。两份独立 finding 双方一致 ✅ 6 HIGH(含 reflog 加强证据)+ 3 ✅ MED/LOW + 1 ❌(fromHead 隐藏参数)+ 1 ❓(bare/submodule)。fix vs document 分歧 lead 三态裁决 document-only(plan §设计决策 5 阈值「fix 复杂留独立 plan」)。两个 reviewer 已 shutdown

### Phase 2: fix / document(根据 R1 三态裁决决定)

- [x] **Step 2.1 — root cause fix**:**跳过**(lead 裁决 document-only;application 无 hook 点 wrap CLI builtin;唯一应用层 fix 是新增 mcp tool `enter_worktree_safe(plan_id)` 属新功能架构改动留独立 plan)
- [x] **Step 2.2 — root cause document**:`reviews/REVIEW_38.md` 详记 root cause 全 trace + A/B 实测铁证 + helper 实现独立验证 + CLI tool description vs implementation 矛盾 + R1 三态裁决 + workaround 4+1 候选评估 + 触发条件矩阵 + application 层 fix 空间分析 + upstream GitHub issue recipe + 长远 fix 提案锚点 + reviews/INDEX.md 加行(commit 8af36a5)
- [x] **Step 2.3 — workaround 文档化**:user CLAUDE.md §「复杂 plan: worktree 隔离 + 跨会话 hand off」§Step 1 加「⚠️ EnterWorktree CLI **stale base bug**(v2.1.112 实测,必看)」typed warning + 主路径 (b) Bash 显式创 + 兜底 (a) 自检 + reset 修法 + 何时仍可用 EnterWorktree(name) 三档判断(直接 Edit `~/.claude/CLAUDE.md`,不入 worktree git tree)

### Phase 3: 收口

- [x] **Step 3.1 — R2 复审**:**跳过**(仅 doc-only 无 fix commit 不需复审)
- [x] **Step 3.2 — REVIEW_38.md + reviews/INDEX.md 加行**:同 Step 2.2(commit 8af36a5)
- [x] **Step 3.3 — CHANGELOG_111.md + changelog/INDEX.md 加行**:`changelog/CHANGELOG_111.md` 简记 + INDEX 加行(commit 8af36a5)
- [ ] **Step 3.4 — archive_plan**:调 `mcp__agent-deck__archive_plan` 自动归档(前置 ExitWorktree(action: "keep"))

## 当前进度

- ✅ R37 archive_plan 完成,main HEAD = 91c4568
- ✅ codex-claude-adapter-symmetry-20260515 plan 已起 + 接力新会话(`008c3906-239e-48cf-a2de-03faa95c7d51`)
- ✅ 本 plan 文件创建(本节)
- ✅ 本 plan worktree 用 Bash 显式 base 创建(避开 EnterWorktree bug)
- ✅ **Step 1.1 复现实验完成**:外部 git cli `git worktree add /tmp/wt-repro-cli/wt` 直接调 → worktree HEAD = main HEAD = 91c4568(完全正确)。说明 git 本身无 bug,问题在 application / CLI 层
- ✅ **Step 1.2 grep 完成**:`worktree add` / `EnterWorktree` 在 application source 25 个文件全部只是 jsdoc / schema description / 用户文档**教学性提及**,**没有任何 git worktree add 实际调用**。EnterWorktree 是 **Claude Code CLI v2.1.112 builtin 工具**,不是 application 实现
- ✅ **Root cause 100% 实证定位**:CLI 自带的 EnterWorktree builtin 工具默认用 `origin/<default-branch>` 作 base,**不用本地 HEAD**。Bug 实证链:
    1. CLI binary 路径:`/Users/apple/.nvm/versions/node/v24.10.0/lib/node_modules/@anthropic-ai/claude-code/cli.js`(13MB minified bundle,v2.1.112)
    2. EnterWorktree 实现位置:cli.js byte 11793500-11794800(`worktree add` 实际调用 ≈ byte 11794069)
    3. 实现逻辑(pretty-printed minified):
       ```js
       // 默认分支(没传 fromHead/prNumber 显式选项)
       let [P, W] = await Promise.all([UZ(), RW(q)]);  // P = 默认分支名(main/master)
       let D = `origin/${P}`;
       let Z = W ? await kr(W, `refs/remotes/origin/${P}`) : null;
       if (Z) { $ = D; j = Z; }     // ← 用 origin/main 而非本地 HEAD!
       // ...
       J.push("--no-track", "-B", Y, z, $);    // git worktree add --no-track -B <branch> <path> origin/main
       ```
    4. CLI tool description **明文承诺**:`In a git repository: creates a new git worktree inside .claude/worktrees/ with a new branch based on HEAD`(at byte 9141445)
    5. **实现与 contract 严重不符**:description 说 base = HEAD,实际 base = origin/<default-branch>
    6. 实证 trace:
       - 本地 HEAD = `91c4568` (R37 archive commit, 未 push)
       - origin/main = `f2537947`(== plan 里观察到的 stale base `f253794` ✓)
       - 本地 ahead origin/main 20 commits → 新 worktree 直接落后 20 commits
       - 复现条件:任何「commit but not pushed」场景必中(R37 archive 后立即 hand-off 触发是典型例子)
- ⬜ Step 1.3 异构对抗 R1 review(confirm root cause 推理 + 评 workaround 方案)

## 下一会话第一步

按 user CLAUDE.md cold-start 流程:

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/worktree-stale-base-bug-20260515.md` 全文读 plan
2. `EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/worktree-stale-base-bug-20260515")` 进 worktree(用 `path` 不是 `name`)
3. `git log --oneline -3` 自检 HEAD = 91c4568
4. **从 Step 1.1 开始**:在 `/tmp/wt-repro-X/` 等临时目录跑复现实验(不要在 plan worktree 内复现避免污染),记录复现 trace
5. Step 1.2 grep 找 EnterWorktree CLI 实现
6. Step 1.3 spawn 一对 R1 reviewer-claude + reviewer-codex(team `worktree-stale-base-r1`),init prompt 含完整 trace + 5 排查方向 + Step 1.2 grep 输出

⚠️ **跨会话第一次读 plan 必须用 `Bash: cat` 而非 `Read` 工具**(详 user CLAUDE.md §Step 3 末尾 callout)

## 会话风格授权(autonomous mode)

**承袭 R37 plan「会话风格授权」节**:

- **连续推进**:lead 不需为每一步切换 / 决策征求用户确认;按 plan checklist 顺序自主推进,遇真歧义才停下问用户
- **lead 自主决定 hand-off 时机**:按 user CLAUDE.md §Step 2.5 触发信号综合判断
- **指令一路传下去**:本节是接力会话风格 SSOT
- **本节不动**:除非用户明示撤回授权,新 session 不删 / 不改本节

**触发用户介入的真歧义清单**:同 R37(plan 决策外的二选一 / 测试失败疑似真 bug / 真不能拆 ≥ 500 LOC 边界拿不准 / 用户显式新指令 / 安全 / 数据可逆性高风险操作)

## 已知踩坑

- **不能在 plan worktree 内复现 bug**:会污染 worktree state + 与本 plan 改动混淆;复现实验严格在 `/tmp/wt-repro-X/` 等临时目录跑
- **EnterWorktree 已被本会话用过一次确认 bug 真实存在**,新会话进入应该用 `EnterWorktree(path: ...)` 模式(已建好的 worktree),**绝对不要**再用 `EnterWorktree(name: ...)` 创新 worktree
- **archive_plan 前置必须先 ExitWorktree**(CLI 内部 tool 限制)
- **base_branch 是 main**(本 plan 切 worktree 时主仓库 HEAD 在 main)
- **本 plan worktree 是 Bash 显式创建的**:与 application 内部 worktree state 可能不同步(application 不知道这个 worktree 是它自己创的还是外部创的)。如果新会话调 ExitWorktree(action: remove) 失败,fall back Bash `git worktree remove` 手工删
- **复现实验若一直无法复现 bug**:也是有价值的信息(说明 bug 是 race / 时序条件触发,需要更精细的复现条件);文档化「无法稳定复现」也是合法 R1 结论
