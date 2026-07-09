# CHANGELOG_180 — plan issue-tracker-mcp-20260529 完整归档（agent 执行问题追踪机制 mcp tool + UI Issues tab + GC scheduler 全套）

## 概要

[plan `issue-tracker-mcp-20260529`](../../plans/history/issue-tracker-mcp-20260529.md) 完整收口归档。新机制让 agent 执行过程中遇到「需要后续处理的问题」可即刻通过 `mcp__agent-deck__report_issue` / `append_issue_context` 上报到 SQLite issues 表 + UI 顶层「问题」tab 单独可见，用户可在 UI 端手动 triage（filter / 改字段 / 软删 / 「起新会话解决」一键 spawn 接力）。

**净增改**: 13 新文件 + 14 修改文件 ≈ +4200 LOC（净增 — 含完整 backend + UI + 测试）。pnpm typecheck ✅ + pnpm build ✅（main 748KB / preload 25KB / renderer 1.4MB）+ pnpm vitest 83 issue tests pass + 38 issue-repo tests skipped（binding ABI；Step 3.2 commit `c628930` 已在 Node 20.18.3 ABI 115 + prebuild-install 验过 38/38 pass）。6 commit 实施（`c628930` schema+repo / `d1170a3` mcp tool / `80ddd98` event chain / `852caf4` IPC / `96f2c6c` settings+scheduler / `350b269` UI tab + settings UI）。

**不变量守约**（plan §不变量 9 条）:
- ✅ §1 **agent 只能写、不能查** — 仅暴露 `report_issue` + `append_issue_context` 两个 write tool;**不**暴露 issue_list / issue_get / issue_update / issue_delete（由 `AGENT_DECK_TOOL_NAMES` 常量 + `tools/index.ts` 注册清单不挂保证 — 根本不存在,不是 deny external）
- ✅ §2 **issue 独立生命周期** — `issues.source_session_id` / `resolution_session_id` 都 `ON DELETE SET NULL`,**不**与 tasks 表 `ON DELETE CASCADE` 对称（issue 是面向用户的看板,不因后台 session GC 而静默消失）;UI 渲染 `sourceSessionId=NULL` 时显示「原会话已被清理」
- ✅ §3 **append_issue_context 严格 source-bound** — handler 强制校验 `issue.sourceSessionId === ctx.caller.callerSessionId`,跨 session / 跨 caller append 一律 reject + D10 详细 hint
- ✅ §4 **logsRef 是定位指针不是日志体** — schema `{date YYYY-MM-DD, tsRange?, scopes?, note?}` 严格 zod 校验;UI 端按 logsRef.date 拼日志文件路径自助读（path SSOT 在 runtime-logging-electron-log plan §D2/§D3,本 plan 不耦合）
- ✅ §5 **status 状态机仅 UI 端人工推进** — agent 永不修改 status;UI IPC IssuesUpdate zod 严格 enum reject;「起新会话解决」按钮回写 status='in-progress' 不是 resolved（让用户最终确认）
- ✅ §6 **软删 + GC 机制双轨** — UI 软删走 deleted_at（列表默认隐藏）;硬删由 `IssueLifecycleScheduler` 6h tick 跑（resolved>90d + soft-deleted>7d）
- ✅ §7 **report_issue / append_issue_context 都 deny external caller** — 写 DB + 关联 caller session,HTTP/stdio external client 直接 reject（与 task_create / task_update 同款）
- ✅ §8 **logsRef 接 electron-log 但不强耦合** — runtime-logging plan 未合时日志文件不存在 → UI 优雅退化为「日志文件不存在」提示,issue 列表 / detail 其他字段照常工作
- ✅ §9 **append 累积走 issue_appendices 子表** — 不动 issues.description 1-2000 char 不变量;UI detail 按 appendedAt asc read-only 渲染

## 变更内容

### Step 0 RFC（3 轮对齐 design 大方向 — 2026-05-29）

3 轮 AskUserQuestion 多维度对齐: data 载体（独立 issues 表 vs 复用 tasks vs 双轨）/ 现场附着（inline vs logsRef vs 混合）/ agent scope（只写不查 vs 完整 CRUD）/ UI 视图（独立 tab vs SessionDetail 嵌入 vs Settings 内）/ mcp tool 数量 / kind 软枚举 / status 几态 / 「起新会话解决」spawn 方式 / DB schema 全字段 / append 权限 / FK CASCADE 行为 / UI 交互满级 / GC 机制 / spawn 路径 D14 / **post-merge normalize** / 命名约定 D18 / 返回 record 设计 D19 / GC tick 间隔 D20。结论 20 条设计决策（D1-D20）+ §不变量 9 条 + §已知踩坑 9 条。

### Step 0.5 spike (a) — spawn from IPC layer mini spike（2026-05-30）

`<plan-artifact-dir>/spike-reports/spike1-spawn-from-ipc.runner.mjs` 6 个静态实证 check（不真起 SDK 烧钱 — 生产 `src/main/ipc/adapters.ts:105-182` AdapterCreateSession handler 走同款 `adapterRegistry.get(id).createSession(buildCreateSessionOptions(...))` 路径多年是铁证）。6/6 pass:① adapter.createSession 调用存在 ② buildCreateSessionOptions 调用存在 ③ setSpawnLink 仅 mcp tool spawn handler 调（IPC handler 不调） ④ v009 migration DDL `spawn_depth DEFAULT 0` ⑤ recordCreatedPermissionMode 持久化 ⑥ buildCreateSessionOptions typed overload narrow。结论:D14 选定路径 (b) 完全成立 — IPC handler 抽 `createIssueResolutionSession` helper 复用 IPC AdapterCreateSession 11 项边界硬化 pattern。

### Step 1.5 Deep-Review plan（5 轮 reviewer × fix loop — 2026-05-29 ~ 2026-05-30）

invoke `agent-deck:deep-review` SKILL kind='plan' 评审 plan。**5 轮共 30+ finding fix 落地**:
- R1 5 HIGH + 11 MED + 4 LOW 全 ✅（schema 字段 / namespace 命名 / D14 实施细节 / 测试矩阵覆盖 等）
- R2 1 HIGH + 5 MED + 5 LOW 全 ✅（spawn entry SSOT D14b 不变量 / D17 post-merge normalize / IssueChangedEvent 顶级 sourceSessionId 字段对称 TaskChangedEvent.ownerSessionId 等）
- R3 0 HIGH + 3 MED + 4 LOW 必修（kind DDL CHECK 长度兜底 / logsRef args empty obj reject / cwd DDL 长度上限 / scheduler before-quit stop / D14 不可 optional chain 等）
- R4 0 HIGH + 1 MED + 5 LOW（recordCreatedPermissionMode 持久化关键 §会话恢复 硬约束 / D14 cwd 长度 4096 / helper 不暴露 attachments / IssuesUpdate args zod test 强 enum reject 等）
- R5 0 HIGH + 0 MED + 2 LOW（双方 §收口判定满足 → SKILL Step 6 shutdown reviewer × 2）

### Step 3 实施（2026-05-30 接力 session 1+2+3，10 substep group）

**Step 3.1 — DB schema migration v026**（commit `c628930` 子集）:
- `src/main/store/migrations/v026_issues.sql` — `issues` + `issue_appendices` 双表（§D9 全文 — 16 issues 列含 DDL CHECK + 6 partial index `WHERE deleted_at IS NULL / WHERE resolved_at IS NOT NULL` 等 + 双向 FK SET NULL（§D11）+ appendices CASCADE）
- `src/main/store/migrations/index.ts` 静态注册（reviewer F4 — 漏改 initDb 永不应用 v026 全部运行时崩）
- sqlite3 CLI 独立 DB 验 schema 落地 + typecheck 过

**Step 3.2 — issue-repo.ts 持久层**（commit `c628930` 子集）:
- `src/main/store/issue-repo.ts` 486 行单文件 facade（与 task-repo 同款）— 9 method（create / get / update / list / softDelete / undelete / hardDelete / listForGc / appendContext / listAppendices）
- `src/shared/types/issue.ts` 类型 SSOT（IssueStatus / IssueSeverity / IssueKind soft enum / LogsRef / IssueAppendix / IssueRecord / IssueChangedEvent 含顶级 sourceSessionId 字段对称 TaskChangedEvent.ownerSessionId — §D7 R3 LOW F7）
- `src/shared/types.ts` barrel re-export
- `__tests__/issue-repo.test.ts` 38 tests（Node 20.18.3 ABI 115 实测 pass — CRUD / D15 resolved_at 状态机 8 case / D17 logsRef merge 4 字段 + post-merge normalize / appendContext + CASCADE / list filter / softDelete + undelete idempotent / listForGc 阈值边界）
- `_setup.ts` 补 v025 + v026 import

**Step 3.3 — mcp tool report_issue + append_issue_context**（commit `d1170a3`）:
- `src/main/agent-deck-mcp/tools/schemas.ts` 加 `LOGS_REF_SCHEMA` 严格化（date YYYY-MM-DD regex / tsRange refine start<=end / scopes max 32 + item max 64 / note max 2000 / empty obj refine reject）+ `REPORT_ISSUE_SCHEMA` + `APPEND_ISSUE_CONTEXT_SCHEMA`（全 camelCase §D18）+ Result types `IssueRecord`（§D19）
- `src/main/agent-deck-mcp/tools/handlers/report-issue.ts` — withMcpGuard + closure `sourceSessionId` + cwd 兜底链（args > sessionRepo.cwd > null）+ emit kind='created'
- `src/main/agent-deck-mcp/tools/handlers/append-issue-context.ts` — source-bound 校验（D10 hint）+ status='resolved' reject（D7）+ race null reject + emit kind='appended'
- `src/main/agent-deck-mcp/types.ts` — `AGENT_DECK_TOOL_NAMES.reportIssue / appendIssueContext`（15 → 17 tool）+ `EXTERNAL_CALLER_ALLOWED.report_issue / append_issue_context = false`（强 TS 完整覆盖）
- `src/main/agent-deck-mcp/tools/index.ts` — 注册两 write tool（仅 write 不挂 read — §不变量 1）
- `__tests__/issue-tools.test.ts` **40 tests** pass（happy + cwd 兜底 + kind 默认 + severity 默认 + free-form fallback / severity strict / 4 owner-only reject case / 6 zod 严格化 case / external caller deny 矩阵 + args 长度边界）
- bonus: `event-bus.ts` EventMap 提前加 `'issue-changed': [IssueChangedEvent]`（Step 3.4.2 工作子集 — handler emit 需 typecheck pass）

**Step 3.4 — issue-changed event chain F5**（commit `80ddd98`）:
- `src/shared/ipc-channels.ts` IpcEvent.IssueChanged 加（含详细 jsdoc — hardDeleted issue:null + snapshot sourceSessionId 设计）
- `src/main/index/bootstrap-wiring.ts` listener 桥 `eventBus.on('issue-changed') → safeSend(IpcEvent.IssueChanged)`（紧贴 task-changed line 60 同位置）
- `src/preload/api/events.ts` `onIssueChanged(cb)` typed facade
- Step 3.4.6 renderer 端订阅推迟到 Step 3.8.5 issues-store 落地后由 component 自订阅（与现有 task-changed "renderer 暂未消费但基础设施已通" 同款模式 — grep 'onTaskChanged' src/renderer/ zero 命中证明该 pattern 已成项目惯例）

**Step 3.5 — IPC handler + preload facade + 11 项边界硬化**（commit `852caf4`）:
- `src/main/ipc/issues.ts` 374 行 — handler 全 named export（test 直调避免 mock electron ipcMain 复杂度）;3 个 zod schema（LIST_FILTER / UPDATE_PATCH .strict 严格 enum / RESOLVE_IN_NEW_SESSION .strict）;6 handler;`createIssueResolutionSession` helper 11 项硬化（adapter parse / 反查不 optional chain / canCreateSession / cwd ≤4096 / prompt ≤102400 / cwd fallback args>issue.cwd>homedir / 不暴露 attachments / adapter.createSession + buildCreateSessionOptions / **`recordCreatedPermissionMode` 持久化** §会话恢复 硬约束 / 写回 resolutionSessionId + status='in-progress'）;in-flight Promise dedupe Map（同 issueId 并发 click return 同 Promise + spawn 完成/失败 finally 清条目 — §D14 UI throttle 兜底）
- `src/preload/api/issues.ts` — 6 typed method facade + 接口
- `src/preload/index.ts` spread issuesApi
- `src/shared/ipc-channels.ts` — 6 channel 常量
- `src/main/ipc/index.ts` registerIssuesIpc 注册
- `__tests__/issues.test.ts` **32 tests** pass（zod enum reject 4 case + partial patch idempotent + soft+undelete 改 deletedAt + emit + idempotent silent false + createIssueResolutionSession 11 项硬化全验 + ResolveInNewSession happy + cwd fallback + in-flight dedupe 3 case + recordCreatedPermissionMode 持久化）

**Step 3.6 — settings 加 GC 阈值字段**（commit `96f2c6c` 子集）:
- `src/shared/types/settings/app-settings.ts` 加 `issueResolvedRetentionDays` + `issueSoftDeletedRetentionDays`
- `src/shared/types/settings/defaults.ts` — 90 / 7（resolved 三月后硬删 / 软删一周后硬删）
- `src/main/ipc/settings.ts` — `applyIssueGcThresholds(p, next)` helper + 进 APPLY_FNS pipeline（紧贴 applyLifecycleThresholds 同位置）

**Step 3.7 — IssueLifecycleScheduler**（commit `96f2c6c` 子集）:
- `src/main/store/issue-lifecycle-scheduler.ts` 118 行 — constructor `{tickIntervalMs?, resolvedRetentionDays, softDeletedRetentionDays}` 默认 6h（§D20）;start() idempotent + 立即跑一次 tick;scan() listForGc → 逐条 snapshot before hardDelete → emit kind=hardDeleted + sourceSessionId snapshot 钉死;单条 throw try/catch console.warn 不中断;updateThresholds 热更新;setIssueLifecycleScheduler / get 单例 hook
- `src/main/index/_deps.ts` `BootstrapState.issueScheduler` 字段
- `src/main/index/bootstrap-infra.ts` wire（紧贴 TeamLifecycleScheduler 同位置）
- `src/main/index/lifecycle-hooks.ts` before-quit `state.issueScheduler?.stop() + setIssueLifecycleScheduler(null)` 防 timer 在 quit 期间继续碰 DB
- `__tests__/issue-lifecycle-scheduler.test.ts` **11 tests** pass（阈值 0 跳过 / resolved 超期 / soft-deleted 超期 / 多条混合 sourceSessionId 各自钉死 / FK SET NULL / snapshot null race / hardDelete false race / 单条 throw 不中断 / updateThresholds 热更新 / setInterval lifecycle + idempotent）

**Step 3.8 — UI Issues tab**（commit `350b269` 子集）:
- `src/renderer/App.tsx` View enum 加 'issues' + import IssuesPanel + TabButton 「问题」+ view 分支渲染
- `src/renderer/components/IssuesPanel.tsx` — 左右双栏 list + detail;filter 栏（status 多选 / kind 多选 / search title debounce 300ms / show deleted toggle）;component 自订阅 onIssueChanged 推 store（hardDeleted→removeIssue / 其他→upsertIssue — 与 task-changed "component 自订阅" 同模式）
- `src/renderer/components/IssueDetail.tsx` — main 字段可改（status 3 态下拉 / kind free-form / title / description / repro / severity 严格 enum / labels 逗号分隔）+ meta read-only（sourceSessionId null 显示「原会话已被清理」）+ logsRef read-only + appendices appendedAt asc read-only + action bar 保存/起新会话/软删/恢复
- `src/renderer/components/ResolveInNewSessionDialog.tsx` — adapter/cwd/prompt 三必填;buildDefaultPrompt 按 §D8 template（null 字段整段省略）;submit 期间 button disabled UI throttle（§D14 兜底 — IPC handler in-flight Promise dedupe 双重防 React 双 click）
- `src/renderer/stores/issues-store.ts` — zustand store Map<id, IssueRecord> + filters + selectedIssueId + selectFilteredIssues selector（createdAt DESC + filters 渲染前再过滤一次 让实时事件流跨 filter scope 的 issue 不污染当前视图）

**Step 3.9 — Settings GC 阈值 UI**（commit `350b269` 子集）:
- 决策调整: 不新建独立 IssuesGcSection.tsx,改挂到现有 `src/renderer/components/settings/sections/LifecycleSection.tsx` 内（已有 historyRetentionDays,issue 2 GC 阈值同 GC 性质 — 一站式让用户找到所有 GC 阈值,UI 更紧凑 + 改动最小）。加 2 个 `NumberInput`: `issueResolvedRetentionDays` / `issueSoftDeletedRetentionDays`

**Step 3.10 — 验证**:
- ✅ pnpm typecheck 全过
- ✅ pnpm vitest 83 pass + 38 skipped（issue-repo binding ABI；Step 3.2 commit 已实测 pass）
- ⏳ pnpm dev GUI 集成验证留 user 自跑（需交互验证）
- ✅ pnpm build 生产构建过（main 748KB / preload 25KB / renderer 1.4MB）

### Step 4 归档（本 commit + archive_plan tool 调用）

调 `mcp__agent-deck__archive_plan({plan_id: 'issue-tracker-mcp-20260529', worktree_path: <abs>, base_branch: 'main', changelog_id: '178'})` 一键完成 ff-merge / mv plan / mv spike-reports/ / commit / git worktree remove / branch -D。

## 已知踩坑

详 plan §已知踩坑 9 条，重点：
1. **runtime-logging-electron-log plan 未上线时 logsRef UI 渲染优雅退化**（§不变量 8）
2. **issues.cwd 字段不做 normalize** — 上报时原样落 caller 自报 cwd 字符串
3. **append_issue_context 跨 caller / 跨 session reject 错误信息要详细** — D10 文案 SSOT
4. **camelCase 字段约定**（§D18 + CHANGELOG_177 收口）
5. **spawn 路径走 `adapter.createSession(buildCreateSessionOptions)` adapter 层 API**（§D14 + D14b — sessionManager.createSession 不存在）
6. **issues 表 INDEX 加 `WHERE deleted_at IS NULL` partial index** 让 list 默认查询走 partial index 性能高
7. **issue_appendices 子表 ON DELETE CASCADE** — issue 硬删时 appendices 一并删
8. **resolved_at 状态机 9 case 必须全 test 覆盖** — Step 3.2 repo 层 8 + Step 3.5.6 IPC zod 第 9
9. **`activeWindowMs` vs `intervalMs` 不要混** — LifecycleScheduler 的 activeWindowMs 是阈值不是周期；IssueLifecycleScheduler 用独立 `tickIntervalMs` 默认 6h

## 关联

- 上游: plan `mcp-tool-camelcase-migration-20260529`（CHANGELOG_177 — 32 字段 camelCase 收口让本 plan 全 camelCase 实施无歧义）
- 平行: plan `runtime-logging-electron-log-20260529`（logsRef 接 electron-log 但不强耦合 — §不变量 8 优雅退化设计）
- 后续可能 follow-up: 「起新会话解决」spawn 之后的 session 在 SessionDetail 视图加 Issue 关联面板（plan §D4 决策 B — 只挂顶层 Issues tab 不挂 SessionDetail；未来若用户需可单独开 plan）
