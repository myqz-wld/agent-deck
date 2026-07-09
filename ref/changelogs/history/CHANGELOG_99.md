# CHANGELOG_99 — cwd 失效根治:K2 default mainRepo + 双模式 + archive caller + recoverer 启发式 fallback + tool rename hand_off_session

## 概要

**根治用户报"会话发消息撞 `Path "..." does not exist` 弯绕错误链"**(典型场景:K2 baton 起的 session cwd=worktree, worktree 被 archive_plan 删后 sessionRepo.cwd 失效)。三层修法互补:K2 改 default cwd 让新 session 沿用 EnterWorktree 模式不变量(sessionRepo.cwd = main repo);archive_plan 默认归档 caller 与 K2 baton 同款语义;recoverer 加 cwd 启发式 fallback 兜底历史会话 + 边角场景。**附加**: K2 双模式改造(plan-driven / generic)让任意会话不带 plan 也能 baton 给新 session;tool rename `start_next_session` → `hand_off_session` 与现有 hand-off 术语对齐。

R1 双异构对抗 reviewer 5 MED + 4 LOW 全修(b213d61), R2 双 reviewer 0 finding 可合(R3 收口)。Plan 文件归档:`plans/cwd-resilience-fix-20260514.md`。

## 变更内容

### 代码改动

#### Phase A — K2 (`hand_off_session`) cwd 失效根治 + tool rename (commit `bdbaace`)

- **`src/main/agent-deck-mcp/tools/handlers/start-next-session-impl.ts`** (renamed → `hand-off-session-impl.ts`):
  - `StartNextSessionResolved` (renamed → `HandOffSessionResolved`) 加 `mainRepo: string | null` 字段
  - 主流程开头单次 `git rev-parse --git-common-dir` 反查 caller cwd → mainRepo;失败时启发式反推 worktreePath (`<X>/.claude/worktrees/<plan-id>` → 取 X) 双层 fallback
- **`src/main/agent-deck-mcp/tools/handlers/start-next-session.ts`** (renamed → `hand-off-session.ts`) handler:
  - 默认 cwd: `args.cwd ?? resolved.mainRepo ?? resolved.worktreePath` 双层 fallback
- **Tool rename** `start_next_session` → `hand_off_session` (用户反馈,与现有 hand-off 术语对齐):
  - 3 文件 git mv: `start-next-session{,-impl,.test}.ts` → `hand-off-session{,-impl,.test}.ts`
  - `AGENT_DECK_TOOL_NAMES.startNextSession` → `handOffSession` (value `'hand_off_session'`)
  - 所有 export name 同步 (HandOffSession{Handler,Impl,Args,Resolved,Error,Deps,Input,HandlerDeps} / `HAND_OFF_SESSION_SCHEMA` / `_isHandOffSessionError`)
  - `EXTERNAL_CALLER_ALLOWED.start_next_session` → `hand_off_session`

#### Phase A′ — 双模式改造 (commit `1b21f6c`)

用户反馈"hand-off mcp 应当更通用,不一定要 worktree + plan 前提才能用"。方案 B:plan_id 变 optional + 加 prompt 字段 + impl 双模式分流。

- **schema 层**:`HAND_OFF_SESSION_SCHEMA.plan_id` 加 `.optional()` + 新增 `prompt: z.string().optional()` 字段
- **impl 双模式**(`hand-off-session-impl.ts`):
  - 输入接口 `HandOffSessionInput` 加 `prompt?: string`,`planId` 变 optional
  - 输出接口 `HandOffSessionResolved` 加 `mode: 'plan' | 'generic'` + `ignoredFields: string[]`;plan-only 字段 (`planFilePath / worktreePath / baseBranch`) 在 generic 模式下为 `null`
  - 主流程:无 `plan_id` 早返回 generic 分支(不读 plan;`coldStartPrompt = input.prompt ?? '从上一个会话接力继续工作'`;phase_label / planFilePathOverride 在 generic 下被忽略 + 记 `ignoredFields`);有 `plan_id` 走原 plan-driven 6 步
- **handler 双模式 default cwd**(`hand-off-session.ts`):
  - plan-driven 模式 default: `args.cwd > resolved.mainRepo > resolved.worktreePath`
  - generic 模式 default: `args.cwd > callerSessionRow.cwd (existsSync precheck) > resolved.mainRepo`
  - ok return 加 `mode` / `ignoredFields` 字段

#### Phase B — archive_plan default 归档 caller (commit `aa6575a`)

`archive_plan` 完成 git ff merge / mv plan / commit / git worktree remove 后默认归档 caller(K2 baton 同款语义)。plan 收口 = caller session 使命终结(worktree 已删 + cwd 已失效)。

- **`archive-plan.ts` handler**:复制 K2 hand-off-session.ts L194-216 模式
  - 反查 callerSessionRow (try/catch DB 不可用 fail-safe)
  - external sentinel → `'skipped'` (双保险)
  - row missing → `'failed'` + console.warn 不阻塞
  - archive 抛错 → `'failed'` + console.warn 不阻塞
  - 成功 → `'ok'`
  - 加 `ArchivePlanHandlerDeps.archiveSession` test seam
  - ok return 加 `archived: 'ok' | 'failed' | 'skipped'`
- **schemas.ts / tools/index.ts archive_plan description**:同步加 default 归档 caller 说明 + archived 字段

#### Phase C — recoverer cwd 启发式 fallback (commit `aadd3d2`)

兜住 Phase A 根治覆盖不到的场景:老 K2 session(cwd=worktree 已存在 DB)、用户手动 NewSessionDialog 选 worktree 当 cwd、用户手动 `git worktree remove` 不走 archive_plan、误删 / 跨设备同步丢目录。

- **`src/main/adapters/claude-code/sdk-bridge/recoverer.ts`**:
  - 加 `CwdExistsThunk` type + `defaultCwdExists` export (test seam)
  - SessionRecoverer constructor 加 `cwdExistsThunk` 第 5 参
  - `recoverAndSend` 主流程加 cwd precheck + `effectiveCwd` 替代 `rec.cwd`
  - 加 `findFallbackCwd` protected method:
    - 启发式 1:路径含 `/.claude/worktrees/<x>` 段 → 取段之前部分(K2 老 session 模式)
    - 启发式 2:父目录 walk 找第一个还存在的目录(安全边界:不超过 home)
  - `cwdFellBack=true` 时强制走 jsonl missing fallback 路径(绕过 jsonl precheck;走 createThunk 不带 resume + 后置 renameSdkSession,CLI 历史失但应用层 events / file_changes / summaries 子表保留)
  - 找到 fallback → emit info message(不打 error)告诉用户 fallback 用了哪个目录
  - 找不到 fallback → emit error message + throw,**不**emit「正在自动恢复」placeholder(误导)
- **`sdk-bridge/index.ts`**:
  - import `defaultCwdExists`
  - SessionRecoverer constructor 加第 5 参 `(cwd) => this.cwdExists(cwd)`
  - 加 `cwdExists` protected wrapper(同 `resumeJsonlExists` 模式)

#### Phase D — 4 处文档同步 (commit `db7c893`)

- **`resources/claude-config/CLAUDE.md`** (app):10-tool 列表 + `§plan hand-off 自动化` 整段改名 + 拆 plan-driven / generic 双模式两段说明 + 新加 `§archive_plan 默认归档 caller` 节 + 新加 `§recoverer cwd 启发式 fallback` 节
- **`resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md`**:救火 4-5 个 tool 列表改名
- **`docs/agent-deck-mcp-protocol.md`** (stub):2 处 SSOT 路径表引用
- **`~/.claude/CLAUDE.md`** (user, home 路径不在 worktree):`§Step 2.5` + `§Step 3 选项 B` 整段同步改名 + 加 generic 模式调用示例 + cwd default 改 mainRepo + EnterWorktree 流程说明

#### Phase E — 双异构对抗 reviewer R1+R2 review (commit `b213d61`)

R1 双 reviewer 对抗 5 MED + 4 LOW(reviewer-claude 0 HIGH/1 MED/2 LOW/2 INFO + reviewer-codex 1 HIGH/4 MED/2 LOW/1 INFO,部分共识部分单方独有,三态裁决修 9 项):

- **MED-1 sessionRepo.get 不对称**:`hand-off-session.ts` + `archive-plan.ts` `mergeCallerCwd → resolveCallerCwdDeps` 调 `sessionRepo.get` 没 try/catch,与后段 try/catch fail-safe 形成入口空门。修:两 handler 同款包 try/catch return {}。
- **MED-2 archived auto-unarchive 顺序**:cwd precheck 在 unarchive 之后 → fallback 失败 throw 时 session 已被错误 unarchive(用户体感"刚归档又被恢复又死路")。修:cwd precheck 移到 unarchive 之前。
- **MED-3 findFallbackCwd 启发式 1 regex 不命中 worktree 子目录**:caller cwd 在 worktree 内子目录(如 `/repo/.claude/worktrees/plan/src`)走 parent walk 命中 `.claude/worktrees` 不是 main repo。修:regex 改 `^(.+)\/\.claude\/worktrees\/[^/]+(?:\/.*)?$` 允许子目录命中。
- **MED-4 generic hand_off_session 把失效 caller cwd 传 spawn**:recoverer 只覆盖 sendMessage 不覆盖新 spawn。修:handler 加 `cwdExists` test seam (default `fs.existsSync`) + callerCwd existsSync precheck false → null fallback mainRepo。
- **MED-5 archive caller 复用早期 callerSessionRow race**:spawn 期间 row 被删 → archive 用旧探针 → UPDATE 对缺失 row 是 no-op 但仍报 `archived='ok'` 误报。修:archive 段重新 `sessionRepo.get` 拿 ground truth。
- **LOW-2 findFallbackCwd home 边界**:docstring 说"不超过 home" 但 `badCwd === home` 边角下 walk 走出 home 之上。修:边界改为 `home === p || home.startsWith(p + '/')`。
- **LOW-7 hand-off-session.ts:186 plan default cwd 注释错位**:写"caller cwd > mainRepo > worktreePath",实际 plan 模式不走 caller cwd。修:改注释。
- **LOW-8 sdk-bridge.test.ts cwd fallback 测试盲区**:没断言 `sessionManager.renameSdkSession`。修:加断言 + reset mock 在 beforeEach。
- **LOW-9 spawn-guards.ts:53 stale comment**:`start_next_session` → `hand_off_session`。

R2 双 reviewer 验证 fix:**0 finding 可合(R3 收口)** — `9 项 fix 全部对症 + 0 引新 bug + 254 test 全过 + typecheck 干净`(reviewer-claude + reviewer-codex 一致结论)。

#### Phase G2 — 3 处文档加 CHANGELOG_99 过渡期警告

发现 J fix 一刀切拦截 reply_message dispatch 设计缺陷(`universal-message-watcher.ts:450-454`):lead 给 teammate 发 `reply_message` 不触达,因为 J fix 拦了所有 `replyToMessageId != null` 的 message 不 dispatch。**短期绕过**:lead 改用 `send_message + reply_to_message_id` 显式传字段;teammate→lead 仍可用 `reply_message`(target=sender 路径正是 J fix 设计场景)。**完整修法**新 plan `mcp-tool-simplify-20260514` 完全删 `reply_message + wait_reply + check_reply + J fix`,统一 `send_message + adapter dispatch` 心智模型(10 → 7 tool)。

加 callout 到:
- `SKILL.md` 前提节
- `reviewer-claude.md` §核心纪律 第 9 条
- `reviewer-codex.md` §核心纪律 第 12 条

### 单测改动

- **`__tests__/hand-off-session.test.ts`**:rename + 8 新 generic 模式 case(impl 5 + handler 3) + 1 新 MED-4 case(R1 fix 配套);从 28 → 37 case 全过
- **`__tests__/archive-plan.test.ts`**:4 新 archive caller case(happy / row missing / archive 抛错 / impl 失败短路 不调 archive);从 13 → 17 case 全过
- **`__tests__/sdk-bridge.test.ts`**:4 新 cwd fallback case(启发式 1 命中 / parent walk / 全 miss / cwd 存在不触发) + `cwdExistsOverride: boolean | Map<string, boolean>` test seam + LOW-8 加 `renameSdkSession` 断言 + reset mock 在 beforeEach;从 7 → 11 case 全过

总 mcp / adapters / teams test:**259 全过**(原 ~232 + 27 新)。

### 文档归档

- 本 commit:`plans/cwd-resilience-fix-20260514.md`(自 `.claude/plans/` mv 到此,status: completed)
- 后续 plan: `plans/mcp-tool-simplify-20260514.md`(本 plan archive 后另起新会话执行)
