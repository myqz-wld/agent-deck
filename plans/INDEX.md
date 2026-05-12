# Plans 索引

> **范围**：跨多会话的复杂工程 plan（按全局 `~/.claude/CLAUDE.md`「复杂 plan：worktree 隔离 + 跨会话 hand off」节流程产出）。本目录是 plan 的 **git 归档目的地**（与 `changelog/` `reviews/` 平级）—— in_progress 工作中可放此或 `.claude/plans/`（local 临时草稿）；completed 必须归档到此入 git。

## 命名

`<topic>-<YYYYMMDD>.md`（与全局约定的 `plan_id` 严格一致；字符集限 `[A-Za-z0-9._-]`、单 segment ≤ 64 字符）。新建前 `ls plans/` 看是否已有同 topic plan 在跑。

## 单文件结构

详见 `~/.claude/CLAUDE.md` 「复杂 plan：worktree 隔离 + 跨会话 hand off → §Step 2 Plan 文件 hand off」节。frontmatter 必含：`plan_id` / `created_at` / `worktree_path` / `status: in_progress|completed|abandoned` / `base_commit`。

## 索引

| 文件 | 状态 | 关联 changelog | 概要（≤80 字） |
|------|------|---------------|---------------|
| [deep-review-flow-fix-20260512.md](deep-review-flow-fix-20260512.md) | completed | [75](../changelog/CHANGELOG_75.md) / [76](../changelog/CHANGELOG_76.md) / [77](../changelog/CHANGELOG_77.md) | deep-code-review 流程顺畅化（Phase A reviewer-codex `$TMPDIR` + SKILL Step 0.6/1/2.5 + 双 Bash 兜底；T1 `Cmd+Alt+T` 透明快捷键；B-D1+D3 spawn_session `agent_name` + lead teamName 反查；C SessionList 树形折叠 + lead/teammate badge）|
| [team-cohesion-fix-20260513.md](team-cohesion-fix-20260513.md) | completed | [78](../changelog/CHANGELOG_78.md) | 团队凝聚力修复 6 Phase 全：A v014 drop sessions.team_name 走 universal team backend；B send/reply/wait_reply 三 tool（messages.reply_to_message_id 对话链）；B5+B7 spawn placeholder + wire format `[msg <id>]` 让 teammate 能 reply_message；C TeamDetail 重写 6 sections「团队工作面板」；D PendingTab teammate chip + role badge；F D6 close 自动 leaveTeam + D7 TeamLifecycleScheduler 5min/30min grace + IPC ShutdownAllTeammates + Header 按钮 |
