# CHANGELOG_187 — Phase E F5 follow-up：提示词资产残留 codebase 内部名清理 + 2 处 pre-existing 文档 bug

> Phase E（CHANGELOG_183 Q2）决策对抗双 reviewer 独立判 HIGH 的 follow-up：`resources/claude-config/CLAUDE.md` + `resources/codex-config/CODEX_AGENTS.md`（注入**所有** Agent Deck 项目 SDK 会话的通用约定）仍残留纯实现符号（class.method / 内部 var / DB 列名 / 内部编号 / IPC handler 名）。Phase E 只清了 file:line 源码路径，这批是 pre-existing 残留，注入别项目会误导（这些符号在别项目不存在）。本轮按「运行环境概念保留 vs 纯实现符号删/泛化」判则做 careful pass + 顺带修 2 处 pre-existing 文档 bug。纯 .md，无 TS delta。

## 判则（reviewer 给的运行概念 vs 实现符号边界）

- **保留**（运行环境概念，读者跨项目都成立）：session lifecycle 状态 / archived 概念 / teams / GC-retention 概念 / mcp tool 名 + tool 的 input/return 字段名 / wire format / worktree / plan workflow / codex SDK option 名（`sandboxMode` / `approvalPolicy` / `networkAccessEnabled` / `additionalDirectories`）/ 真实 codex-facing config（`AGENT_DECK_MCP_TOKEN` env var / `bearer_token_env_var`）/ 作为契约的真实列名（如 `updated_at` 排序契约）
- **删/泛化**（纯实现符号，别项目不存在 → 注入即误导）：内部 class.method、内部 var/module、纯内部 DB 列名/表名、内部编号、内部 IPC handler 名

## F5 清理（两端一致泛化，20+ 处）

- **class.method**：`sessionRepo.delete` → 物理删除 / `sessionManager.close` → session close / `runBatonCleanup` → baton-cleanup phase 1（保概念）/ `agentDeckTeamRepo` → DB / `reassignOwner` `reassignTaskOwner` → 过继 ownership / `applyHandOffSkipPolicy` → skip-policy
- **内部 var/module**：`mcpSessionTokenMap` `HookServer` `extra.authInfo.resolvedSid` `envOverride` → per-session token / MCP server 反查措辞 / `options-builder` → 应用层默认 enforce / `LifecycleScheduler.historyRetentionDays` → 历史保留期 GC（保概念）
- **DB 列名/表名**：`sessions.spawned_by` `spawn_depth` → spawn-link 关系（parent 指针 / depth 字段）/ `cwd_release_marker` → cwd 释放标记 / `archived_at`（作字段名时）→ 归档标记 / `team_member` `left_at` → 成员关系软退出 / `spawn_link`（表名）→ spawn-link 关系
- **内部编号**：`N5 ≥1 lead 硬约束` → ≥1 lead 硬约束 / `N2.c 互斥` → 与 teamName 互斥 / `D1 ADR` → per-session token 机制
- **内部 IPC handler 名**：`TeamShutdownAllTeammates` → 应用 UI Team 面板入口 / `TaskListByTeam` → `task_list({ teamIdFilter })`

## Doc bug #1：claude-config §决策对抗 permission-mode

- `CLAUDE.md` §外部 CLI 通用姿势「claude 用 `--permission-mode plan`」与 `reviewer-claude.sh.tmpl` 实际「`--permission-mode default` + `--disallowedTools 'Edit,MultiEdit,Write,NotebookEdit,ExitPlanMode'`」矛盾 → 改 default + 补 ExitPlanMode disallow + plan-mode 吞 finding 陷阱说明（REVIEW_52/54 双踩坑 / 约定 `ref/conventions/01-*`）
- codex-config 同节本来就是 default（未被破坏，无需改）

## Doc bug #2：CODEX_AGENTS.md 手工归档 cross-ref 自包含化

- 原 3 处 cross-ref 指向 `claude-config CLAUDE.md §Step 4 §中止 手工归档`——codex SDK 不加载 claude-config 读不到（abandoned plan 手工归档是 codex 唯一路径，archive_plan tool 强制 status=completed 不接 abandoned）
- 决策 **inline**（不只改措辞）：新增 §手工归档 fallback 节（completed 收尾 5 步 + abandoned 中止 3 步，codex 工具 `shell` / `apply_patch` / MCP `exit_worktree`）+ 3 处 cross-ref 改指内部 inline 节 + 平行 SSOT note。**先例**：§plan cold-start protocol（codex 端 5 步）已是同款 inline + 平行 note 模式
- 顺带修原 §中止 标签错位（escape-hatch 典型场景实际描述 §完成 场景）

## 决策对抗（Workflow 多维 + 三态裁决）

- 5 维并发 review（over-strip / under-strip / cross-file 一致 / doc-bug 正确性 / §提示词资产维护 5 硬约束），每条 finding 独立 skeptic 反驳。34 finding → 16 survived / 18 refuted
- ✅ **采纳 3 处**：(1) `spawned_by` 泛化时误写成 malformed `spawn-by`（code-y 又错，最坏组合）→ 改 parent 指针 / depth 字段；(2) codex 手工归档第 5 步 `shutdown_baton_teammates` 应条件化（无 teammate 时跳过，claude 端因 archive_plan 自动做而无此步）；(3) `closed` lifecycle / 归档标记 双 lifecycle 措辞顺滑
- ❌ **驳回**：cross-file 非对称（codex Why 多 2 行 / task_list 返回值说明——两端 §优先级声明 明示「不强行对齐两端」，pre-existing）/ 实现符号泛化（任务本意）/ inline→pointer 建议（会重新引入 doc bug #2，codex 读不到 claude-config）

## 验证

- 全文 grep impl-symbol sweep（20+ 符号）两端 0 命中
- §提示词资产维护 约束 2（兼容/FUTURE/TODO）两端 0 命中；约束 3（模糊副词）新 inline 节 0 命中
- 无读不到的 load-bearing cross-ref（仅余 4 处平行 SSOT pointer note，合规）
