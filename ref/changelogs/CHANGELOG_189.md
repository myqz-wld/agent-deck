# CHANGELOG_189 — Issue Tracker 体验与协议改进（状态同步 / 活跃-已解决 tab / kind 收敛 / update_issue_status）

> 用户在「问题」面板提的 4 点改进 + 1 追加（kind 收敛）。需求 3 是一次**协议变更**：打破旧
> 「agent 只写不查 / 永不修改 status」铁律，给 issue 的源会话 / 解决会话开一个受控的自助改 status 口子。

## 需求 1：详情状态下拉不刷新（接续 CHANGELOG_188 Bug#2 的残留缺口）

- **根因**：`IssueDetail.tsx` 的「起新会话解决」回调 `onResolved` 只 `setIssue(updated) + upsertIssue(updated)`，把本地 `issue` 与 store 设成**同一对象**；CHANGELOG_188 加的 store-`updatedAt` 订阅 effect 守卫 `base.updatedAt === issueFromStore.updatedAt → return` 随即短路，负责回填下拉的 `setEditing` 永不执行 → 下拉卡在 dialog 打开那刻的旧 `open`。`handleSave` 因自带 `setEditing` 无此问题，正是 `onResolved` 漏了对称收尾。
- **修法**：`onResolved` 回调补 `setEditing(toEditing(updated))`（一行，与 `handleSave:170` 对齐）。

## 需求 2：活跃 / 已解决 两 tab，默认隐藏 resolved

- `issues-store.ts` initial `filters` 改 `{ statuses: ['open','in-progress'], showDeleted: false }`（默认只见活跃）。
- `IssuesPanel.tsx` FilterBar 的 status 多选 chip（`toggleStatus`）换成两个互斥 `StatusTab`：「活跃」(`['open','in-progress']`) / 「已解决」(`['resolved']`)，active 态由 `filters.statuses` 是否含 `'resolved'` 判定。底层 `selectFilteredIssues` + IPC list 不动（已支持 statuses 过滤）。「显示已删除」checkbox 保留。

## 需求 4：kind 推荐值 5 → 2（只留 `follow-up` + `app-bug`）

- kind 仍是**软枚举**（free-form fallback 不变，老 issue 的 external-tooling-bug / convention-gap / enhancement 等原样显示）。
- 收敛点：`IssuesPanel.KIND_OPTIONS` / `shared/types/issue.ts` `IssueKind` 联合类型 + 注释 / `schemas.ts` `REPORT_ISSUE_SCHEMA.kind` describe / 两份提示词 kind 表格（claude-config + codex-config）。

## 需求 3：`update_issue_status` mcp tool（源 / 解决会话自助 resolve/reopen）

- **新 tool**（17 → 18 tool）`mcp__agent-deck__update_issue_status({ issueId, status, note? })`：
  - **授权边界放宽一档**：`issue.sourceSessionId === callerSid || issue.resolutionSessionId === callerSid` 才放行（比 append_issue_context 严格 source-bound 多认解决会话）；第三方 reject。两者皆 null（会话 GC）→ 只能走 UI。
  - **可选 note 留痕**：note 非空 → 复用 `issueRepo.appendContext`（body=note, appendedSessionId=callerSid）写一条补充记录，再 `issueRepo.update({status})` 走 D15 resolved_at 状态机。
  - 软删 reject；deny external；emit `issue-changed` kind=`updated`；返回完整 IssueRecord 含 appendices。
- **闭环关键**：`ResolveInNewSessionDialog.buildDefaultPrompt` 末尾追加 issueId + 处置指引，让被起的解决会话拿得到 issueId 才能调 tool（修复前 prompt 不含 issue.id）。
- 文件：新建 `tools/handlers/update-issue-status.ts`；`schemas.ts` 加 `UPDATE_ISSUE_STATUS_SCHEMA` + infer/result type；`types.ts` 加 toolName + `EXTERNAL_CALLER_ALLOWED.update_issue_status=false`；`tools/index.ts` 注册；`append-issue-context.ts` resolved-reject hint 补「源/解决会话可调 update_issue_status 改回」。

## SSOT 注释 / 提示词同步（铁律措辞更新）

- `shared/types/issue.ts`（status / IssueStatus / IssueAppendix 三处注释）、`shared/ipc-channels.ts:84`、`report-issue.ts`：「agent 永不修改 status / 仅 2 个 write」→「status 仅源/解决会话经 update_issue_status 可改，其余 read/admin 仍走 UI；3 个 write tool」。
- `resources/claude-config/CLAUDE.md` + `resources/codex-config/CODEX_AGENTS.md` §Issue 上报节：标题加 update_issue_status / 「只写不查」改 3 write tool / **「不上报」强化「当场就能顺手修掉的直接修别 report」** / 新增 §update_issue_status 小节（授权边界 + 典型用法 + note 留痕）。
- `v026_issues.sql:18` 注释为历史 schema 快照，**不改**。
- **未做（留 follow-up）**：3 张 puml（`ref/architecture/issue-tracker-state-machine.puml` / `issue-tracker-architecture.puml` / `ref/flows/issue-tracker-flow.puml`）含「agent 永不改 status / 只写不查 2 write tool」需更新 —— 走 `flow-arch-plantuml` SKILL 经用户确认后改。

## 验证

- `pnpm typecheck` 通过；`pnpm exec vitest run src/main/agent-deck-mcp/` 全绿（35 files / 558 passed / 3 skipped binding ABI）。`issue-tools.test.ts` 38 → 51 tests（+11 update_issue_status：源/解决会话授权 / 第三方 reject / note 留痕 / 软删 / enum / external deny；review 后再 +2：双 null reject / note-append 后 update 返 null）。
- 改了 main（mcp handler）→ 需重启 dev 才生效；renderer 改动 HMR。
- GUI 端到端手测留用户：①起新会话解决后详情下拉立即 in-progress ②默认只见活跃、切「已解决」tab 见 resolved ③kind chip 仅 2 个 ④解决会话调 update_issue_status 能标 resolved、第三方会话被拒。

## 决策对抗 review 结论（多轮异构 deep-review，reviewer-claude Opus + reviewer-codex gpt-5.5）

协议变更（破「agent 永不改 status」铁律 + 扩展授权边界）已跑 2 轮异构对抗 + 反驳轮 + 三态裁决，双方共识 conclude。

- **授权逻辑安全确认**（核心结论）：`update_issue_status` 的 `sourceSessionId===callerSid || resolutionSessionId===callerSid` 授权判定**无 null 误放行**——三者独立证伪（双 reviewer + lead 现场验证）：`makeCallerContext` 保证 callerSid 永远非空 string（空→`__external__` sentinel），`withMcpGuard`→`denyExternalIfNotAllowed` 在 handler 前拦外部 caller，故两者皆 null（会话 GC）时 `null===callerSid` 恒 false → reject。agent 无法自封 resolutionSessionId（仅 IPC `IssuesResolveInNewSession` 可写，`UPDATE_PATCH_SCHEMA` 排除该字段）。
- **修复的 finding**：
  - MED：`report_issue` tool desc / 注释 3 处「含 issueId」→「返回 IssueRecord，主键字段 `id`，当后续 `issueId` 入参」（避免误导 agent 取错字段）。
  - MED（测试）：补「source/resolution 皆 null → reject」cell（原矩阵缺，§12.3 第三方 reject 用的是双非 null）。
  - LOW：`IssueDetail` reopen 后（D15 保留 resolved_at 但 status≠resolved）显示「上次解决于」，仅 resolved 时「解决于」。
  - LOW：SSOT 残留计数 17→18 tool / 2→3 issue write tool（`schemas.ts` ×2 + `shared/types/issue.ts`；顺手修范围外 pre-existing `mcp-server-init.ts` 运行时 logger + `query-options-builder.ts` 注释两处 stale「15 tool」）。
  - LOW：`issue.ts:15` kind「5 个推荐值」残留 → 「2 个」（CHANGELOG_189 需求 4 同文件改漏）。
  - LOW（注释/测试精度）：note 事务非原子 benign 窗口注释补强（update throw 留 note 自愈说明）；note-update-null 用例补 `update` 被调断言。

## MED-1 时序竞态（resolutionSessionId 写回窗口）— 轻量缓和 + 完整修复留 follow-up

- **窗口**：`ipc/issues.ts:273` 先 `await createIssueResolutionSession`（启动 SDK + 消费首轮 prompt，期间 canUseTool 已可触发）→ `:294` 才写回 `resolutionSessionId`。解决会话若首轮极早期就调 `update_issue_status`，DB 里 resolutionSessionId 尚未写入 → 落第三方分支被 reject。
- **本次轻量缓和**（用户拍板，非物理堵窗）：① `buildDefaultPrompt` 诱导「全部处理/修复完成后再标状态」天然错开窗口 ② reject hint 补「刚起的解决会话几秒后重试（写回有微延迟）」把 silent reject 变可理解的一时错。双 reviewer 验证缓和方向成立（实质避开「启动即调」真实触发点）。
- **完整结构修复为何留 follow-up**（本次 review 最重要的认知产出）：物理堵窗需让 `resolutionSessionId` 在 SDK 消费 prompt 前就写回，但 lead 调研 `createSession` 两 adapter 实现发现根本矛盾——claude-code spawn 主路径 sid 经 `tempKey→realId` 演化（stream-processor `renameSdkSession`），`createSession` 返回的 realId ≠ prompt 消费前唯一已知的 tempKey；解决会话 callerSid（=applicationSid=realId，D7 wire prefix）与 tempKey 不同值。要对齐需改 sdk-bridge 核心会话身份机制（tempKey→realId 演化 / renameSdkSession / isNewSpawn 三分支 / D2 spawn rename / D7 invariant），远超本次 issue 体验改善 scope 且高风险。**已用 report_issue 登记独立 follow-up issue**，后续走复杂 plan 完整流程（worktree + RFC + spike 验证 createSession 预分配 sid 可行性 + flow-arch puml + deep-review）。

## 后续

- ✅ 决策对抗 review 已完成（本文件「决策对抗 review 结论」节）。
- puml 更新走 flow-arch-plantuml SKILL（4 张：`issue-tracker-state-machine` / `issue-tracker-architecture` / `ref/flows/issue-tracker-flow` / `issue-tracker-append-decision`，把「agent 永不改 status / 只写不查 2 write tool」旧描述同步成「3 write tool / 源-解决会话经 update_issue_status 可改 status」）。
- MED-1 完整结构修复独立 follow-up（见上节，已 report_issue 登记）。
