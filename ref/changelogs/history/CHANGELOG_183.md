# CHANGELOG_183 — Phase E 核心：提示词资产分层（删 codebase 内部引用）+ §Issue 上报 章节

> plan deep-review-and-asset-polish-20260530 §Phase E（E1/E2/E3/E5 + 决策对抗修复）。claude-config/CLAUDE.md + CODEX_AGENTS.md 是注入**所有** Agent Deck 项目 SDK 会话的通用约定 → 不得含 agent-deck 自身 codebase 内部细节（源码路径/行号 / 内部 REVIEW 编号）。

## 背景

claude-config/CLAUDE.md（claude 视角）与 CODEX_AGENTS.md（codex 视角）随应用打包注入到每个 SDK 会话 system prompt 末尾，**任何**使用 Agent Deck 的项目都会加载。E1 分层审计：这两份资产里残留的 agent-deck 源码路径（`recoverer.ts:103-220` / `schemas.ts` / `hand-off-session.ts:21-39` / `types.ts EXTERNAL_CALLER_ALLOWED`）+ 内部 REVIEW 编号注入到别项目会误导读者（路径/编号在别项目不存在）。E2 新增 §Issue 上报 通用能力章节（report_issue / append_issue_context 任何 Agent Deck 内项目可用）。

## 变更内容

### E1 分层审计：删源码路径 + 行号引用（保能力描述）
- `resources/claude-config/CLAUDE.md`：删 4 处 `src/...:行号` 源码引用（dormant 机制 / wire format SSOT / hand-off spawn-link / recoverer cwd fallback 的能力描述全保留，仅去源码定位）；§大文件拆分 示例 `recoverer.ts 对偶拆` → 中性 `worker.ts`；`SessionList Phase C` → `SessionList`（去内部 phase 编号）
- `resources/codex-config/CODEX_AGENTS.md`：删 5 处（同上 4 类 + `types.ts EXTERNAL_CALLER_ALLOWED.shutdown_baton_teammates = false` 内部常量引用，plan E1 清单漏列本项）
- `resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md`：删 §Sandbox 限制 的 `sandbox-config.ts:92-110` 源码引用（denyRead 13 项 / workspace-write 范围描述保留）
- **泛化追溯**：claude-config §EnterWorktree stale base bug 的 `REVIEW_38.md` + plan `worktree-stale-base-bug-20260515` + cli.js byte offset → 泛化「基于实测复现确认非推测（cli.js 反编译 + git man page 实证 + reflog 证据）」（保 evidence 锚点价值去 agent-deck 项目特定编号/相对链接）

### E2 §Issue 上报 章节（两端各一份独立 SSOT）
- `claude-config/CLAUDE.md` + `CODEX_AGENTS.md` 末尾各加 `## Issue 上报（report_issue / append_issue_context）`（与 §Universal Team Backend 同级）：何时上报（5 类 kind 表 + 不上报边界）/ report_issue 字段表（必传/默认/枚举）/ append_issue_context source-bound + resolved/软删 拒 append + logsRef 合并规则 / **agent 只写不查**（无 list/get/update/delete，查询 triage 走 UI）

### E3 arch-flow 引用对齐（复核，无改动）
- 复核确认 Phase D 已对齐：claude-config「codex 端走法」bullet 已写「codex 有独立 flow-arch SKILL」；CODEX_AGENTS.md §plantUML 节引用 codex flow-arch SKILL 一致；无「codex 无 SKILL 入口」旧表述残留

### 决策对抗修复（双外部 CLI 异构：claude Opus 4.7 + codex；lead 三态裁决）
- **§Issue 上报 准确性（Q1，双 reviewer + 现场验证）**：
  - 返回字段名修正：原写「返回完整 IssueRecord，含 `issueId`」误导 → IssueRecord 主键字段是 `id`（`issue.ts:79` + handler `return ok(created)` + `issue-tools.test.ts:145` 断言 `{id:'i1'}` 实证），append 入参才叫 `issueId`。改「返回完整 IssueRecord（主键 `id`，不是 `issueId`），把该 `id` 作为 append 入参 `issueId`」。否则 agent `result.issueId` 拿 undefined → append 失败
  - append reject 条件补「软删 issue」：原只列 source-bound + resolved，handler（`append-issue-context.ts:62`）对 `deletedAt !== null` 也 reject → 合并为「resolved / 软删 拒 append」
  - logsRef 补「date 始终必填」（append 即使只更 tsRange/scopes/note，schema describe 特意 bold date required）
- **5 约束清理（Q4）**：CODEX_AGENTS.md ShutdownAllTeammates 节删「若产品需要…需另外加 `reassignOwner(...)` 调用（目前未实现）」future/未实现预测（违约束 2 当前事实不写预测）；claude-config stale-base callout 删内部 `R37` 编号（与隔壁泛化的 REVIEW_38 清理不一致，claude reviewer 指出）

## 验证

- 纯 .md 资产改动无 TS delta → typecheck N/A（plan E6「如动 schemas」条件未触发，本 phase 未碰 schemas.ts）
- 决策对抗：reviewer-claude（claude -p Opus xhigh）+ reviewer-codex（codex exec xhigh）各独立审；本 diff 自身两方判定「正确且零过头、无 HIGH/MED 引入、Phase E 可合」
- grep 自检：两文件无残留 file:line 源码路径 / 无 R37 / 无 future 预测词；§Issue 上报 新内容约束 2/3 干净

## Follow-up（决策已定，待实施 — 见 plan §当前进度）

- **codex 契约节（Q3 决策对抗结论 = α，双 reviewer 一致）**：CODEX_AGENTS.md **缺** §决策对抗 / §三态裁决 / §Finding 输出契约 三节（claude-config 自包含，codex 不加载 claude-config）→ codex 普通会话「下结论前决策对抗」零覆盖 + codex deep-review SKILL/reviewer-codex 4 处 cross-ref 指向 claude-config 打包后断链。→ 补 codex 风格三节 + 改 4 cross-ref 指向 CODEX_AGENTS.md 同文件（CHANGELOG_184 实施）
- **F5 广义内部名残留（双 reviewer HIGH，pre-existing 非本 diff 引入）**：两文件仍含内部 class.method（`sessionRepo.delete` / `sessionManager.close` / `runBatonCleanup` / `agentDeckTeamRepo` 等）+ 内部编号（`N5` / `N2.c` / `D1 ADR`）+ DB 列名等纯实现符号。需逐项区分「运行环境概念（保留）vs 纯实现符号（删）」的 careful pass，单独 follow-up（避免 rushed 过度 strip 误杀运行概念）
