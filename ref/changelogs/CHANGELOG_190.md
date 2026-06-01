# CHANGELOG_190 — 全项目 deep review plan 收口（A-H 25 子批 / REVIEW_71-95）

- 日期: 2026-06-01
- 类型: 功能 BUG 修复 + 代码优化 + a11y + 文案（跨多会话 deep review × fix 大型 plan 收口）
- 关联: plan `deep-review-project-20260531`（归档 → `ref/plans/`）/ REVIEW_71-95 / 本批前置基线 REVIEW_70 + CHANGELOG_189

## 概要

用户授权「deep review 整个项目，聚焦功能 BUG / 代码优化 / 文字措辞，自主一路推进 + 自主 hand off」的大型 plan 收口。跨多会话、worktree 隔离（`deep-review-project-20260531`）、多轮异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5）+ 三态裁决，覆盖 main 进程核心子系统 + renderer。Batch I（剩余 ipc/window/utils + issue-tracker 主体）经数据勘察确认「已审未过期 / 成熟安全代码 / 真正未审面极薄」→ 用户确认 descope。

## 批次成果（A-H，25 子批 / REVIEW_71-95）

| Batch | 子系统 | REVIEW | 概要 |
|---|---|---|---|
| A | MCP hand-off + worktree handlers | 71-72 | adoptTeammates guard / enter git-common-dir / exit 未合并先删 |
| B | MCP archive-plan 事务 | 73-74 | post-ff-merge late phase 跳 baton cleanup / isPostCommitArchiveError regex 漏大写 / INDEX 单飞锁 |
| C | claude-code sdk-bridge（recovery/并发/lifecycle）| 75-78 | 孤儿 tempKey row / closed→active 幽灵复活 / ExitPlanMode 热切 cache desync |
| D | codex-cli sdk-bridge 全量 28 文件 | 79-82 | threadId 初值 / forward setCodexSandbox try 外 throw / oneshot timeout 不取消子进程 / 1 误报证伪 |
| E | session + lifecycle + summarizer | 83-84 | HIGH ensure() 复活架空 advanceState / rename 漏迁 tasks/issues / 同毫秒 event 逆序 |
| F | MCP spawn/send/task + dispatch | 85-87 | spawn 失败清理 / claim 后异常永卡 / backpressure 饿死 / task 权限域切换越权 |
| G | store repos（session/team/message/杂项/settings）| 88-92 | 同毫秒 tie-breaker 四连 / Follow-up #9 闭环 / value-migration re-fire 永久压制 |
| H | renderer core + issue 组件 + SessionDetail | 93-95 | error state 二义性摧毁表单 / 初始 fetch 无 catch 全屏 fatal / pending 快照死锁 / cancelToasts timer / ComposerSdk 双源 |

**Batch H（本会话主体，renderer 层）**：
- **H1**（REVIEW_93）：issue 组件，1 HIGH + 4 MED + 4 LOW + 2 INFO。HIGH error state 二义性（save/delete 失败摧毁整表单 + 死代码，反驳轮 codex 同意）；MED 3 处初始 IPC fetch 缺 catch → 全屏 fatal / stale fetch 退回 event / mergeIssuesFromList keep-all。Follow-up #15（same-ms updatedAt repo 单调 revision）。
- **H2**（REVIEW_94）：App + session-store，1 MED + 5 LOW + 1 INFO。MED setPendingRequestsAll 快照整替抹 live pending → SDK 死锁；renameSession M4 丢 fromId 子表缓存 → merge。
- **H3**（REVIEW_95）：SessionDetail，3 MED + 5 LOW + 2 INFO。cancelToasts timer 绑错 dep + 跨会话残留 / ComposerSdk closed 会话双源 fallback 显示更宽松 / listFileChanges 无 catch。

## 累计

- **A-H ≈ 80+ bug/优化 fix**（HIGH/MED/LOW），其中 Batch H 单独 1 HIGH + 8 MED + 14 LOW + 5 INFO = 28 fix
- 回归 test 大量新增（每 fix temp-revert 非空验证）；renderer 层新增 4 个纯逻辑 test 文件（issue-detail-editing +7 / issues-store +6 / session-store +8 / SessionDetail helpers +12）
- 全项目 vitest **1269 passed / 210 skipped**（skipped = SQLite 真测需 Electron binding）；typecheck 双配置（node + web）全绿
- 共性主题沉淀：**同毫秒 tie-breaker**（SQL ×4 + renderer ×1）/ **异步边界 IPC reject 无 catch**（renderer ×3 子批）/ **全量替换/迁移合并语义不彻底** / **失败/异常/权限切换路径处理不彻底** / a11y label 关联 + 安全文案

## Follow-up（留用户决策，见归档 plan §Follow-up 汇总）

15 条，其中本会话新增 **#15**：issue same-ms updatedAt tie 的 store-sync / list-merge 两条兄弟路径未闭合（根因 `Date.now()` ms 非单调，根治需 repo 层单调 revision = issue-repo REVIEW_70 scope + shared schema，renderer band-aid 不成比例）；reviewer-codex H1 R3 提出，双方共识转 Follow-up。

## 未变更

Batch I descope（window/ 已 REVIEW_45/61 深审无 churn；ipc/images.ts CHANGELOG_47 TOCTOU 成熟；issue-tracker 主体 REVIEW_70 当天刚审）。涉及核心流程/架构需画 plantUML 的（如 CHANGELOG_189 Follow-up 3 张 issue puml）留用户回来走 flow-arch SKILL，本 plan 未自主画。
