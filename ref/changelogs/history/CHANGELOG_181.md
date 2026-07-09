# CHANGELOG_181 — Phase C: MCP tool description 优化（防 LLM 传错参 / 意图偏差）

- 日期: 2026-05-30
- 关联 plan: [deep-review-and-asset-polish-20260530](../../plans/history/deep-review-and-asset-polish-20260530.md)（Phase C）
- 方法: 决策对抗（外部 claude + codex CLI 各独立审 `schemas.ts` / `index.ts` 全部 tool/field description）+ lead 三态裁决 + 提示词 5 约束优化

## 背景

agent-deck-mcp 17 tool 的 description 注入调用方 agent 的 SDK system prompt，agent 据此决定调不调 / 怎么传参。description drift / 缺失 / 信息密度差会让 LLM 传错参或误判意图。本期纯 description 优化（**不改 schema 逻辑**）。

## 变更内容（按 finding 类型）

### drift（描述与 schema/实现不符，会致传错参）
- **spawn_session** tool desc「callerSessionId is required」→「SDK-internal 不传（transport 自动注入），仅 external 必传」（schema 实为 optional + auto-inject）
- **5 处 callerSessionId** field describe 引用已删工具 `reply`/`wait` → 改现存 write tool（spawn_session / send_message / archive_plan / hand_off_session）
- **task status/statusFilter**（task_create/update/list）enum 未列全 → 列全 `pending|active|completed|blocked|abandoned` + 强调用 `active`（不是 `in_progress`）、`completed`（不是 `done`）—— 防 Claude agent 习惯性传 builtin 值
- **task_create teamId** tool desc「omitted/null = personal」→「omit（create 拒显式 null）」
- **hand_off teamName** field describe 过时（「caller remain as lead」）→ caller 默认被 archive 不再是 lead + 与 `adoptTeammates` 互斥
- **hand_off planId/prompt** required 矛盾（planId 说 must pass prompt / prompt 说 optional+default）→ 统一「optional but recommended」
- **task_create activeForm**「agent 名」→ 对齐 Claude builtin + Tasks UI 的进行时文案语义（如 "Running tests"）
- **archive_plan** cwd precheck「process.cwd()」→「caller session cwd / cwd_release_marker」（MCP server 在主进程，process.cwd 对 caller 无意义）+ 明示「用 ExitWorktree 不是 shell cd」

### 缺失（agent 拿不到关键调用信息）
- **spawn_session** adapter/cwd/prompt/teamName 零 describe → 补（adapter 两档含义 / cwd 绝对路径 / prompt 首条消息 / teamName 组队语义 standalone vs lead+teammate）
- **enter_worktree** 补「不改 SDK cwd，用绝对路径 / `git -C`；CREATE 语义，复用既有 worktree 别调本 tool」
- **list_sessions** 返回字段补 `teams[{teamId,...}]`（agent 取 teamId 给 send_message 不必 N+1 调 get_session）
- **task_update** blocks/blockedBy/labels 补「数组整体替换（省略=不动 / `[]` 清空）」
- **report_issue/append** logsRef 强调 `date` required（即使只更新 tsRange/scopes/note）
- **spawn_session** parentSessionId 补「internal, leave unset」

### 信息密度（提示词 5 约束）
- strip 8 处 field describe 的内部编号前缀（`REVIEW_XX HIGH-X:` / `CHANGELOG_XX:`）—— 对调用 agent 零价值
- send_message multi-team teamId 精确化（「share >1 active team 才传，共享单 team 自动 resolve」）
- task blocks/blockedBy「IDs」→「Task UUID」；task_create「auto-closed」→「auto-derived」
- 文件头 tool count 15 → 17（10 + 5 task + 2 issue）

## 验证

- **决策对抗**：外部 claude（1 HIGH + 7 MED + 8 LOW）+ codex（5 HIGH + 5 MED + 2 LOW）各独立 finding，lead 三态裁决合并去重；两路各补对方盲区（codex 抓 callerSessionId/teamId/status drift；claude 抓 teamName 零文档 / deleted-tool refs / activeForm 跨工具语义 / systemic 编号前缀）
- `pnpm typecheck` 清 + 全量 vitest 1089 passed / 197 skipped（description-only，无 schema 逻辑改动）

## follow-up
- hand_off_session / archive_plan tool-level 长描述（~2500 字符）瘦身（信息准确但密度可再压，return-shape / teamTaskPolicy 三态可移字段层）—— 留后续
- **task_create activeForm 代码级语义不一致**（claude 抓）：`task-create.ts:95` 把 activeForm 映射成 `assignee`，但 Tasks UI（`TasksSection.tsx`）按进行时文案渲染。本期仅对齐 description 到 UI/builtin 语义，代码级 dual-usage 需单独裁决修复（description-only 不动 code logic）
