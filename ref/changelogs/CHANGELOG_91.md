# CHANGELOG_91: archive_plan tool 用法文档同步（user CLAUDE.md + resources/claude-config）

**plan**: mcp-bug-and-feature-batch-20260513 Phase 4a Step 4a.6-4a.9（K1 文档同步收口）

## 概要

CHANGELOG_90 引入了 `archive_plan` mcp tool（plan §Phase 4a Step 4a.1-4a.4 实现 + commit `81a15d8`），本 changelog 完成 K1 文档同步：

- **`~/.claude/CLAUDE.md` §Step 4 cleanup 节**：把原「手动 5 步 Bash」改成「推荐 mcp tool 自动化 + fallback 手动 Bash」双姿势，agent 第一选择走 `mcp__agent_deck__archive_plan` tool。**注**：本文件改动在用户全局 home，不在 worktree branch 内，本 commit 不带；改动是 in-place 的（agent 即时受益，但跨设备同步需用户手动）
- **`resources/claude-config/CLAUDE.md`**（应用打包注入到每个 SDK 会话 system prompt）：
  - §Agent Deck Universal Team Backend 节首句「7 tool」改「9 tool」并补全 check_reply / archive_plan
  - 新增 §check_reply 非阻塞 poll 节（CHANGELOG_87 应做但漏改，本次顺手收）
  - 新增 §plan hand-off 自动化：archive_plan 节，含完整 ts 调用模板 + 14 步流程概述 + 预检失败 / cwd 在 worktree 内 reject 行为说明

1 atomic commit，typecheck 双端通过 + 全 vitest 24 文件 358 it 通过（无代码改动）。

## 变更内容

### A. `~/.claude/CLAUDE.md` §Step 4 cleanup（用户全局，不入 commit）

原内容：单条「**完成**」行列出手动 5 步 Bash（worktree branch 合回 + frontmatter 改 + mv plan + INDEX 同步 + git add commit + ExitWorktree + git worktree remove + branch -D）。

新结构：拆分 3 sub-section：
- **完成（推荐：mcp tool 自动化）**：`mcp__agent_deck__archive_plan` 调用，4 步指南（ExitWorktree → 调 tool → 引用归档 changelog → tool 自动预检）
- **完成（fallback：手动 5 步 Bash）**：原 5 步内容保留，标注 fallback 适用条件（mcp 不可用 / agent-deck 未运行）
- **中止**：原内容 + callout 说明 abandoned plan 不走 archive_plan tool（tool 强制 status=completed，不适配 abandoned 语义）

### B. `resources/claude-config/CLAUDE.md`（应用打包注入，入 commit）

#### B1. §Agent Deck Universal Team Backend 首句

「7 tool」→「9 tool」，明确列出新加的 `check_reply` + `archive_plan`。补全 list 让 agent 一眼看到完整 tool surface。

#### B2. §check_reply 非阻塞 poll（新节）

- CHANGELOG_87 应做但漏改的补漏：phase 1 引入了 check_reply tool，应用 SDK 注入文档没同步导致 lead agent 不知道有此 tool 可用
- 内容：与 wait_reply 对比，立即返回 `{ reply, timedOut: false }` 不阻塞，lead 自己 poll 节奏

#### B3. §plan hand-off 自动化：archive_plan（新节）

- 完整 ts 调用模板（含 4 字段 args + 6 字段返回结构）
- 14 步流程概述（rev-parse / 预检 / ff merge / frontmatter 更新 / mv plan / INDEX 同步 / 删原 plan / git commit / worktree remove + branch -D）
- 预检失败 reject 短路 + cwd 在 worktree 内 reject + 提示 ExitWorktree
- 与 user CLAUDE.md §Step 4 cleanup 节呼应

## 不变量

- archive_plan tool 行为不变（CHANGELOG_90 实现版本一致，文档只描述用法）
- ~/.claude/CLAUDE.md 改动 in-place，不入 worktree branch（用户全局文件，跨项目共享但不与项目 git 关联）
- resources/claude-config/CLAUDE.md 改动入 commit，应用 build 后注入新会话 system prompt 即时生效

## 验证

- `pnpm typecheck` 双端通过（无代码改动）
- `pnpm exec vitest run` — 24 文件 358 it 全过（无代码改动）
- 手动 review：`~/.claude/CLAUDE.md §Step 4` 与 `resources/claude-config/CLAUDE.md §plan hand-off 自动化` 双向一致
- dev smoke（Phase 6 收口时 self-validate）：用 archive_plan tool 自动归档本 plan 到 `plans/mcp-bug-and-feature-batch-20260513.md`，让本 plan 成为 K1 的第一个 real-world test case

## H2 backlog 推进状态

完成本 phase 后剩：
- ✅ J bug + B check_reply（CHANGELOG_87 / Phase 1）
- ✅ C MED-D7 / E LOW / G MED-A7 / H HIGH-B2（CHANGELOG_88 / Phase 2）
- ✅ I `#sdkOwned` 真私有（CHANGELOG_89 / Phase 3）
- ✅ N bug：归档会话续聊自动 unarchive（CHANGELOG_90 / Phase 1.5 新增）
- ✅ K1 archive_plan mcp tool 实现（commit `81a15d8` / Phase 4a Step 1-5）
- ✅ K1 文档同步（本 CHANGELOG_91 / Phase 4a Step 6-9）
- ⏳ K2 start_next_session mcp tool — Phase 4b
- ⏳ K3 UI hand off 按钮 + LLM 总结 — Phase 4c
- ⏳ A HIGH 10 cross-session UI + L 卡片增强 + M 透明置顶解耦 — Phase 5
- ⏳ Phase 6 收口（typecheck + build + dev smoke + worktree merge + plan 归档；plan 归档可走 K1 自验）
