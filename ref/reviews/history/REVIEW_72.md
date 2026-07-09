# REVIEW_72 — 全项目 deep review 批 A2：MCP worktree handlers (enter/exit)

- 日期: 2026-05-31
- 类型: Debug / 功能 BUG + 代码优化 + 文字措辞（全项目 deep review 第二批）
- 触发: 用户「deep review 下项目，自主一路推进 + 自主 hand off」授权（plan deep-review-project-20260531）
- 关联: plan deep-review-project-20260531 / REVIEW_71（批 A1）/ base commit 7f96617 / commit 826af22（批 A1）
- 方法: 多轮异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5，复用 A1 的 reviewer pair）+ 三态裁决。lead pre-read 全 4 文件 + 多处 /tmp 临时 repo 实测取证。
- 收口: R1 双 reviewer reply（MED-A 双方独立 + 各自单方 MED/LOW）。reviewer-codex 一度卡住，lead nudge 后恢复（非死，仅慢）。3 条 ✅ fix + 4 回归 test。typecheck 双配置 + agent-deck-mcp 564 passed / 3 skipped。

## 范围（批 A2）

MCP enter_worktree / exit_worktree（git worktree 创建/删除自动化），4 文件 ~870 LOC：
- src/main/agent-deck-mcp/tools/handlers/enter-worktree-impl.ts
- src/main/agent-deck-mcp/tools/handlers/enter-worktree.ts（薄 wrapper）
- src/main/agent-deck-mcp/tools/handlers/exit-worktree-impl.ts
- src/main/agent-deck-mcp/tools/handlers/exit-worktree.ts（薄 wrapper）

## 三态裁决（3 ✅ 必修）

### ✅ MED-A enter 用 `--show-toplevel` 解析 mainRepo，与 3 兄弟 impl 的 `--git-common-dir` 不一致
**双方独立提出**（reviewer-claude 本 worktree 内实测 + reviewer-codex /tmp 临时 repo 实测）→ 异构强冗余直接 ✅，无需反驳轮。

- **文件**: `enter-worktree-impl.ts:232`（修前 `git rev-parse --show-toplevel`）
- **问题**: 变量名 + 注释都声称解析「main_repo」，但 `--show-toplevel` 返回**当前工作树根**。caller cwd 在主仓库时两者相等，**但 caller cwd 在某 linked worktree 内时分叉**：show-toplevel 给该 worktree，git-common-dir+dirname 给真 main repo。`exit-worktree-impl:205` / `hand-off-session-impl:167` / archive-plan-impl 全用 `--git-common-dir`，enter 是唯一异类。
- **后果**: caller 已在 worktree1（builtin EnterWorktree 切了 cwd / 之前 mcp enter_worktree 设了 marker）再调 enter_worktree 起 plan2 → mainRepo 误算成 worktree1 → 新 worktree 建到 `worktree1/.claude/worktrees/plan2`（嵌套错位）+ marker 指向嵌套路径。后续 archive_plan 用 git-common-dir 拿真 main repo，与 plan frontmatter 嵌套 worktree_path 对不上 → 收口链错乱。git worktree add 允许嵌套（实测 rc=0）→ 不立即报错，silent 错位更危险。
- **验证**（lead 本 worktree 内实跑铁证）：`git rev-parse --show-toplevel` → worktree 自身；`git rev-parse --git-common-dir` dirname → 真 main repo（`/Users/apple/Repository/personal/agent-deck`）。grep 确认 enter 是 4 个 impl 中唯一用 show-toplevel 的。
- **修复**: enter-worktree-impl.ts:232 改 `--git-common-dir` + dirname（与 3 兄弟统一），同步修 jsdoc:14 + hint:225。回归 test：caller cwd 在 worktree 内 → worktreePath 派生自真 main repo 非嵌套。

### ✅ MED-B exit 在「未合并 commit + discardChanges=false」时先删 worktree 才发现 branch 不能删
reviewer-codex 单方 + lead 实测验证（含 schema 契约核对 + /tmp repo 复现）→ ✅。

- **文件**: `exit-worktree-impl.ts`（修前 5b branch 解析 → 5c worktree remove → 5d branch -d 才发现未合并）
- **契约**: schema.ts:594 承诺 discardChanges=false 时「if worktree has ... commits not on base branch, tool refuses ... protects against accidentally losing work」。但修前 5a 只预检 uncommitted changes（working tree dirty），已 commit 但未合并的 commit 不在拦截范围。
- **后果**: clean working tree + 未合并 commit → 5c `git worktree remove` rc=0 删目录成功 → 5d `git branch -d` rc=1 报 not fully merged → worktree 目录已删但 return partial-success error。违反「refuse 保护工作」契约（worktree 没被 refuse 而是被删）。**lead 实测澄清**：commit 实际**存活在 branch 上**（可 `git branch -D` 恢复），非数据丢失 → 准确严重度 MED（契约/UX 不一致）非 HIGH（数据丢失）。
- **git 顺序硬约束**（lead 实测）：不能在 worktree remove 之前先 `branch -d`（git 拒删 checked-out branch），删除顺序无法调换 → 必须在 remove **之前**独立预检。
- **修复**: 5c-pre 新增未合并预检 — `!discardChanges && branchName && !PROTECTED` 时 `git merge-base --is-ancestor <branch> HEAD`（main repo 内跑，精确镜像 `git branch -d` reachability 判定）。rc≠0（未合并）→ refuse 保留 worktree + marker 不清。discardChanges=true 跳过预检（caller 已显式接受丢 commit）。回归 test：未合并 + !discardChanges → remove 前 refuse（无 worktree git 调用 + marker 不清）；未合并 + discardChanges=true → 跳过预检 --force 删。

### ✅ LOW frontmatter base_commit 未经 rev-parse 验证就传 git worktree add（文字措辞 + 健壮性）
**双方提出**（reviewer-codex LOW + reviewer-claude INFO）→ ✅。

- **文件**: `enter-worktree-impl.ts:181`（修前仅校验 `length >= 7`）
- **问题**: args.baseBranch 走 rev-parse 验证、args.baseCommit 走 zod hex regex，但 frontmatter base_commit 仅校验长度就原样传 `git worktree add <commit>`。非法值（如非 hex 7 字符串）延迟到 step 7 才报错，归入通用 hint 定位不清。
- **结论与修复**: reviewer-claude 正确指出「git 会兜底拦 + 错误已透传，非静默落空」→ 非 data bug，但更早更精准的错误对 UX 有益。改用 `git rev-parse --verify --quiet <commit>^{commit}` 预验证；失败时**不算 error**（与 frontmatter base_branch 同款 best-effort 软约束）fallback 走 HEAD —— frontmatter 是 plan 软提示不该因 stale base_commit 阻断 worktree 创建。回归 test：base_commit verify 失败 → fallback HEAD 不 error。

## ❌/INFO 已综合（不修）

- **INFO（reviewer-claude）enter step 5 预检 TOCTOU**：worktreePath/branch exists 预检与 git worktree add 之间 check-then-act 窗口，但 git worktree add 自身对已存在 path/branch 原子 reject + hint 已明文承认 race → 非真实风险，git 是真正 guard。不修。
- **INFO（reviewer-claude）exit step 3 realpath fallback 尾斜杠**：worktree 已删 + caller 传带尾斜杠路径时 realpath 双抛 fallback 字面比较可能误报 cross-worktree。仅 worktree 已删的 idempotent 清理场景触发，极边角。列 follow-up（见下）。
- **LOW（reviewer-claude）enter marker 写失败不回滚已建 worktree**：step 8 marker DB 写失败 return error 但不删已建 worktree/branch，下次同 planId 重试撞预检。hint 已给手工恢复路径。注释「git 操作不可逆」对 worktree add 不准确（可逆）。列 follow-up。

## 验证

- typecheck: tsconfig.node.json + tsconfig.web.json 均 exit 0
- test: 全量 agent-deck-mcp 35 文件 564 passed / 3 skipped（含 4 新增回归 test + 5 既有 test 更新 mock 匹配新行为）
- 实测取证：show-toplevel vs git-common-dir 分叉（本 worktree）；未合并 commit 时 worktree remove rc=0 + branch -d rc=1 + branch 存活（/tmp repo）；merge-base --is-ancestor 合并前后 rc 翻转（/tmp repo）

## Follow-up（留用户决策 / 低优先）

1. **[LOW] enter marker 写失败 best-effort 回滚**（enter-worktree-impl.ts step 8）— marker 写失败时 `git worktree remove --force` + `branch -D` 回滚再 return error，让重试干净；或至少修正 jsdoc:25「git 操作不可逆」表述（worktree add 可逆）。
2. **[LOW] exit realpath fallback 尾斜杠归一化**（exit-worktree-impl.ts:149-167）— fallback 字面比较前 `path.normalize` 去尾斜杠；并对齐 schema ENTER_WORKTREE worktreePath describe 文档默认路径尾斜杠表述与 impl（无尾斜杠）。
