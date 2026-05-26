---
review_id: REVIEW_38
title: Claude Code CLI v2.1.112 EnterWorktree builtin 默认 base 用 origin/<default-branch> 而非 HEAD（contract vs impl 矛盾 bug）— R1 异构对抗 audit + document-only 收口
created_at: 2026-05-15
plan_id: worktree-stale-base-bug-20260515
worktree_path: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/worktree-stale-base-bug-20260515
base_commit: 91c4568
final_commit: TBD
heterogeneous_dual_completed: true
---

# REVIEW_38 — Claude Code CLI v2.1.112 EnterWorktree builtin stale base bug × 异构对抗 R1 audit × document-only 收口

## 触发场景

R37 archive_plan 收口后立即 hand-off 准备阶段实测撞 bug：调 `EnterWorktree(name: "X")` 创新 worktree → 新 worktree HEAD = `f253794`（origin/main 当时位置），**落后本地 main HEAD 91c4568 二十个 commit**。表象像「application 内部缓存了 stale base」，实测后定位为 **Claude Code CLI v2.1.112 builtin EnterWorktree 工具的 contract vs implementation 矛盾 bug**（CLI 自带工具实现与自身 tool description 严重不符）。本 review 走 user CLAUDE.md §决策对抗 多轮深度 review 模式（R1 异构对抗 reviewer-claude + reviewer-codex teammate），**confirm root cause + 评 workaround / fix 路径 + 文档化 trace + upstream issue 撰写指引**。本 plan 不修代码（root cause 在上游 CLI binary，application 层没有 fix 路径），走 **document-only** 收口。

## 方法

### Scope = 单一 root cause 排查

实测 bug trace（`91c4568 vs f253794`） + 5 排查方向（A: application EnterWorktree CLI 实现 / B: application worktree state cache / C: git plumbing 调用方式 / D: 时序 race / E: in-process SDK 与真实 mainRepo state cache 层）→ lead 独立 grep + minified bundle 反编译 → 100% 实证定位 root cause 后 spawn R1 异构对抗 review confirm。

### 异构对抗 reviewer

| 轮次 | reviewer-claude | reviewer-codex | team |
|---|---|---|---|
| **R1** | 1 teammate (focus 代码 + minified bundle 验证 + application 层 fix 空间) | 1 teammate (focus git plumbing / git semantics / 时序 / race + workaround git 行为评估) | `worktree-stale-base-r1` |

异构 focus 差分：reviewer-claude 偏代码路径（独立 grep cli.js + helper 实现 + A/B 实测 worktree HEAD），reviewer-codex 偏 git plumbing（man page + reflog + ref 文件 + 触发条件矩阵）。两份独立 finding 由 lead 做三态裁决整合。

### 工作流（grep + 实证 → R1 → 三态裁决 → document-only 收口）

- **Step 1.1 复现实验**：外部 git cli `git worktree add /tmp/wt-repro-cli/wt` 直接调 → worktree HEAD = main HEAD（baseline 完全正确，证明 git 本身无 bug）
- **Step 1.2 grep**：`worktree add` / `EnterWorktree` 在 application source 25 文件全部教学性提及（jsdoc / schema description / 用户文档），**无实际 git worktree add 调用**。EnterWorktree 是 **Claude Code CLI v2.1.112 builtin**，不是 application 实现
- **Step 1.3 R1 异构对抗 review**：spawn reviewer-claude (Opus 4.7) + reviewer-codex (gpt-5.5 xhigh) 两个 teammate（team `worktree-stale-base-r1`），各自独立 audit 6 项任务（confirm root cause 实现读法 / 边角排查 / application 层 fix 空间 / workaround 4 候选 / fix vs document 决策 / upstream report 建议）
- **R2 跳过**：本 plan 走 document-only 无 fix commit，无需 R2 验证 fix 不引新 bug

## Root cause 100% 实证定位

### 1. EnterWorktree 是 Claude Code CLI builtin，不是 application 实现

| 证据 | 实测值 |
|---|---|
| Application source `worktree add` 调用 | 25 文件全部教学性 jsdoc / schema description（无 git worktree add 实际 spawn） |
| Application source `EnterWorktree` 提及 | 同上，全为名词引用 |
| Claude Code CLI binary | `/Users/apple/.nvm/versions/node/v24.10.0/lib/node_modules/@anthropic-ai/claude-code/cli.js`（13MB minified bundle, v2.1.112） |
| CLI sdk-tools.d.ts EnterWorktree input schema | 仅 `name?: string` + `path?: string`，无 base / from / commit 字段 |

### 2. CLI builtin 实现：默认 base = `origin/<default-branch>`，不是本地 HEAD

cli.js EnterWorktree 实现核心位置约在 byte 11793500-11854800 区段（不同抽取工具显示的 byte position 略有偏差：lead grep -obn = 11794069 / reviewer-claude node string position = 11794070 / reviewer-codex 工具 = 11854355；皆指向同一段 minified 代码）。

**实现逻辑**（pretty-printed minified，三方独立验证一致）：

```js
let w = {...process.env, ...IR}, $, j = null;

if (_?.fromHead) $ = "HEAD";              // 选项 fromHead → HEAD（schema 不暴露此选项）
else if (_?.prNumber) { /* fetch PR */ } // 选项 prNumber → FETCH_HEAD（schema 不暴露）
else {
  // ★ 默认分支：EnterWorktree(name) 走这里
  let [P, W] = await Promise.all([UZ(), RW(q)]);  // P = default branch name, W = git dir
  let D = `origin/${P}`;
  let Z = W ? await kr(W, `refs/remotes/origin/${P}`) : null;
  if (Z) { $ = D; j = Z; }                 // ★★ origin/main 存在 → base = "origin/main"
  else {
    let { code: G } = await M7(D7(), ["fetch","origin",P], {...});
    $ = G === 0 ? D : "HEAD";              // fetch 成功还是 origin/main; 失败才 HEAD
  }
}
if (!j) { /* rev-parse $ → j */ }
let H = v7().worktree?.sparsePaths;
let J = ["worktree","add"];
if (H?.length) J.push("--no-checkout");
J.push("--no-track","-B", Y, z, $);  // git worktree add --no-track -B <branch> <path> origin/main
```

**helper 实现独立验证**（reviewer-claude 全部 cli.js grep 跑过）：

| helper | 行为 | stale 风险 |
|---|---|---|
| `UZ()` = `getCachedDefaultBranch()` → `hA1()` → `I16.get("defaultBranch", bl5)` | LRU cache 仅缓存 default branch **name**（"main"/"master"），不缓存 commit hash | ❌ 不引入额外 stale |
| `bl5()` | 先试 `refs/remotes/origin/HEAD` symbolic ref → 不行试 `["main","master"]` ref → 都没 fallback `"main"` 字符串 | 仅决定 name，不决定 commit |
| `kr(gitdir, refname)` | `fs.readFile(<git_dir>/<refname>, "utf-8")` 直接读 ref **真实文件** | ✅ 但 ref 文件本身就是 last-fetch 缓存值（git 设计如此），是 bug 的根本来源 |
| `M7(D7(), args, opts)` | spawn `git` 子进程跑 args | 透明执行 |

**结论**：bug 100% 由「git 自身的 `refs/remotes/origin/<default>` ref 文件是 last-fetch 缓存（设计如此）+ CLI 默认选这个 ref 而非 `HEAD`」造成。

### 3. CLI tool description 明文承诺 `based on HEAD` — 与实现严重不符

cli.js byte 9141370 / 9141445（tool description 字符串字面量）：

```
## Behavior

- In a git repository: creates a new git worktree inside `.claude/worktrees/` with a new branch based on HEAD
- ...
```

**Description vs implementation 直接矛盾**：description 说 `based on HEAD`，实际 implementation `based on origin/<default-branch>`。

### 4. git semantics 角度：git 不会 fallback 到本地 HEAD

reviewer-codex 用 git man page 验证：

- `git-worktree.1:229-247`: `-B <new-branch>` 在显式 `<commit-ish>` start-point 时**直接 reset existing branch 到该 start-point**
- `git-branch.1:292-294`: `--no-track` 仅禁用 upstream tracking config，与 base 无关

reflog 直接证据：`.git/logs/refs/heads/worktree-codex-claude-adapter-symmetry-20260515:1` line 1 为 `branch: Created from origin/main`，line 2 才 `reset: moving to 91c4568`（lead 后续手动 reset 修正）→ **明确证明 git 接收的 start-point 就是 `origin/main`，不是 HEAD**。

### 5. 实证三角验证

| 项 | 实测值 |
|---|---|
| 本地 HEAD（R37 archive commit, 未 push） | `91c4568a7acd7d4e1d5444b1527b8bfd2646ff64` |
| `origin/main`（last fetch 状态） | `f2537947c2857efdef10ef8c8ec3868d028f6e86` |
| 调 `EnterWorktree(name: "X")` 后 worktree HEAD | `f253794`（== origin/main, ahead 本地 HEAD 20 commits） |
| `f2537947` commit message | `docs(claude-config): hand-off 临时文件路径简化为 /tmp（不用清理）` |
| `git worktree add /tmp/wt-A -b X1`（外部 cli 隐式 HEAD） | worktree HEAD = `91c4568` ✓ |
| `git worktree add /tmp/wt-B -b X2 origin/main`（外部 cli 模拟 CLI builtin） | worktree HEAD = `f2537947` ✓ 完全复现 |

A/B 实测三角验证铁证 root cause **deterministic 100%**（不是 race / 不是应用层 cache / 不是 SDK 状态问题）。

## R1 三态裁决（共 9 ✅ HIGH/MED + 1 ❓ INFO + 1 ❌）

### 双方独立验证（✅ HIGH）

| # | finding | reviewer-claude | reviewer-codex | 三态 |
|---|---|---|---|---|
| H1 | Root cause = CLI v2.1.112 builtin EnterWorktree 默认 base = `origin/<default-branch>` ≠ HEAD | HIGH（A/B 实测铁证 + helper 实现独立验证） | HIGH（git semantics + man page + reflog 三方实证） | ✅ HIGH 双方独立 |
| H2 | reflog `branch: Created from origin/main` 直接证明 git 接收 start-point 是 `origin/main` | — | HIGH（`.git/logs/refs/heads/...` 实证） | ✅ HIGH 加强证据（不削弱 H1，强化整 root cause 链） |
| H3 | Deterministic（非 race / 非应用层 cache） | MED（kr fs.readFile + LRU cache 只缓存 name） | MED（实证 logs/refs/heads/main 已更新但 origin/main 未变） | ✅ MED 双方独立 |
| H4 | CLI tool description vs implementation 严重不符 | HIGH | HIGH | ✅ HIGH 双方独立 |
| H5 | Upstream 应按 bug 报（不是 by-design） | HIGH | HIGH | ✅ HIGH 双方独立 |
| H6 | Workaround (b) Bash `git worktree add -b ... <path>`（隐式 HEAD）是主路径 | ★★★ 强推（A/B 实测铁证） | M3 「git 语义上更干净的 workaround」 | ✅ HIGH 双方独立 |

### 单方独有 + 现场验证（✅ MED/LOW）

| # | finding | 来源 | 现场验证 | 三态 |
|---|---|---|---|---|
| M1 | 触发条件矩阵（必中 / 不撞 / 边角，含 init.defaultBranch / shallow clone / fetch refspec / 多 remote 等） | reviewer-codex M1（reviewer-claude 简版 3 条） | reviewer-codex 用 cli.js byte 970800-972330 + `git status --short --branch` + `.git/config` 实测 | ✅ MED 文档化 |
| M2 | Application 层无 fix 空间（hand_off_session / archive_plan 都不在 EnterWorktree 调用链） | reviewer-claude（Read 全文 hand-off-session-impl.ts 312 LOC + archive-plan-impl.ts L1-120） | — | ✅ MED 实证 |
| L1 | 排除其他 git 解释（detached HEAD / FETCH_HEAD / packed-refs / fetch refspec / reflog 都不能解释） | reviewer-codex L1 | reviewer-codex 用 `remote -v` / `config --get-all remote.origin.fetch` / `show-ref` 实测排除 | ✅ LOW 完备性 |

### 单方独有 + lead 决策 override（fix vs document 分歧）

| # | finding | reviewer-claude | reviewer-codex | lead 三态裁决 |
|---|---|---|---|---|
| D1 | 本 plan 走 fix 还是 document？ | document-only（plan §设计决策 5 阈值「fix 复杂留独立 plan」分支） | 建议 fix（document-only 不够，静默 stale base 风险高） | **lead 裁决：本 plan document-only + 留独立 plan「`enter_worktree_safe` mcp tool」提案**。理由：(a) 两边 fix 内容一致（新 mcp tool）分歧仅在「本 plan 做 vs 独立 plan」；(b) plan §设计决策 5 阈值优先 + reviewer-claude 验证 hand_off / archive_plan 不在调用链 → 命中「root cause 清晰 + fix 复杂(架构性新功能数百 LOC + schema + canUseTool + IPC + 测试) → 文档化 root cause + workaround，fix 留独立 plan」；(c) reviewer-codex 的 normative judgment「不够」是合理担忧但非 evidence 冲突，可通过 user CLAUDE.md typed warning 主路径替代缓解。**未走反驳轮**：分歧不是 evidence 冲突而是 normative scope 判断，lead 有 plan 阈值上下文可合理 override |

### 排除（❌）

| # | finding | 来源 | 排除理由 |
|---|---|---|---|
| X1 | `fromHead` 隐藏参数 workaround | reviewer-codex INFO | reviewer-codex 自评「内部 API 随时改，不可靠」+ schema 不暴露此参数公开使用违反 SDK 兼容性原则 |

### 未验证（❓）

| # | finding | 来源 | 未验证原因 |
|---|---|---|---|
| U1 | bare repo / submodule 触发面 | reviewer-codex U1 | 未在本机复现，仅推断（基于同一 `bl5()` ref 选择逻辑应同样触发，但路径细节没实测）。**留 INFO 不阻塞** |

## Workaround 评估 + 推荐 ranking

按可靠性 + 易用性排序（reviewer-claude / reviewer-codex 评估整合）：

| 排名 | 候选 | 可靠性 | 易用性 | 副作用 | 推荐度 |
|---|---|---|---|---|---|
| **★★★** | **(b) Bash `git worktree add -b worktree-<id> <path>`**（省略 `<commit-ish>` 隐式用 HEAD） | ✅ A/B 实测铁证（reviewer-claude）+ git man page 语义保证（reviewer-codex） | 一行 Bash | 绕开 CLI 内部 orphaned worktree heal / sparse checkout 等附加功能（一般用不上）；branch 已存在 / path 已存在 / unborn HEAD 时失败 | **强推**：作为 user CLAUDE.md §Step 1 主路径替代 EnterWorktree(name: ...) 创 worktree。**已被本 plan worktree 自身采用并验证铁证** |
| **★★** | **(a) user CLAUDE.md 加自检 + reset-hard 修法** | ✅ 但靠人/agent 主动跑 | 中等（自检 + reset 两步） | 漏跑就再撞；reset 是 destructive 需谨慎；submodule 需单独 `--recurse-submodules`；worktree 内已 tracked 修改会丢 | **推荐作为补充**：与 (b) 互补 — (b) 是 ex-ante 防御，(a) 是 ex-post 修复 |
| **★** | (c) push 后再 EnterWorktree | ✅ 但要求强（push 不总允许 / 不总干净；EnterWorktree 读本地 remote-tracking ref 不是远端服务器状态） | 反直觉；违背「本地 commit 不立即 push」工作流 | — | 不推荐 |
| **✗** | (d) Application 层包装 EnterWorktree builtin | ❌ 不可行 | — | application 没 hook 点 — EnterWorktree 是 CLI / SDK builtin，application 接收 SDK message 后处理，不在调用链上 | 排除 |
| (新增) | **(e) 新增 mcp tool `enter_worktree_safe(plan_id)` 自动化 §Step 1** | ✅ 长远最佳 | 长远最佳 | 新功能数百 LOC + schema + canUseTool + 测试 | **留独立 plan 提案**（本 plan scope 外） |

## Workaround 落地：user CLAUDE.md §Step 1 typed warning

将在用户级 CLAUDE.md `~/.claude/CLAUDE.md` §「复杂 plan：worktree 隔离 + 跨会话 hand off」§Step 1 节加入 typed warning + (b) workaround 主路径 + (a) 兜底自检命令。**本 review commit 同步更新该文档**（详 CHANGELOG_111）。

应用级 CLAUDE.md（项目根 `CLAUDE.md`）和应用打包 CLAUDE.md（`resources/claude-config/CLAUDE.md`）**不需要改动** —— 该 typed warning 是通用 plan-driven workflow 约束（不限本 application 项目），落用户级 CLAUDE.md 单点 SSOT 即可。

## 触发条件矩阵（reviewer-codex M1 文档化 + reviewer-claude 边角补充）

### 必中条件（任一即触发）

- 本地 `HEAD != refs/remotes/origin/<P>`（其中 `<P>` = default branch name），且该 remote-tracking ref 存在
- 包括：本地 ahead origin / 本地 behind origin / 本地 divergent / detached HEAD 指向非 `origin/<P>`
- 典型场景：commit 但未 push（R37 archive 后立即 hand-off 是典型）/ `git pull` 完后立即 commit / feature branch 上 commit 未 push

### 不撞条件

- `HEAD == origin/<P>`（最近 push 完且 origin/<P> 已 fetch 同步）
- `origin/<P>` ref 不存在 + `git fetch origin <P>` 也失败 → CLI 走 `$ = "HEAD"` fallback 路径正确
- 没有 origin remote 配置（如完全 local-only repo）→ fallback "HEAD" 路径正确

### 边角

- 只有 `origin/master` ref 时 → CLI 选 "master"（即使 `init.defaultBranch=main`）
- `init.defaultBranch=master` 不参与 CLI 默认分支选择（CLI 只看 `refs/remotes/origin/HEAD` symbolic + `["main","master"]` 两个 ref 文件）
- 多 remote（不止 origin）→ CLI 只认 origin
- shallow clone 不改变 start-point 规则
- 自定义 fetch refspec 影响 `git fetch origin <P>` 后 remote-tracking ref 落点
- `refs/remotes/origin/HEAD` 缺失（典型场景） → fallback `["main","master"]` ref 文件路径，但下一步 `kr(W, refs/remotes/origin/main)` 仍读 stale ref，**不会救场**
- bare repo / submodule：未实测，推测同样触发（reviewer-codex U1）

### 已排除其他 git 解释（reviewer-codex L1）

`detached HEAD` / `FETCH_HEAD` / remote refspec 改写 / `packed-refs` / `reflog` 都不能把 explicit `origin/main` 自动改成本地 `HEAD`。**根因 100% 是 CLI 传错 start-point**。

## Application 层 fix 空间分析（reviewer-claude M2 详证）

### hand_off_session_impl.ts (312 LOC)

只构造 cold-start prompt + spawn 新 SDK session。**不调** EnterWorktree(name)。worktree 由新 session 自己按 user CLAUDE.md cold-start 流程调 `EnterWorktree(path: existing)` 进入已建好的 worktree。

```ts
// hand-off-session-impl.ts L292-307
const baseLine = `按 ${planFilePath} 接力`;
// ...
return { mode: 'plan', planFilePath, worktreePath, coldStartPrompt, ... };
```

### archive_plan_impl.ts

只 ff-merge worktree branch 到 base_branch + mv plan 文件 + `git worktree remove` + branch -D。**不调** worktree 创建。

### 结论

二者都**不是** stale base bug 触发面。EnterWorktree 是 CLI / SDK builtin，application 没有 hook 点 wrap 它的行为。**application 层无 trivial fix 路径**。

## Upstream report — anthropics/claude-code GitHub issue recipe

**应该报**（reviewer-claude H + reviewer-codex H2 双方独立结论）：
- contract 与实现严重不符（description 明文 `based on HEAD`，实际 `based on origin/<default-branch>`）
- 复现 trivial 且 deterministic（无需 race / 时序条件）
- 用户预期违反度高（EnterWorktree 是常用工具，工作流被破坏不易察觉直到 ff-merge 失败）

### Reproduction recipe（reviewer-codex 最小化版本，bare repo 形式更稳）

```bash
git init --bare /tmp/ccwt-origin.git
git clone /tmp/ccwt-origin.git /tmp/ccwt-main
cd /tmp/ccwt-main
git switch -c main
printf a > a && git add a && git commit -m base && git push -u origin main
printf b > b && git add b && git commit -m local-ahead
git rev-parse HEAD origin/main  # 预期不一致：local 比 origin 多 1 commit
# 在 Claude Code 2.1.112 中调用 EnterWorktree({name:"repro"})
git -C .claude/worktrees/repro rev-parse HEAD
git reflog show worktree-repro --date=iso
```

**Expected** (per tool description "...with a new branch based on HEAD"): new worktree HEAD == local HEAD
**Actual**: new worktree HEAD == `origin/main`（缺少本地未 push 的 commit）

### Suggested upstream fix (one of)

- 默认 base 改为 `HEAD`（与 tool description 对齐）
- 暴露 `fromHead: boolean` 公开 schema 参数 + 文档化默认值（让用户/agent 显式选）
- 修 tool description 改为 "based on origin/<default-branch>"（与现行实现对齐，但破坏用户预期）—— **不推荐**

### 上游 issue 模板（reviewer-claude H 输出）

```markdown
## Bug: EnterWorktree creates branch based on origin/<default> instead of HEAD (contract mismatch)

### Reproduction (claude-code v2.1.112)

[bare repo 步骤同上]

### Expected (per tool description)
"creates a new git worktree inside `.claude/worktrees/` with a new branch based on HEAD"
→ new worktree HEAD == local HEAD

### Actual
new worktree HEAD == origin/<default-branch>
→ commits behind local HEAD by however much local is ahead of origin

### Root cause (cli.js v2.1.112)
Implementation invokes:
  git worktree add --no-track -B <branch> <path> origin/<default-branch>

Default branch logic uses `refs/remotes/origin/<default>` ref (last-fetch SHA), not local `HEAD`.

### Impact
- Hand-off / plan workflow breaks: new worktree starts from stale base
- Code edits in worktree are based on stale tree, may conflict with main on ff-merge
- Tests run in worktree may pass/fail based on stale state, validation unreliable
- Bug is deterministic (not race), trivial to reproduce on any "commit but not pushed" workflow

### Suggested fix
- Change default base from `origin/<default>` to `HEAD` (matches tool description)
- Or: expose `fromHead: boolean` to public schema + document default
```

## 长远 fix 提案（独立 plan 锚点）

新增 `enter_worktree_safe(plan_id, name?)` mcp tool（agent-deck-mcp 体系）：

- handler 读 plan frontmatter（plan_id 路径解析复用 hand_off_session-impl 同款 fallback chain）
- 在 application 层调 Bash `git worktree add -b worktree-<plan-id> <main-repo>/.claude/worktrees/<plan-id>`（隐式用 HEAD 作 base）
- 返回 `{ worktreePath, branchName, baseCommit }` 给 SDK session
- SDK session 接收返回值后用 `EnterWorktree(path: worktreePath)` 进入已建好的 worktree
- user CLAUDE.md §Step 1 推荐用此 mcp tool 而非 CLI builtin EnterWorktree(name)
- 工作量评估：schema 新增 1 entry + handler ~80 LOC + canUseTool / IPC 透传 + ~10 测试 case + user CLAUDE.md §Step 1 文档更新
- 平行考虑：CLI 内部还有 `createAgentWorktree` 函数走类似 default branch 逻辑（reviewer-claude 提到 cli.js byte ~11801937 区段），Agent isolation 路径同源问题需要在独立 plan 内一并评估

**本 plan 不实施** —— 留独立 plan「`enter_worktree_safe` mcp tool」（plan_id TBD）。**触发时机**：(a) 本 review 落地后用户主动启动；(b) 上游 CLI fix 接受 + 发布前过渡期；(c) 实测发现 (b) workaround 有遗漏场景。

## 收口

- ✅ Root cause 100% deterministic 实证定位（A/B 实测铁证 + 三方独立验证）
- ✅ R1 异构对抗 review 双方一致结论（无反驳证伪 / 无 evidence 冲突）
- ✅ Workaround (b) 主路径已被本 plan worktree 自身验证铁证
- ✅ user CLAUDE.md §Step 1 typed warning + workaround 文档化（本 review commit 同步落地）
- ✅ Upstream GitHub issue recipe 详记
- ✅ 长远 fix 提案锚点（独立 plan 留追溯）
- ❌ 不修代码（application 层无 fix 路径，root cause 在上游 CLI binary）
- ❌ R2 跳过（仅 doc-only 无 fix commit 不需复审）

**结论**：本 plan **document-only** 收口。后续动作（独立 plan 提案）见上节。
