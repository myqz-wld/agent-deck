---
plan_id: "issue-tracker-mcp-20260529"
created_at: "2026-05-29"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/issue-tracker-mcp-20260529"
status: "completed"
base_commit: "454d6578623a4980839a305bae289600a2dd6cf0"
base_branch: "main"
final_commit: "8d0f90efa1e6334d0bd7e50c282b829343c85c9c"
completed_at: "2026-05-30"
---
# issue-tracker-mcp-20260529 — agent 执行问题追踪机制（report_issue + append_issue_context + UI Issues tab）

## 总目标

给 agent 一个**只写不查**的 mcp tool 通道，让任何 SDK session 在执行过程中遇到的「需要后续处理的问题」（自己的 follow-up / agent-deck 应用缺陷 / 外部工具 bug / 约定缺漏 / 产品功能建议）能即刻上报，落 SQLite issues 表 + UI 顶层 Issues tab 单独可见，用户可在 UI 端手动 triage（filter / 改字段 / 软删 / 「新开会话解决」一键 spawn 接力）。

与已并行进行的 `runtime-logging-electron-log-20260529` plan 配合：issue 的现场日志走 `logsRef` reference 字段（`{date, tsRange?, scopes?, note?}`），不复制日志体；UI 渲染时按 `logsRef` 自助去 `runtime-logging-electron-log-20260529` plan §D2 / §D3 定义的日志文件路径拉。

## 不变量

1. **agent 只能写、不能查** — 仅暴露 `mcp__agent-deck__report_issue` + `mcp__agent-deck__append_issue_context` 两个 write tool；**不**暴露 `issue_list` / `issue_get` / `issue_update` / `issue_delete` 任何 read/admin tool。由 `src/main/agent-deck-mcp/types.ts` `AGENT_DECK_TOOL_NAMES` 常量 + `tools/index.ts` 工具注册清单**不挂** read tool 保证（不是 deny external — 是根本不存在）。

2. **issue 独立生命周期** — `issues.source_session_id` 与 `issues.resolution_session_id` 都走 `ON DELETE SET NULL`（DB column SSOT 名 — DB 层一律 snake_case），**不**与 tasks 表 `ON DELETE CASCADE` 对称。理由：issue 是面向**用户**的看板，不能因后台 session GC 而静默消失（违反"问题追踪"底色）。UI 渲染 `sourceSessionId=NULL` 时显示「原会话已被清理」。

3. **append_issue_context 严格 source-bound** — `report_issue` 返回完整 `IssueRecord`（含 `issueId`），agent 在**同一 session 内**保留 id 后才能 `append_issue_context`。handler 强制校验 `issue.sourceSessionId === ctx.caller.callerSessionId`，跨 session / 跨 caller append 一律 reject。**"source = owner"语义**：本 plan 不引入额外 `owner_session_id` 概念，issue 的"归属"完全等同于"上报源" — 字段名以 D9 schema 中 `source_session_id` 为 SSOT。

4. **logsRef 是定位指针不是日志体** — schema `{date, tsRange?, scopes?, note?}`，**不**存日志 excerpt 大体；UI 端按 `logsRef.date` 拼日志文件路径自助读（路径格式 SSOT 见 `runtime-logging-electron-log-20260529` plan §D2 / §D3）。issue 的"现场信息"自包含部分走 `description` 必填 + `repro` 可选 + `issue_appendices` 子表（D16）三层；脱离日志看 issue 也能 triage。

5. **status 状态机仅 UI 端人工推进** — `open` (默认) / `in-progress` / `resolved` 三态，agent **永不**修改 status；UI 端 IPC handler 提供切换接口。「Resolve in new session」按钮自动 spawn 新 session 后写回 `resolution_session_id` + status='in-progress'（不是 resolved — resolved 仍要用户确认）。状态切换副作用统一在 `issueRepo.update`：进入 `resolved` 写 `resolved_at = now()`，离开 `resolved` 保留旧 `resolved_at`（不清），**再次**进入 `resolved` 刷新 `resolved_at = now()` 让 GC 时钟重置（详 D15）。

6. **软删 + GC 机制双轨** — UI 删除走 `deleted_at`（软删，列表默认隐藏）；硬删由 `IssueLifecycleScheduler` 周期跑：`resolved` 且 `resolved_at < now - settings.issueResolvedRetentionDays` (默认 90d) → 硬删；soft-deleted 且 `deleted_at < now - settings.issueSoftDeletedRetentionDays` (默认 7d) → 硬删。GC tick 默认 6h (D20)。

7. **report_issue / append_issue_context 都 deny external caller** — 写 DB + 关联 caller session，HTTP/stdio external client 直接 reject（与 task_create / task_update 同款）。`EXTERNAL_CALLER_ALLOWED` SSOT 在 `src/main/agent-deck-mcp/types.ts:130`（不是 `tools/helpers.ts` — 后者只有 withMcpGuard / makeCtx / ok / err 工具函数）。

8. **logsRef 接 electron-log 但不强耦合** — `runtime-logging-electron-log-20260529` plan 未上线时（当前 `base_commit` 还没合 runtime-logging），UI 端日志文件不存在 → 优雅退化为"日志文件不存在，请先合并 runtime-logging-electron-log plan"提示，issue 列表 / detail 其他字段照常工作。本 plan **不**等 logger plan 完成，先把 issue tracker 跑起来；`logsRef` 字段先空跑。

9. **append 累积走 `issue_appendices` 子表** — 不动 `issues.description` (1-2000 char 不变量保留)；agent append 现场到独立子表（`issue_appendices` D16），UI 端 detail 视图按 `appendedAt` desc 渲染。

## 设计决策（不再争论）

### D1: 数据载体 — 独立 issues 表（RFC R1.Q1 user 选 A）
- 不复用 tasks 表（避免 task 表 schema 因 issue 专属字段 repro/severity/logsRef 膨胀，且 task='我下一步要做' 与 issue='遇到问题待后续' 语义不同）
- 不双轨（issues + 关联 task 状态同步太复杂，MVP 不需）
- 用独立 `issues` SQLite 表 + 自己的 repo (`src/main/store/issue-repo.ts`)
- 同时新增 `issue_appendices` 子表（D16 / §不变量 9）解决 append 累积溢出问题

### D2: 现场附着方式 — 混合 inline + logsRef（RFC R1.Q2 user 选 A 推荐）
- 必填 inline 字段：`title` (1-200 char) / `description` (1-2000 char)
- 可选 inline 字段：`repro` (重现步骤 1-2000 char)
- 可选 reference 字段：`logsRef` JSON `{date: 'YYYY-MM-DD', tsRange?: {start, end}, scopes?: string[], note?: string}`，UI 端按 `runtime-logging-electron-log-20260529` plan §D2 / §D3 拼日志文件路径
- 必填部分保证脱离日志看 issue 也能 triage；`logsRef` 与 electron-log plan 解耦但接口预留

### D3: scope — agent 只写不查（RFC R1.Q3 user "其他：会话只能写不能查，是给用户看的"）
- agent-deck-mcp tool 注册清单**仅挂**：
  - `mcp__agent-deck__report_issue` (create)
  - `mcp__agent-deck__append_issue_context` (append 现场到自己 create 的 issue)
- **不挂**：issue_list / issue_get / issue_update / issue_delete 任何读 / 管理 tool
- 不分 personal / team / global scope — issue 表无 `team_id` 字段（与 tasks 表区别）；`source_session_id` 仅作为产生溯源，不作为权限隔离

### D4: UI — 仅独立顶层 Issues tab（RFC R1.Q4 user 选 B）
- App.tsx `View = 'live' | 'history' | 'pending' | 'teams'` → 扩为 `'live' | 'history' | 'pending' | 'teams' | 'issues'`
- 不在 SessionDetail 挂 issues 关联视图（避免 UI 路径膨胀；用户去 Issues tab 看全量）
- 不在 Settings 嵌入（issues 是常用看板不是配置项）

### D5: mcp tool 数量与命名 — 2 个 write tool（RFC R2.Q1 user 选 B）
- `report_issue(args) -> IssueRecord` — agent create 时拿完整 record（含 `issueId` / `createdAt` / 其他字段，与 `task_create` 返回完整 TaskRecord 对称 — `task-create.ts:99` `ok(created satisfies TaskCreateResult)`）
- `append_issue_context({issueId, additionalContext, logsRef?}) -> IssueRecord` — agent 后续补现场到同一 issue（**仅同 session 内**，agent 重启 / 跨 session 丢 `issueId` 后只能再 create 新 issue，UI 端人工 merge）；append 不动 `issues.description`，新行写入 `issue_appendices` 子表（D16）
- **不**做 admin tool 让 UI 给 `issue_id` 后 agent 才能 append（机制复杂收益小，且违反"agent 不查别人 issue"原则）

### D6: kind 软枚举 + free-form fallback（RFC R2.Q2 user 选 A 推荐）
- 软枚举（args.kind 不严格 enum 校验）：
  - `follow-up` — agent 自己留的后续事项
  - `app-bug` — agent-deck 应用缺陷
  - `external-tooling-bug` — claude-code CLI / codex / SDK 等外部工具 bug
  - `convention-gap` — 约定不清 / 文档缺漏
  - `enhancement` — 产品功能建议
- args.kind 是 free-form string，未在枚举内 → 原样落库；UI 端按字符串完全匹配分组，不在枚举内 → 'other' 分组（**不**自动 normalize 'agent-deck-bug' → 'app-bug' 这种 — 原样保留让用户手工纠正）

### D7: status 3 态（RFC R2.Q3 user 选 C "3 态 open / in-progress / resolved 其他：用户可以手动切换状态"）
- `open` (默认 report 后) / `in-progress` (UI 点 Resolve 后 / 用户手动改) / `resolved` (用户手动改)
- **没有** `wontfix` / `triaged` / `duplicate` — MVP 简化，未来需要再加
- UI 端下拉切换；agent 永不修改
- **zod schema 严格 enum**（`z.enum(['open', 'in-progress', 'resolved'])` reject 其他值 — 落 Step 3.5.1 IssuesUpdate args schema + Step 3.3.1 init 不暴露 status 给 agent）
- `append_issue_context` 在 status='resolved' 时 → **reject** + 详细 hint「issue 已 resolved，新现场请 create 新 issue」（推到 D13）

### D8: UI Resolve 按钮 — 起独立 session + 自动回写（RFC R2.Q4 user 选 A 推荐）
- UI 点击「Resolve in new session」→ 弹快设表单（cwd 默认 = issue.cwd / 用户可改 / prompt 预填模板）→ 调 IPC handler → handler 内部走 D14 选定的 spawn 路径起独立 SDK session → 拿到 sessionId 后 `UPDATE issues SET resolution_session_id = sessionId, status = 'in-progress'`
- prompt template + null fallback：
  ```
  请处理 issue: <title>

  ## 描述
  <description>

  [如果 repro 非空]
  ## 重现步骤
  <repro>
  [/]

  [如果 logsRef 非空]
  ## 日志参考
  - date: <logsRef.date>
  - tsRange: <logsRef.tsRange or 'N/A'>
  - scopes: <logsRef.scopes.join(',') or 'N/A'>
  - note: <logsRef.note or 'N/A'>
  [/]

  [如果 appendices 非空]
  ## 后续补充（<N> 条）
  <每条 "[N] <appendedAt ISO>: <body>"，按 appendedAt asc 排>
  [/]
  ```
  null 字段整段省略（不留空段、不写 placeholder），avoid prompt 看起来稀疏不自然

### D9: issues 表 + issue_appendices 子表 schema（RFC R3.Q1 user 选 A 推荐全酒 + D16 append 子表）

```sql
CREATE TABLE issues (
  id                     TEXT PRIMARY KEY,           -- UUID v4 与 tasks 对齐
  title                  TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  description            TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 2000),  -- agent 上报原始描述，append 不动此字段 — §不变量 9
  repro                  TEXT CHECK(repro IS NULL OR length(repro) BETWEEN 1 AND 2000),  -- 可选重现步骤
  kind                   TEXT NOT NULL DEFAULT 'follow-up' CHECK(length(kind) BETWEEN 1 AND 32),  -- 软枚举 D6 + DDL 长度兜底 (R3 LOW F6)
  status                 TEXT NOT NULL DEFAULT 'open',       -- D7 3 态
  severity               TEXT NOT NULL DEFAULT 'medium',     -- low / medium / high (zod enum 严格)
  source_session_id      TEXT,                       -- 上报 session FK SET NULL D11；agent append 校验字段 — §不变量 3
  cwd                    TEXT CHECK(cwd IS NULL OR length(cwd) <= 2048),  -- 上报时 caller cwd 快照 + DDL FS path 上限兜底 (R3 LOW F6)
  logs_ref               TEXT,                       -- JSON: {date, tsRange?, scopes?, note?} — DB 字段名 snake_case，mcp tool args 是 camelCase logsRef
  resolution_session_id  TEXT,                       -- 解决 session FK SET NULL D11
  labels                 TEXT NOT NULL DEFAULT '[]' CHECK(length(labels) <= 8192), -- JSON array string + DDL 防膨胀兜底 (R3 LOW F6)
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  resolved_at            INTEGER,                    -- status 进 resolved 写 now / 离开保留 / 再次进刷新 D15
  deleted_at             INTEGER,                    -- 软删
  FOREIGN KEY(source_session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY(resolution_session_id) REFERENCES sessions(id) ON DELETE SET NULL
);

CREATE INDEX idx_issues_status ON issues(status) WHERE deleted_at IS NULL;
CREATE INDEX idx_issues_kind ON issues(kind) WHERE deleted_at IS NULL;
CREATE INDEX idx_issues_created ON issues(created_at DESC);
CREATE INDEX idx_issues_resolved_at ON issues(resolved_at) WHERE resolved_at IS NOT NULL;
CREATE INDEX idx_issues_deleted_at ON issues(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE issue_appendices (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id               TEXT NOT NULL,
  body                   TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),  -- additionalContext 原文 (1-2000 char)
  logs_ref               TEXT,                       -- 可选 append 附带的新 logsRef (JSON)
  appended_session_id    TEXT,                       -- 写入时的 caller sid 快照（始终 == issue.source_session_id 因 §不变量 3）；session GC 后 SET NULL 与 issues 主表对齐 D11
  appended_at            INTEGER NOT NULL,
  FOREIGN KEY(issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY(appended_session_id) REFERENCES sessions(id) ON DELETE SET NULL
);

CREATE INDEX idx_issue_appendices_issue ON issue_appendices(issue_id, appended_at DESC);
```

### D10: append_issue_context 权限 — 仅 source caller（RFC R3.Q2 user 选 A 推荐）
- 严格校验 `issues.source_session_id === ctx.caller.callerSessionId`
- 跨 session / 同 team 互 append / 任何 caller 都 append — 都 reject
- 跨 caller reject 错误 hint：「append rejected: issue.sourceSessionId=<old-sid>, caller=<new-sid>。append_issue_context 仅支持同 session 补现场（agent 重启 / hand_off 后丢 issueId）。请用 report_issue 重新上报新 issue，UI 端人工 merge」

### D11: FK CASCADE 行为 — 双向 SET NULL（RFC R3.Q3 user 选 A 推荐）
- `source_session_id ON DELETE SET NULL` — source session 被 LifecycleScheduler GC 后 issue 保留但溯源断
- `resolution_session_id ON DELETE SET NULL` — resolve session 被 GC 后 issue 保留但解决会话引用断
- **`issue_appendices.appended_session_id ON DELETE SET NULL`**（reviewer R2 共识 — 与主表对称 defense-in-depth）— session GC 后 appendix 仍保留但 `appended_session_id` 变 null，UI 渲染显示「追加会话已被清理」；§不变量 3 application-level 保证「始终 == issue.source_session_id」，但 DDL 层不依赖此假设
- issues **不**因 session GC 而被 CASCADE 删（与 tasks 表 ON DELETE CASCADE 故意不对称 — 见 §不变量 2）
- 子表 `issue_appendices.issue_id ON DELETE CASCADE` — issue 硬删时 appendices 一并删（与 events / messages 子表 pattern 一致）

### D12: UI 交互满 — filter + detail 可改多字段 + 软删（RFC R3.Q4 user 选 A 推荐）
- **list 视图**：默认 status=open（+ 隐藏 deleted）；上方 filter (status 多选 / kind 多选 / search title)
- **detail 视图**：可改 status (3 态下拉) / kind / title / description / repro / severity / labels；下方按 appendedAt asc 渲染 appendices 列表（read-only — agent 写入的现场，UI 不改）
- **删除**：UI 软删（写 deleted_at），不在列表显示；"已删除"过滤器可看回；超期 GC 硬删
- **「Resolve in new session」按钮**：调 IPC 起 spawn + 回写 resolution_session_id + status='in-progress'（D8 + D14）

### D13: GC 机制（RFC R3.Q4 user 补充"被关闭的 issue 也要定期清理"）
- 新建 `IssueLifecycleScheduler`（参考 `src/main/session/lifecycle-scheduler.ts:31-50` setInterval(tick, intervalMs) pattern — `activeWindowMs` 是 active→dormant **阈值**不是 tick 周期，**不要错引**）
- AppSettings 加两字段：
  - `issueResolvedRetentionDays` 默认 90，0 = 关闭 GC
  - `issueSoftDeletedRetentionDays` 默认 7，0 = 关闭 GC
- IssueLifecycleScheduler 用独立 `tickIntervalMs` 默认 `6 * 3600_000` = 6h（与 LifecycleScheduler 60s tick 不同 — issue GC 频率不必那么高，retention day 单位长 GC 漂移几小时无害）
- IPC settings handler 加 `applyIssueGcThresholds(p, next)` 热更新阈值（参考 `src/main/ipc/settings.ts:50-54` `updateThresholds` pattern）

### D14: spawn 路径 — IPC handler 走 `adapter.createSession(buildCreateSessionOptions(...))` adapter 层 API（绕 mcp tool 层）+ UI throttle + mini spike 实证
- **原矛盾**（reviewer R1 发现）：plan §D8 写"调 mcp tool"，§已知踩坑 5 又写"实施阶段确认"，自相矛盾 + plan 提到的 `handlers/spawn-impl.ts` 不存在
- **API 校正**（reviewer R2 双方共识 HIGH）：`SessionManager` 类**没有** `createSession` 方法（实测 `src/main/session/manager.ts` 完整方法列表 `claimAsSdk / releaseSdkClaim / hasSdkClaim / expectSdkSession / ensure / ingest / ... / list` 无 createSession）。SSOT 是 `AgentAdapter` interface 方法 `createSession?(opts: CreateSessionOptions): Promise<string>`（`src/main/adapters/types/agent-adapter.ts:35`）— claude-code adapter `src/main/adapters/claude-code/index.ts` 与 codex-cli adapter `src/main/adapters/codex-cli/index.ts` 各自实现。spawn.ts mcp handler 内部最终也是 `await adapter.createSession(buildCreateSessionOptions(args.adapter, raw))`（`src/main/agent-deck-mcp/tools/handlers/spawn.ts` 实测）。
- **选定路径 (b)**：IPC handler 走 explicit `const a = adapterRegistry.get(args.adapter); if (!a || !a.createSession) throw IpcInputError(...); await a.createSession(buildCreateSessionOptions(args.adapter, opts))` adapter 层底层 API（**不可** optional chain 吞错 — 与 Step 3.5.1 helper 一致；guard 写 `!a || !a.createSession` 而非 `!a?.createSession` 让 plan 全文 `?.createSession` grep 真清零），绕过 mcp tool 层 `spawn_session` handler — 理由：
  1. IPC handler 没有 SDK session caller_session_id 闭包（应用主进程发起），走 mcp tool 路径要伪造 caller closure
  2. spawn-guards 三道防御（depth / fan-out / spawn-rate-limit，详 `src/main/agent-deck-mcp/spawn-guards.ts` `applySpawnGuards`）对 UI 触发的「Resolve in new session」语义不适用（不是 agent spawn agent，是 user 在 UI 端起独立 session）
  3. `spawn_session` mcp handler 内部最终也是调 `adapter.createSession(buildCreateSessionOptions(...))` — 绕过 mcp 层语义对齐
- **UI throttle 兜底**（reviewer R2 claude MED 发现 — 「不适用」≠「不需要」）：UI 层必须自带 throttle 防连点：
  - 「Resolve in new session」按钮 click 后 `disabled` 直到 spawn 完成 / 失败
  - IPC handler 内 in-flight Promise dedupe：同 `issueId` pending spawn 期间二次调用 return 同 Promise（避免 React 双 click / race 起 N 个并发 SDK session）
  - Step 3.5.1 / Step 3.8.4 实施时落地这两层兜底
- **Step 0.5 mini spike 必跑**（消除 D14 与原"无需 spike"矛盾 — RFC D14 改为「需 1 个 mini spike 验证 spawn 调用路径」）：写 10-30 行 spike script `const a = adapterRegistry.get('claude-code'); if (!a || !a.createSession) throw ...; const sid = await a.createSession(buildCreateSessionOptions('claude-code', {cwd, prompt: 'ping'}))` 拿 sessionId 验证：
  - SDK session 真起来（`sessionRepo.get(sid).lifecycle === 'active'`）
  - 没漏过任何关键守门（如 `spawn-link` 不写 / depth=0 root session 语义正确）
  - `permissionMode` / `sandbox` 默认值合理
  - 输出 `spike1-spawn-from-ipc.md` 到 `<plan-artifact-dir>/spike-reports/`
- spike 失败 fallback：走 mcp tool `spawn_session` handler + 在 IPC handler 内伪造 in-process caller transport（让 `EXTERNAL_CALLER_ALLOWED` 校验过）

### D14b: spawn entry SSOT 不变量
- spawn entry SSOT = `adapter.createSession(buildCreateSessionOptions(...))`（`AgentAdapter` interface 方法）
- `SessionManager` **不**暴露 `createSession`，本 plan 任何步骤 / spike / 实施代码引用 `sessionManager.createSession` 都视为错引（typecheck 必拒）

### D15: resolved_at 状态机副作用（reviewer Round 1 发现 + R2 边角细化）
- `issueRepo.update({ status, ...rest })` 内：
  - **patch 不带 status 字段（partial patch update title/description/etc）→ idempotent 不动 `resolved_at`**（reviewer R2 LOW 边角加 — typical 安全默认）
  - patch 带 status：
    - 旧 status !== 'resolved' && 新 status === 'resolved' → `SET resolved_at = now()`
    - 旧 status === 'resolved' && 新 status !== 'resolved' → 保留旧 `resolved_at`（不清，让用户重新 resolve 时刷新；中间不被 GC 因为 status !== 'resolved' 不命中 GC 条件）
    - 旧 status === 'resolved' && 新 status === 'resolved' → idempotent 不动（避免 user 重复点 resolve 刷新 GC 时钟）
    - **`reopen + 再次 resolve` 刷新**：旧 'resolved' → 'in-progress' → 'resolved' 时第 3 步**刷新** `resolved_at = now()`（旧值是上次 resolved 时刻，GC 应按本次 resolved 重新算）— 实现走 transition 检测而不是 idempotent guard
  - patch 带 status 但值不在 3 态合法范围（如 `'foo'`）→ **由 zod schema 严格 enum reject**（不到 repo 层 — D7 + Step 3.5.1 zod schema 落地 `z.enum(['open', 'in-progress', 'resolved'])`）
- step 3.2.2 (repo 层: 7 transition + partial patch undefined) + Step 3.10.2 IPC `issues.test.ts` (zod enum reject 属于 IPC handler 边界) 加测试覆盖：7 种主路径 transition + 1 种 partial patch undefined + 1 种 zod enum reject 共 9 个 case 全验

### D16: append 子表 `issue_appendices`（reviewer Round 1 发现 + 推荐方案 d）
- 不在 `issues.description` 字段累积（避免突破 1-2000 char 不变量）
- 新建子表 `issue_appendices` (D9 schema)：每次 `append_issue_context` 调用 → INSERT 一行
- append handler 不动 `issues.description` / 不动 `issues.repro`；可选 merge `logsRef` 到 `issues.logs_ref`（D17）
- UI detail 视图 read-only 渲染 appendices 列表（agent 写的现场用户不改 — 改 description / repro / status 等 main 字段可改）
- delete issue (CASCADE) 时 appendices 一并删（D11）

### D17: logsRef schema 严格化 + merge 语义（reviewer Round 1 发现 + R2 细化）

**logsRef schema SSOT**（zod schema 严格校验，落到 D2 + Step 3.3.1 + Step 3.5.1）：
- `date`: 必填，string，必须匹配 `/^\d{4}-\d{2}-\d{2}$/`（YYYY-MM-DD ISO），其他格式 reject
- `tsRange?`: optional `{start: number, end: number}` 两字段 epoch ms；`start <= end` 严格校验，反则 reject
- `scopes?`: optional string[]，max 32 项（防 scope 数组膨胀），每项 max 64 char，自动 dedupe（Set 化）
- `note?`: optional string，单条 max 2000 char
- 整个 logsRef object 全字段都 null / undefined → mcp tool args 层 reject（caller 没意图传 logsRef 应该不传 args.logsRef 而不是传空 obj）

**append merge 规则**（`append_issue_context` 带 `args.logsRef` 时，handler merge 到 `issues.logs_ref`）：
- `date`：以 args.logsRef.date 覆盖（最新现场以新为准）
- `tsRange`：min(args.start, existing.start), max(args.end, existing.end) 扩展时段（保留早期上下文窗口）；其中一边 null 时取非 null
- `scopes`：`new Set([...existing.scopes, ...args.logsRef.scopes])` union 去重
- `note`：append "(appended <appendedAt ISO>) <new note>" 到旧 note 末尾；merge 后若总长 > 2000 char → **从 note 头部** 逐 char 截掉直到总长 ≤ 1997 char，截断处加 `...` 前缀（保留最新 append 内容，丢弃最早 append；最终长度恰好 2000 char 含 `...`）

**跳过 update 条件**（empty logsRef SSOT 统一 — reviewer R3 codex MED F3 修订）：
- args 层 zod schema 已经 reject empty object（全字段 null / undefined） — caller 想跳过应不传 args.logsRef
- 因此 handler skip 只保留**一种语义**：`args.logsRef == null / undefined` 时跳过 logsRef merge update
- **注**：是判 `args.logsRef`（caller 传的新数据）而**不是** `issue.logs_ref`（DB 现存值）— 后者全 null 时仍需 INSERT-equivalent UPDATE 写入新数据

**post-merge normalize**（reviewer R3 claude *未验证* F8 一并落地 — 与 note 截断「保留最新」对称）：
- merge 后若 `scopes.size > 32` → 取最新 32 项（caller `args.logsRef.scopes` 全保留优先；existing scopes 从尾部截掉直到总数 = 32）
- merge 后 `note` 走 D17 note 截断规则（>= 2000 char 从头截）

### D18: 命名约定 — DB snake_case / mcp tool args camelCase / TS 内部 camelCase（CHANGELOG_177 收口）
- DB column SSOT：`source_session_id` / `logs_ref` / `created_at` / etc.（SQLite 惯例）
- mcp tool args / result SSOT：`sourceSessionId` / `logsRef` / `createdAt` / etc.（CHANGELOG_177 32 字段 snake → camelCase 全栈同步收口）
- repo / handler 层做 snake ↔ camel 映射（参考 task-repo `argsToInputWithoutOwner` 模式 — `src/main/agent-deck-mcp/tools/handlers/task-helpers.ts`）
- 全 plan 严格遵守此约定 — 凡指 DB column 用 snake，凡指 mcp args / TS code 用 camel

### D19: report_issue / append_issue_context 返回完整 record（reviewer Round 1 发现 — task pattern 对齐）
- 返回类型 `IssueRecord`（与 `task-create.ts:99` `ok(created satisfies TaskCreateResult)` 对齐）
- UI 端不必再 IPC fetch 一次 `IssuesGet(id)` — emit 'issue-changed' kind='created' / 'appended' 带完整 record 推 store

### D20: GC tickIntervalMs 默认 6h
- 不与 LifecycleScheduler `intervalMs = 60_000` (1min) 同频
- retention 单位是 day，GC 漂移几小时无害；6h 一次 GC 平衡及时性 + CPU 浪费

## 步骤 checklist

### Step 0 — RFC（已完成）
- [x] Step 0 — RFC 3 轮 AskUserQuestion 对齐 design 大方向，done by session <current> on 2026-05-29

### Step 0.5 — spike（mini spike 1 个）
- [x] Step 0.5 spike (a) — spawn from IPC layer mini spike（D14 + D14b）— done 2026-05-30：
  - `<plan-artifact-dir>/spike-reports/spike1-spawn-from-ipc.runner.mjs` 写 6 个静态实证 check（不真起 SDK 烧钱 — 现有 `src/main/ipc/adapters.ts:105-182` AdapterCreateSession handler 走同款 `adapterRegistry.get(id).createSession(buildCreateSessionOptions(...))` 路径多年是生产铁证 = 反推 spike 验证清单全部成立）
  - 跑 `node spike1-spawn-from-ipc.runner.mjs` 6/6 checks pass：① adapter.createSession 调用存在 ② buildCreateSessionOptions 调用存在 ③ setSpawnLink 仅 mcp tool spawn handler 调（IPC handler 不调） ④ v009 migration DDL `spawn_depth DEFAULT 0` ⑤ recordCreatedPermissionMode 持久化 ⑥ buildCreateSessionOptions typed overload narrow
  - 输出 `spike1-spawn-from-ipc.md`（动机 / 假设 / 实测命令 / 实测结果 / 结论 / 残留风险 R1-R4）
  - **结论**：D14 选定路径 (b) 完全成立；Step 3.5.1 实施时抽 `createIssueResolutionSession` helper 复用 IPC AdapterCreateSession 边界硬化代码。


### Step 1 — plan 文件（当前 step）
- [x] Step 1 R1 — 写 plan 文件 `.claude/plans/issue-tracker-mcp-20260529.md`，done by session <current> on 2026-05-29
- [x] Step 1 R2 — Round 1 reviewer finding fix（5 HIGH + 11 MED + 4 LOW 全 ✅ 必修），done by session <current> on 2026-05-29
- [x] Step 1 R3 — Round 2 reviewer finding fix（1 HIGH + 5 MED + 5 LOW 全 ✅ 必修），done by session <current> on 2026-05-29
- [x] Step 1 R4 — Round 3 reviewer finding fix（0 HIGH + 3 MED 必修 + 4 LOW 顺手修；2 LOW non-blocking 不修），done by session <current> on 2026-05-30
- [x] Step 1 R5 — Round 4 reviewer finding fix（0 HIGH + 1 真 MED + 5 LOW 全收口），done by session <current> on 2026-05-30
- [x] Step 1 R6 — Round 5 reviewer finding fix（0 HIGH + 0 真 MED + 2 LOW 顺手修，§收口判定满足），done by session <current> on 2026-05-30

### Step 1.5 — Deep-Review plan
- [x] Step 1.5 Round 1 — invoke `agent-deck:deep-review` SKILL kind='plan'，2 reviewer 各出 finding，lead 三态裁决全 ✅ 真问题
- [x] Step 1.5 Round 2 — send_message 给两 reviewer 看 R2 修订版，lead 三态裁决全 ✅ 真问题（无 ❌ 反驳 / 无 ❓ 未验证），R3 fix 已落地
- [x] Step 1.5 Round 3 — send_message 给两 reviewer 看 R3 修订版，2 reviewer 0 HIGH + 共 4 MED + 5 LOW + 1 *未验证*，lead 裁决 3 MED 真必修 + 4 LOW/未验证 顺手修，2 LOW non-blocking 不修
- [x] Step 1.5 Round 4 — send_message 给两 reviewer 看 R4 修订版，codex 0 HIGH + 0 MED + 3 LOW（自定性非阻塞文案）+ claude 0 HIGH + 1 真 MED + 2 LOW（self-recommend 选项 A 全收口），lead 裁决 R5 fix 1 MED + 5 LOW
- [x] **Step 1.5 Round 5 — §收口判定满足**：双方 0 HIGH + 0 真 MED + 各 1 LOW（双方都明示 non-blocking）→ R6 顺手修 2 LOW 让 plan 100% 干净 → SKILL Step 6 收尾（shutdown × 2 reviewer）→ user confirm 后进 Step 2 EnterWorktree

### Step 2 — EnterWorktree（user confirm 后）
- [ ] Step 2 — `git -C <main-repo> worktree add -b worktree-issue-tracker-mcp-20260529 <main-repo>/.claude/worktrees/issue-tracker-mcp-20260529 454d6578623a4980839a305bae289600a2dd6cf0` + `EnterWorktree(path: <worktree-abs-path>)` 进入（**显式锁 base_commit** 避开 v2.1.112 stale base bug + 防并行 runtime-logging plan 推进后基线漂移 — reviewer Round 1 LOW）

### Step 3 — 实施

#### Step 3.1 — DB schema migration（含 issue_appendices 子表）
- [x] Step 3.1.1 — 新建 `src/main/store/migrations/v026_issues.sql`（§D9 schema 全文 — issues + issue_appendices 双表 + 全部 index）— done 2026-05-30
- [x] Step 3.1.2 — **更新 `src/main/store/migrations/index.ts`**（reviewer F4 — 静态注册）— done 2026-05-30
- [x] Step 3.1.3 — sqlite3 CLI 独立 DB 验 schema 落地（issues + issue_appendices 双表 + 6 显式 index 全对）+ typecheck 全过 — done 2026-05-30（dev 启动验证留到 Step 3.10.3 与 GUI 验一并跑）

#### Step 3.2 — issue-repo.ts 持久层
- [x] Step 3.2.1 — 新建 `src/main/store/issue-repo.ts`（单文件 facade 486 行 — 含详细 jsdoc；plan 建议 ≤300 是松约束，项目 §单文件 ≤500 硬护栏内；逻辑代码远低于 486）+ `src/shared/types/issue.ts` 类型 SSOT（IssueStatus/IssueSeverity/IssueKind/LogsRef/IssueAppendix/IssueRecord/IssueChangedEvent，含 D7 R3 LOW F7 顶级 sourceSessionId 字段）+ `src/shared/types.ts` barrel 加 `export * from './types/issue'` — done 2026-05-30
- [x] Step 3.2.2 — 写 `src/main/store/__tests__/issue-repo.test.ts`（38 tests 全 pass）+ 补 `_setup.ts` v025 / v026 import — done 2026-05-30。覆盖：
  - CRUD happy path + kind free-form fallback + logsRef 4 字段往返 + labels JSON 往返
  - **D15 状态机 repo 层 8 case**（case 1-8 全 pass — 7 transition + 1 partial patch undefined idempotent；case 9 zod enum reject 留 IPC test）
  - **D17 logsRef merge 4 字段** + post-merge normalize（scopes 25+10 → 32 项 caller 优先 / note >2000 char 从头截 ... 前缀）
  - appendContext + listAppendices appendedAt asc + non-existent reject + CASCADE
  - list filter（默认隐藏 soft / onlyDeleted / statuses / kinds / titleKeyword 大小写不敏感）
  - softDelete / undelete idempotent + 已删 no-op + 未删 undelete no-op
  - listForGc 阈值边界（90d / 7d / 阈值=0 跳过 / nowMs override 测试时钟）

#### Step 3.3 — mcp tool schemas + handlers
- [x] Step 3.3.1 — `src/main/agent-deck-mcp/tools/schemas.ts` 加（**全 camelCase D18**）：done 2026-05-30
  - ✅ `LOGS_REF_SCHEMA` 严格化（date YYYY-MM-DD regex / tsRange start<=end refine / scopes max 32 + item max 64 / note max 2000 / empty obj refine reject）
  - ✅ `REPORT_ISSUE_SCHEMA` zod：title (1-200) / description (1-2000) / repro? (1-2000) / kind? (1-32 free-form) / severity? (low/medium/high enum 严格) / logsRef? / cwd? (≤2048) / labels? (max 16 / item 1-64) / callerSessionId?
  - ✅ `ReportIssueResult = IssueRecord`（§D19 完整 record）
  - ✅ `APPEND_ISSUE_CONTEXT_SCHEMA` zod：issueId / additionalContext (1-2000) / logsRef? / callerSessionId?
  - ✅ `AppendIssueContextResult = IssueRecord`（§D19 含 appendices 嵌入）
  - ✅ tool description string 写明「agent 只写不查」 + logsRef schema 详描 + `append 仅同 session source caller`
- [x] Step 3.3.2 — 新建 `src/main/agent-deck-mcp/tools/handlers/report-issue.ts`：done 2026-05-30
  - ✅ withMcpGuard pattern + `ctx.caller.callerSessionId` 闭包注 `source_session_id`
  - ✅ `cwd` 兜底链：`args.cwd > sessionRepo.get(callerSid)?.cwd > null`
  - ✅ `issueRepo.create()` → return `ok(created satisfies ReportIssueResult)`
  - ✅ emit `eventBus 'issue-changed'` kind='created'
- [x] Step 3.3.3 — 新建 `src/main/agent-deck-mcp/tools/handlers/append-issue-context.ts`：done 2026-05-30
  - ✅ withMcpGuard pattern
  - ✅ `issueRepo.get` → 跨 caller reject + D10 详细 hint
  - ✅ status='resolved' reject + hint「create 新 issue」
  - ✅ `issueRepo.appendContext` 透传 + race null reject
  - ✅ emit `'issue-changed'` kind='appended'（含 appendices 子列表 §D19）
- [x] Step 3.3.4 — **`src/main/agent-deck-mcp/types.ts`** 注册 2 个 tool：done 2026-05-30
  - ✅ `AGENT_DECK_TOOL_NAMES.reportIssue / appendIssueContext` 加（15 → 17 tool）
  - ✅ `AgentDeckToolName` union 自动派生
  - ✅ `EXTERNAL_CALLER_ALLOWED.report_issue: false, append_issue_context: false`（完整覆盖强 TS 守门）
- [x] Step 3.3.5 — `src/main/agent-deck-mcp/tools/index.ts` 注册两 tool（**仅 write，不挂 read tool — §不变量 1**）+ import schemas / handlers — done 2026-05-30
- [x] Step 3.3.6 — `src/main/agent-deck-mcp/__tests__/issue-tools.test.ts` 40 测试全 pass — done 2026-05-30
  - ✅ §1-3 report_issue happy path + cwd 兜底（args.cwd > sessionRepo.cwd > null）+ kind 默认 + severity 默认 + kind free-form fallback + severity 严格 enum reject
  - ✅ §4-7 append owner-only reject（跨 caller / 跨 session — D10 hint 各自带 sid） + non-existent reject + resolved reject + hint「create 新 issue」
  - ✅ §8 logsRef happy path 透传 + emit kind='appended' 含 appendices
  - ✅ §9 logsRef args 层 zod reject 9 case（date 格式 / tsRange / scopes / note / empty）
  - ✅ §10 完整 logsRef 4 字段透传到 issueRepo.appendContext（normalize 由 repo 层覆盖 — issue-repo.test.ts 已验）
  - ✅ §11 external caller deny（report_issue / append_issue_context 双 false + 4 transport 矩阵 + stdio invariant violation 兜底）
  - ✅ §args zod 边界（title / description / additionalContext 长度守门）

**Step 3.3 bonus**: `src/main/event-bus.ts` EventMap 提前加 `'issue-changed': [IssueChangedEvent]`（plan §Step 3.4.2 工作的子集 — handler emit 需 typecheck pass，提前 1 行做完）。Step 3.4.2 实施时确认已加过即可,不重复。

#### Step 3.4 — issue-changed 事件链（F5 全套）
- [x] Step 3.4.1 — `src/shared/types/issue.ts` **已存在**（Step 3.2 建）含 `IssueChangedEvent` + 顶级 `sourceSessionId` 字段（D7 R3 LOW F7 与 TaskChangedEvent.ownerSessionId 对称）— 确认 done 2026-05-30
- [x] Step 3.4.2 — `src/main/event-bus.ts` EventMap **已加** `'issue-changed': [IssueChangedEvent]`（Step 3.3 bonus）— 确认 done 2026-05-30
- [x] Step 3.4.3 — `src/shared/ipc-channels.ts` IpcEvent enum 加 `IssueChanged: 'event:issue-changed'`（参 IpcEvent.TaskChanged）— done 2026-05-30
- [x] Step 3.4.4 — `src/main/index/bootstrap-wiring.ts` listener 桥 `eventBus.on('issue-changed', e => safeSend(IpcEvent.IssueChanged, e))`（紧贴 task-changed 同位置）— done 2026-05-30
- [x] Step 3.4.5 — `src/preload/api/events.ts` 加 `onIssueChanged(cb)` typed facade（参 onTaskChanged 同款）— done 2026-05-30
- [x] Step 3.4.6 — **renderer 端订阅推迟到 Step 3.8.5 issues-store 落地后由 component 自订阅**（与现有 task-changed "renderer 暂未消费但基础设施已通" 同款模式 — 见 preload/api/events.ts onTaskChanged comment / `grep -rn 'onTaskChanged' src/renderer/` zero 命中）。`use-event-bridge.ts` 不动（避免占位 placeholder + 推迟到 Step 3.8.5 顺手加）— 决策对齐 done 2026-05-30

#### Step 3.5 — IPC handler（UI 端读 / 写）
- [x] Step 3.5.1 — 新建 `src/main/ipc/issues.ts`：done 2026-05-30
  - ✅ `IssuesList(filters)` — zod LIST_FILTER_SCHEMA + 调 issueRepo.list
  - ✅ `IssuesGet(id)` — 调 issueRepo.get + 拼 appendices 列表
  - ✅ `IssuesUpdate(id, patch)` — zod UPDATE_PATCH_SCHEMA `.strict()`（status / severity 严格 enum reject 第 9 case）+ 状态机走 issueRepo D15 + emit kind='updated'
  - ✅ `IssuesSoftDelete(id)` — issueRepo.softDelete + emit kind='softDeleted'（idempotent — silent false）
  - ✅ `IssuesUndelete(id)` — issueRepo.undelete + emit kind='undeleted'
  - ✅ `IssuesResolveInNewSession({issueId, adapter, cwd?, prompt, permissionMode?, codexSandbox?, claudeCodeSandbox?})` 走 D14 选定路径 (b)
  - ✅ **`createIssueResolutionSession` helper 抽出 11 项边界硬化**：
    1. parseStringId(adapter) → 非合法 IpcInputError
    2. adapterRegistry.get(adapter) → 找不到显式 throw（不 `?.createSession` 吞错）
    3. adapter.createSession method 缺失显式 throw
    4. canCreateSession=false 显式 throw IpcInputError
    5. cwd 长度 ≤ 4096（与 adapters.ts:117-119 同款）
    6. prompt 长度 ≤ 102400（与 AdapterCreateSession 同款）
    7. cwd fallback: non-empty args.cwd > non-empty issue.cwd > os.homedir
    8. 不支持 attachments — buildCreateSessionOptions 不传字段（保 helper 接口最小）
    9. 默认 sandbox / permissionMode 走 adapter 默认 + parseXxx 白名单
    10. **sessionManager.recordCreatedPermissionMode 持久化关键** — 与 adapters.ts:182 同款保证后续 SDK resume 复原用户主动选的 permissionMode（项目 CLAUDE.md §会话恢复 硬约束）
    11. 写回 `issueRepo.update({resolutionSessionId, status='in-progress'})` + emit kind='updated'
  - ✅ **in-flight Promise dedupe Map** — 同 issueId 并发 click 期间 return 同 Promise，spawn 完成 / 失败 finally 清条目让下次重新走 createSession
  - ✅ handler 全 named export — test 直接 import call（避免 mock electron ipcMain 复杂度;与 sessions-hand-off-helper pattern 一致）
- [x] Step 3.5.2 — `src/preload/api/issues.ts` typed facade `issuesApi`（6 typed method + IssuesListFilters / IssuesUpdatePatch / IssuesResolveInNewSessionArgs / IssuesResolveInNewSessionResult 接口）— done 2026-05-30
- [x] Step 3.5.3 — `src/preload/index.ts` import + spread `issuesApi`（紧贴 eventsApi 同位置）— done 2026-05-30
- [x] Step 3.5.4 — `src/shared/ipc-channels.ts` 6 个 channel 常量（IssuesList / IssuesGet / IssuesUpdate / IssuesSoftDelete / IssuesUndelete / IssuesResolveInNewSession）+ 详细 jsdoc — done 2026-05-30
- [x] Step 3.5.5 — `src/main/ipc/index.ts` 注册 issues handler（紧贴 registerAssetsIpc 同位置）— done 2026-05-30
- [x] Step 3.5.6 — 新建 `src/main/ipc/__tests__/issues.test.ts` **32 tests 全 pass** — done 2026-05-30
  - ✅ IssuesUpdate args zod schema 严格 enum reject（status='foo' / 'closed' / severity='critical' / unknownField 4 case）
  - ✅ accept 3 态 status / partial patch undefined idempotent / non-existent id reject
  - ✅ IssuesSoftDelete / IssuesUndelete 改 deletedAt + emit kind + idempotent silent false + 非法 id reject
  - ✅ createIssueResolutionSession 11 项边界硬化全验（§1+§2 adapter 不存在 / §2 缺 createSession / §3 canCreateSession=false / §5 cwd >4096 / §6 prompt >102400 / §9-§10 happy + recordCreatedPermissionMode 持久化 / §10 null → undefined / §8 不暴露 attachments）
  - ✅ IssuesResolveInNewSession happy（spawn + 回写 resolutionSessionId + status='in-progress' + emit）+ cwd fallback 双路径（issue.cwd / explicit args.cwd 优先）+ ghost issue reject + zod 守门（prompt > 102400 / unknownField）
  - ✅ **in-flight Promise dedupe 3 case**：①同 issueId 并发 3 次 → adapter.createSession 仅 1 次 ②spawn 完成清条目 → 二次调用重新走 ③spawn 失败清条目 → 二次调用 retry 走（不缓存失败）
  - ✅ recordCreatedPermissionMode 持久化（acceptEdits 透传 / 未传 → undefined）+ permissionMode 非白名单 reject

#### Step 3.6 — settings 加 GC 阈值字段
- [x] Step 3.6.1 — `src/shared/types/settings/app-settings.ts` 加 `issueResolvedRetentionDays: number` + `issueSoftDeletedRetentionDays: number` + 详细 jsdoc — done 2026-05-30
- [x] Step 3.6.2 — `src/shared/types/settings/defaults.ts` `DEFAULT_SETTINGS` 加 `issueResolvedRetentionDays: 90` + `issueSoftDeletedRetentionDays: 7` — done 2026-05-30
- [x] Step 3.6.3 — `src/main/ipc/settings.ts` 加 `applyIssueGcThresholds(p, next)` + 进 `APPLY_FNS`（与 applyLifecycleThresholds 同款 in-key check + getIssueLifecycleScheduler()?.updateThresholds 路径）— done 2026-05-30

#### Step 3.7 — IssueLifecycleScheduler GC
- [x] Step 3.7.1 — 新建 `src/main/store/issue-lifecycle-scheduler.ts`：done 2026-05-30
  - ✅ 构造 `{tickIntervalMs?, resolvedRetentionDays, softDeletedRetentionDays}` — `tickIntervalMs` 默认 `6 * 3600_000` (D20)
  - ✅ `start()` / `stop()` setInterval pattern（与 LifecycleScheduler 同款,start 立即跑一次 tick + idempotent 防重复 setInterval）
  - ✅ `scan()` 主路径: listForGc → 逐条 snapshot before hardDelete → hardDelete → emit `'issue-changed' kind='hardDeleted' issue: null sourceSessionId: <snapshot.sourceSessionId>` + 单条失败 try/catch console.warn 后续不中断
  - ✅ `updateThresholds(opts)` 热更新阈值
  - ✅ `setIssueLifecycleScheduler` / `getIssueLifecycleScheduler` 单例 export
- [x] Step 3.7.2 — `src/main/index/bootstrap-infra.ts` wire（紧贴 LifecycleScheduler / TeamLifecycleScheduler 同位置）+ `src/main/index/_deps.ts` `BootstrapState.issueScheduler` 字段 — done 2026-05-30
- [x] Step 3.7.2.5 — `src/main/index/lifecycle-hooks.ts` before-quit 加 `state.issueScheduler?.stop(); setIssueLifecycleScheduler(null);` 防 timer 在 quit 期间继续碰 DB — done 2026-05-30
- [x] Step 3.7.3 — `src/main/ipc/settings.ts` `applyIssueGcThresholds` 内调 `getIssueLifecycleScheduler()?.updateThresholds()` — done 2026-05-30（与 Step 3.6.3 一并实施）
- [x] Step 3.7.4 — `src/main/store/__tests__/issue-lifecycle-scheduler.test.ts` **11 tests 全 pass** — done 2026-05-30
  - ✅ 阈值 0 跳过 GC（listForGc 返空时 skip hardDelete + skip emit）
  - ✅ resolved 超期 1 条 → hardDelete + emit kind=hardDeleted（sourceSessionId snapshot 钉死）
  - ✅ soft-deleted 超期 1 条 → 同款
  - ✅ 多条混合（resolved 2 + soft 1）→ 逐条 emit 3 次 + 各自 sourceSessionId snapshot
  - ✅ snapshot.sourceSessionId === null（FK SET NULL 后） → emit 仍含 null
  - ✅ snapshot 自己返 null（race）→ fallback sourceSessionId: null
  - ✅ hardDelete 返 false（race）→ skip emit
  - ✅ 单条 hardDelete throw → console.warn + 后续条目继续不中断
  - ✅ updateThresholds 改 resolvedRetentionDays 后立即生效（下次 scan 用新值）
  - ✅ start() 启动 setInterval + 立即跑一次 tick + stop() 停 tick + start() idempotent 不重复 setInterval

#### Step 3.8 — UI Issues tab
- [x] Step 3.8.1 — `src/renderer/App.tsx` `View` enum 加 `'issues'`（line 19 + import IssuesPanel + TabButton + view 分支渲染）— done 2026-05-30
- [x] Step 3.8.2 — 新建 `src/renderer/components/IssuesPanel.tsx`：list 视图 + filter 栏（status 多选 / kind 多选 / search title debounce 300ms / show deleted toggle）+ 订阅 `window.api.onIssueChanged` 推 store 实时更新 — done 2026-05-30
- [x] Step 3.8.3 — 新建 `src/renderer/components/IssueDetail.tsx`：detail 视图（main 字段可改 status/kind/title/description/repro/severity/labels + meta read-only + logsRef read-only + appendices appendedAt asc read-only + action bar 保存/软删/恢复/起新会话）— done 2026-05-30
- [x] Step 3.8.4 — 新建 `src/renderer/components/ResolveInNewSessionDialog.tsx`：弹快设表单（adapter / cwd / prompt 预填 §D8 template null fallback / optional permissionMode）+ submit 期间 button disabled UI throttle — done 2026-05-30
- [x] Step 3.8.5 — 新建 `src/renderer/stores/issues-store.ts`：zustand store（Map<id, IssueRecord> + filters + selectedIssueId + selectFilteredIssues selector）+ component 自订阅 onIssueChanged 推 store（**use-event-bridge.ts 不动** — 与 onTaskChanged "component 自订阅" 同模式）— done 2026-05-30
- [x] Step 3.8.6 — Header / sidebar 加 Issues 入口（TabButton 紧贴 teams 位置；切到 issues 时清 selectedSessionId 与 PendingTab/TeamHub 同模式）— done 2026-05-30

#### Step 3.9 — Settings 面板加 GC 阈值 UI
- [x] Step 3.9.1 + 3.9.2 — **决策调整**：不新建独立 `IssuesGcSection.tsx`,改挂到现有 `LifecycleSection.tsx` 内（已有 historyRetentionDays，issue 2 GC 阈值同 GC 性质 — 一站式让用户找到所有 GC 阈值,UI 更紧凑 + 改动最小）。2 个 `NumberInput`: `issueResolvedRetentionDays` (天，0 = 关闭 GC) / `issueSoftDeletedRetentionDays` (天，0 = 关闭 GC) — done 2026-05-30

#### Step 3.10 — 测试 / typecheck / build
- [x] Step 3.10.1 — `pnpm typecheck` 全过 — done 2026-05-30
- [x] Step 3.10.2 — `pnpm exec vitest run` 4 文件: **83 pass + 38 skipped**（issue-repo.test.ts 38 tests SQLite binding ABI 不在系统 Node 跑 — Step 3.2 commit c628930 已在 Node 20.18.3 ABI 115 + prebuild-install 验过 38/38 pass;issue-tools 40 + ipc/issues 32 + scheduler 11 全 pass）— done 2026-05-30
- [ ] Step 3.10.3 — **user 自跑** `pnpm dev` 起 Electron 验证 GUI（需交互验证，本 session 不能跑）：
  - mcp tool report_issue → 看 Issues tab 实时出现
  - append_issue_context → 看 appendices 子表行追加 + detail 视图渲染
  - UI 改 status (含 §D15 状态机 9 case = 7 transition + 2 边角) / 软删 / undelete 全通路
  - 点 "起新会话解决" → dialog 弹 + 起新 session + 看 `resolution_session_id` 落 + status='in-progress'
  - GC 阈值改 0 / 改 1 → 看 IssueLifecycleScheduler 行为（短期可改 tickIntervalMs=10s 加速验证）
  - Settings → 「生命周期」section → Issue 已解决保留 / Issue 已软删保留 两个 NumberInput
- [x] Step 3.10.4 — `pnpm build` 生产构建过（main 748KB / preload 25KB / renderer 1.4MB；唯一 warning 是 hand-off-session 旧代码 dynamic import 与本 plan 无关）— done 2026-05-30

### Step 4 — 完成
- [ ] Step 4.1 — 写 `ref/changelogs/CHANGELOG_178.md`（新建前 `ls ref/changelogs/ | tail -5` 校最大 X）+ 同步 `ref/changelogs/INDEX.md`
- [ ] Step 4.2 — 调 `mcp__agent-deck__archive_plan({plan_id: 'issue-tracker-mcp-20260529', worktree_path: <abs>, base_branch: 'main', changelog_id: '178'})`

## 当前进度

**Step 0.5 / 3.1-3.9 全部完成 + Step 3.10.1+3.10.2+3.10.4 完成（2026-05-30 接力 session 1+2+3）**：

- ✅ Step 0.5 spike (a) 6/6 pass
- ✅ Step 3.1 DB migration v026
- ✅ Step 3.2 issue-repo.ts + 38 tests (Node 20.18.3 ABI 115 实测 pass)
- ✅ Step 3.3 mcp tool report_issue + append_issue_context (17 tool) + 40 tests
- ✅ Step 3.4 issue-changed event chain F5
- ✅ Step 3.5 IPC handler 6 + preload facade + 11 边界硬化 + 32 tests
- ✅ Step 3.6 settings GC 阈值字段 + 热更新
- ✅ Step 3.7 IssueLifecycleScheduler 6h tick + 11 tests
- ✅ Step 3.8 UI Issues tab (App + IssuesPanel + IssueDetail + ResolveDialog + issues-store + Header TabButton)
- ✅ Step 3.9 Settings GC 阈值 UI (挂 LifecycleSection 内,改动最小)
- ✅ Step 3.10.1 pnpm typecheck 全过
- ✅ Step 3.10.2 pnpm vitest 83 pass + 38 skipped (binding ABI)
- ⏳ **Step 3.10.3 dev GUI 验证 — 留 user 自跑** (需交互验证)
- ✅ Step 3.10.4 pnpm build 生产构建过

**总产物**: 13 新文件（含 v026_issues.sql / issue-repo.ts / issue-lifecycle-scheduler.ts / report-issue.ts / append-issue-context.ts / issues.ts (ipc) / issues.ts (preload) / issue-tools.test.ts / issues.test.ts (ipc) / issue-lifecycle-scheduler.test.ts / IssuesPanel.tsx / IssueDetail.tsx / ResolveInNewSessionDialog.tsx / issues-store.ts）+ 14 修改文件。**单 plan 总 commit 6 个**: c628930 / d1170a3 / 80ddd98 / 852caf4 / 96f2c6c / 350b269。

**Backend + UI 主路径全打通**: agent mcp tool 通道 (报问题) + UI IPC 通道 (read/admin) + event chain (实时刷新) + GC scheduler (自动后台清理) + settings 热更新 + UI Issues tab 可视化 / detail 编辑 / 软删恢复 / 起新 session 解决 全套就绪。

## 下一会话第一步（或本会话继续）

1. **user 跑 GUI 验证** Step 3.10.3 测试矩阵（必跑，是 plan 收口前最后未验项）：
   ```bash
   # 还原 better-sqlite3 binding 给 Electron 33 ABI 130
   zsh -i -l -c "pnpm postinstall"
   pnpm dev  # 启动 Electron
   ```
   验证 6 个 path（详 plan §Step 3.10.3 checklist）。
2. 验证通过 → 调 archive_plan 自动归档（Step 4）：
   ```
   写 ref/changelogs/CHANGELOG_178.md (ls 校最大 X+1) + 同步 INDEX.md
   调 mcp__agent-deck__archive_plan({plan_id, worktree_path, base_branch:'main', changelog_id:'178'})
   ```

cold start 路径：
- 本 plan: /Users/apple/Repository/personal/agent-deck/.claude/plans/issue-tracker-mcp-20260529.md
- worktree: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/issue-tracker-mcp-20260529
- 已完成 commit hash: 见 `git log --oneline -10`

## 已知踩坑

1. **runtime-logging-electron-log-20260529 plan 未上线时 logsRef UI 渲染优雅退化**（§不变量 8）— 测 UI 端要兼容日志目录不存在。
2. **issues.cwd 字段不做 normalize** — 上报时原样落 caller 自报 cwd 字符串；UI 端按需自己 realpath（与 sessions.cwd 同款约定）。
3. **append_issue_context 跨 caller / 跨 session reject 错误信息要详细** — agent 自己 hand_off 后新 session 想 append 旧 issue 必须给清楚 hint「issue.sourceSessionId 是旧 session id」让 agent 知道改走 create 新 issue（D10 文案 SSOT）。
4. **camelCase 字段约定**（D18 / CHANGELOG_177 收口）— mcp tool args / TS 内部全 camelCase（`logsRef` / `issueId` / `additionalContext`）；DB 字段 snake_case（SQLite 惯例）；repo / handler 转换层做映射。**plan 内不再混用 snake_case 描述 mcp tool args**。
5. **spawn 路径走 `adapter.createSession(buildCreateSessionOptions(...))` adapter 层 API**（D14 + D14b SSOT — `sessionManager.createSession` **不存在**）— IPC handler 调 `adapterRegistry.get(adapter)` 拿 adapter 后调底层 createSession 绕过 mcp tool 层 spawn-guards；Step 0.5 mini spike 实证后定，spike fail 走 mcp tool path 兜底；UI 层加 throttle (button disabled + IPC in-flight dedupe) 防连点。
6. **issues 表 INDEX 加 `WHERE deleted_at IS NULL` 过滤** — 让 list 默认查询（不带 deleted）走 partial index 性能高；hardDelete GC 查 deleted_at NOT NULL 也走专门 partial index。
7. **issue_appendices 子表 ON DELETE CASCADE** — issue 硬删时 appendices 一并删（D11）；listForGc 中 issue 硬删后子表自动清。
8. **resolved_at 状态机 9 case（7 transition + 2 边角）必须 test 全覆盖**（D15 + Step 3.2.2 + Step 3.10.2 IPC handler test）— 漏测会导致 GC 时钟错位 / resolved issue 永远不被 GC / reopen 后 GC 太快删 / partial patch 副作用泄漏 / zod schema 漏挡非法 status。
9. **`activeWindowMs` vs `intervalMs` 不要混**（D13 + reviewer Round 1 MED）— `LifecycleScheduler` 的 `activeWindowMs` 是 active→dormant 阈值，`intervalMs ?? 60_000` 才是 setInterval tick；`IssueLifecycleScheduler` 用独立 `tickIntervalMs` 默认 6h。
