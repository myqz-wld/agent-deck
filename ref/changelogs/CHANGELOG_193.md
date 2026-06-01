# CHANGELOG_193 — 提示词资产瘦身：CLAUDE.md / CODEX_AGENTS.md / issue tool 描述 + schema 精简

## 概要

承接 [CHANGELOG_192](CHANGELOG_192.md) 提示词资产重构主题，对两端配置文件 + agent-deck-mcp issue 工具描述 + schema 做**纯精简瘦身**：削冗余描述、对齐两端对称、保留全部调用契约与强约束。原会话（reviewer pair 起在 team `asset-polish-review`）SDK channel 断开后由 SQLite 历史还原收口。

**净减 ~156 行**（170 insertions / 326 deletions，8 文件）：

- `resources/claude-config/CLAUDE.md` −178 行区间：删冗余展开描述
- `resources/codex-config/CODEX_AGENTS.md` −218 行区间：删 codex recoverer 段落与 claude 端对称、瘦身 mcp 工具速查
- `src/main/agent-deck-mcp/tools/index.ts`：archive_plan / hand_off_session / enter_worktree / exit_worktree / shutdown_baton_teammates / report_issue / append_issue_context / update_issue_status 8 个 tool 描述从「内部 §D 编号 + 实现细节」改写为「面向调用方的行为契约」短描述
- `src/main/agent-deck-mcp/tools/schemas.ts` −68 行：REPORT_ISSUE / APPEND_ISSUE_CONTEXT / UPDATE_ISSUE_STATUS schema 的 field `.describe()` 与 doc 注释精简（去内部 §D 引用 + callerSessionId 统一为「Auto-injected — leave unset」）
- 4 份 SKILL.md（claude/codex × deep-review/simple-review）：`SKILL 自动 cp 落地` 的 TL;DR blockquote 折叠为单句 inline（纯排版，零契约内容）

## 对抗式深度评审（team `asset-polish-review`）

reviewer-claude（Opus 4.7）+ reviewer-codex（gpt-5.5）异构对抗，审 4 文件未提交 diff（CLAUDE.md / CODEX_AGENTS.md / index.ts / schemas.ts）。**0 HIGH，1 MED（双方独立命中 + lead 读源码验证 ✅），2 INFO**。双方明示「修掉 MED 即可合」。

### [MED] index.ts append_issue_context 描述把 deleted 的恢复路径错并到 update_issue_status（本次 slimming 引入，已修）

- **问题**：精简后描述把 `resolved or deleted` 合并成一句「reopen it first with update_issue_status」。这对 `resolved` 成立，对 soft-deleted **不成立**——`update-issue-status.ts:57-62` 同样 reject 软删 issue，agent 无法用它自助 reopen 已删 issue（只能 `report_issue` 新建 / UI restore）。
- **验证手段**（读两处 handler reject 分支，非纯推理）：
  - `append-issue-context.ts:62-67` `if (issue.deletedAt !== null)` → reject，hint=「report_issue 重新上报 / UI 端先恢复」，不含 update_issue_status
  - `update-issue-status.ts:57-62` `if (issue.deletedAt !== null)` → reject，hint=「无法改 status，请 UI 端先恢复」
- **裁决**：✅ 真问题（双方独立提出=异构强冗余 + lead 现场读源码验证）。严重度 MED（edge case + handler 当场返回清晰 hint 自纠，blast radius 小）。
- **修法**：(1) `append_issue_context` 描述拆开 resolved / deleted 两条恢复路径（deleted → 只能 report 新 issue / UI restore；resolved → 可 update_issue_status reopen）；(2) `update_issue_status` 描述补回「rejects soft-deleted issues（restore from the UI first）」——slimming 时被误删。

### INFO（未在本轮强改）

- **INFO-1**（pre-existing，非本 diff 引入）：`CODEX_AGENTS.md:275` hand_off_session 签名 `adapter?: "codex-cli"` 与 `schemas.ts:415` `.default('claude-code')` 不符，易被误读为默认值。reviewer-claude 建议留 follow-up → 已 `report_issue` 落 issue `a46ef1a8`（low）。
- **INFO-2**：CLAUDE.md / CODEX_AGENTS.md §上报后 append 约束简化为「还没 resolved」略了「软删」。两 reviewer 均「可不改」——本节开头已声明「完整签名见工具描述」，全局信息未丢，保持 slimming 意图不回填。

## 验证

- `pnpm typecheck` 双配置绿
- `pnpm exec vitest run src/main/agent-deck-mcp/__tests__/issue-tools.test.ts` 51/51 passed（确认 schema/描述精简无行为回归）

> 注：纯 .md + tool 描述 + schema `.describe()` 文案精简，无运行时逻辑变更。
