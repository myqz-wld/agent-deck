# CHANGELOG_111

> Plan `worktree-stale-base-bug-20260515`: Claude Code CLI v2.1.112 EnterWorktree builtin **stale base bug** R1 异构对抗 × **document-only** 收口（详 [REVIEW_38.md](../reviews/REVIEW_38.md)）

## 概要

R37 archive_plan 收口后立即 hand-off 准备阶段实测撞 bug：调 `EnterWorktree(name: "X")` 创新 worktree HEAD = `origin/<default-branch>`（last-fetch SHA）而非本地 HEAD。本地 ahead origin/<default> N commits 时新 worktree 直接落后 N commits（R37 实测 worktree HEAD = `f253794` 落后本地 main `91c4568` 二十个 commit）。Lead 独立 grep + minified bundle 反编译 100% 实证定位 root cause（**Claude Code CLI v2.1.112 builtin EnterWorktree 工具默认 base 用 `origin/<default-branch>` 而非本地 HEAD，且 cli.js tool description 明文承诺 `based on HEAD` 与实现严重不符 = contract vs implementation 矛盾 bug**）后 spawn R1 异构对抗 review confirm + 评 workaround / fix 路径。**Lead 三态裁决 document-only 收口** + user CLAUDE.md §Step 1 加 typed warning + workaround 主路径 + 长远 fix 提案锚点（独立 plan）。

## 变更内容

### 文档

- 新建 [`reviews/REVIEW_38.md`](../reviews/REVIEW_38.md)（详记 root cause 全 trace、A/B 实测铁证、helper 实现独立验证、CLI tool description vs implementation 矛盾、R1 三态裁决（双方独立 ✅ 6 HIGH + 3 ✅ MED/LOW + 1 ❌ + 1 ❓ INFO）、workaround 4+1 候选评估 + ranking、触发条件矩阵（必中 / 不撞 / 边角）、应用层 fix 空间分析、upstream GitHub issue recipe、长远 fix 提案）
- 同步更新 [`reviews/INDEX.md`](../reviews/INDEX.md) 加 REVIEW_38 行
- 同步更新 [`~/.claude/CLAUDE.md`](~/.claude/CLAUDE.md) §「复杂 plan：worktree 隔离 + 跨会话 hand off」§Step 1 加 typed warning + workaround 主路径 + 兜底自检命令（详该文件 git diff）

### 代码

**无代码改动**（root cause 在上游 Claude Code CLI v2.1.112 binary，application 层无 fix 路径 — hand_off_session / archive_plan 都不在 EnterWorktree 调用链；application 没 hook 点 wrap CLI builtin）。

## R1 异构对抗 review

| 轮次 | 模式 | 双方独立结论 |
|---|---|---|
| **R1** | 1 reviewer-claude (Opus 4.7, focus 代码 + minified bundle) + 1 reviewer-codex (gpt-5.5 xhigh, focus git plumbing + man page + reflog) teammate | 双方一致 ✅ HIGH 6 个核心 finding（root cause / reflog 加强证据 / deterministic / contract vs impl 不符 / upstream 应按 bug 报 / workaround (b) 主路径），1 ❌ 排除（fromHead 隐藏参数不可靠），1 ❓ 未验证（bare/submodule） |
| **R2** | 跳过 | 仅 doc-only 无 fix commit 不需复审 |

**fix vs document 分歧 lead 裁决 document-only**（plan §设计决策 5 阈值「root cause 清晰 + fix 复杂(架构性新功能数百 LOC) → 文档化 + workaround，fix 留独立 plan」；reviewer-codex 提的 fix 是新 mcp tool 与 reviewer-claude 的 (e) 一致；分歧仅在「本 plan 做 vs 独立 plan」，非 evidence 冲突，未走反驳轮）。

## Workaround 落地

| 路径 | 主推度 | 落地 |
|---|---|---|
| (b) Bash `git worktree add -b worktree-<id> <path>`（隐式用 HEAD） | ★★★ 强推主路径 | user CLAUDE.md §Step 1 typed warning 同步落地；本 plan worktree 自身已采用并验证铁证 |
| (a) user CLAUDE.md 加自检 + reset-hard 修法 | ★★ 兜底 | user CLAUDE.md §Step 1 typed warning 同步落地（与 (b) 互补） |
| (c) push 后再 EnterWorktree | ★ | 不推荐（违背「commit 不立即 push」工作流） |
| (d) Application 层包装 EnterWorktree builtin | ✗ | 不可行（application 无 hook 点） |
| (e) 新增 mcp tool `enter_worktree_safe(plan_id)` | 长远最佳 | **独立 plan 提案锚点**（本 plan scope 外） |

## Upstream

- **应按 bug 报 anthropics/claude-code GitHub issue**（contract vs implementation 严重不符 + deterministic 复现 + 用户预期违反度高）
- Reproduction recipe + suggested fix（默认改 HEAD / 暴露 `fromHead` 公开 schema）+ issue 模板见 [REVIEW_38.md §Upstream report](../reviews/REVIEW_38.md#upstream-report--anthropicsclaude-code-github-issue-recipe)
- **本 plan 不主动报 issue**（留用户决定时机）

## 已知踩坑

- **EnterWorktree(name: ...) 默认行为陷阱**：本地 HEAD ahead origin/<default> 时新 worktree 直接落后 N commits，工作流被破坏不易察觉（直到 ff-merge 失败 / 改动与 main 冲突 / 测试基于 stale base 验证不可信）
- **CLI tool description 不可信**（v2.1.112 实测）：description 说 `based on HEAD`，实际 `based on origin/<default-branch>` —— 任何依赖 description 字面量的工具调用预期都需自检
- **Bash workaround 边角**：(b) 路径需要 worktree branch / path 不存在 + 非 unborn HEAD（典型 git 状态都满足）；submodule 修复需单独 `--recurse-submodules`
- **复现条件 trivial 且 99% working repo 必中**：任何「commit 但未 push」+「有 origin remote 配置 + `refs/remotes/origin/<default>` ref 存在」即触发；R37 archive 后立即 hand-off 是典型但远不止此场景

## Verification

- typecheck / vitest **不需跑**（本 plan 无代码改动）
- Workaround (b) 实测铁证：本 plan worktree 自身用 `git worktree add -b worktree-<plan-id> <path>` 创建，HEAD = main HEAD ✓（详 plan §设计决策 1 + REVIEW_38 §Workaround 表）
- 三方独立 byte offset 一致指向同一段 minified 代码（lead 11794069 / reviewer-claude 11794070 / reviewer-codex 11854355；不同抽取工具的 char vs byte position 偏差，皆指向 `git worktree add --no-track -B <branch> <path> origin/<default-branch>` 同段）

## 详记

- 完整 root cause trace + R1 三态裁决 + workaround 评估 + upstream recipe + 长远 fix 提案 → [REVIEW_38.md](../reviews/REVIEW_38.md)
- Plan 全文 + 调研日记 → [`plans/worktree-stale-base-bug-20260515.md`](../plans/worktree-stale-base-bug-20260515.md)（archive_plan 后归档至 `<main-repo>/plans/`）
