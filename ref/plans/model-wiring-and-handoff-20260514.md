---
plan_id: "model-wiring-and-handoff-20260514"
created_at: "2026-05-14"
status: "completed"
base_commit: "f253794"
base_branch: "main"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/model-wiring-and-handoff-20260514"
final_commit: "0d3cabb7c163233750541b42e9cf5579ab230179"
completed_at: "2026-05-14"
---
# Context

Agent Deck 当前 model 链路存在三处不闭环：

1. **agent frontmatter `model` 字段在 teammate spawn 路径下死字段**：reviewer-claude.md (`model: opus`) / reviewer-codex.md (`model: sonnet`) 的 frontmatter `model` 字段只对 Claude Code 原生 subagent 协议生效，agent-deck 自己的 spawn handler (`src/main/agent-deck-mcp/tools/handlers/spawn.ts:84-99`) 只把 body 拼成 prompt 头部，从不读 frontmatter，更不传给 SDK。结果是 reviewer teammate 实际跑的 model = lead 主模型（`ANTHROPIC_MODEL`），与 frontmatter 标的 opus/sonnet 无关。

2. **summarizer / hand-off model 选择只能通过 env 配，UI 无暴露**：`src/main/session/summarizer/llm-runners.ts` 写死 fallback 链 `ANTHROPIC_DEFAULT_HAIKU_MODEL → ANTHROPIC_MODEL → 'haiku'`（summarize）/ `ANTHROPIC_DEFAULT_SONNET_MODEL → ANTHROPIC_MODEL → 'sonnet'`（hand-off）。settings.json env 是用户唯一控制点，应用 settings UI 没有等价开关。

3. **codex session 的 hand-off 简报借用 claude SDK + sonnet**：`src/main/ipc/sessions.ts:70` 写死调 `summariseSessionForHandOff`，不论 session.adapter 是 claude 还是 codex 都走 claude SDK + sonnet 出 4 节简报。周期性 summarize 已经按 adapter 派发好了（`src/main/session/summarizer/index.ts:218-220`）— claude → claude SDK haiku、codex → codex SDK oneshot；但 hand-off 没做派发。

期望产出：

- **A**：spawn 时 parse agent body frontmatter 拿到 `model` 透传给 SDK，并写 sessionRepo 让 SDK resume / dormant 唤醒后保持模型一致
- **B**：settings UI 加 `summaryModel` + `handOffModel` 两个字符串字段，优先级 `settings 显式值 > env > alias 兜底`
- **C**：新增 codex hand-off runner，让 codex session hand-off 走 codex SDK 自己

# 设计决策（不再争论）

- **D1 frontmatter only**：spawn_session 不加 caller 显式 `model` 覆盖参数，frontmatter 是唯一来源。reviewer-{claude,codex}.md 已有 frontmatter，零改动即生效。
- **D2 写 sessionRepo**：spawn 后调 `sessionRepo.setModel(sid, model)` 持久化；recoverer / createSession resume 路径读出来透传 SDK，与现有 `permissionMode` / `claudeCodeSandbox` 同模式。新加 column 不影响旧 row（NULL 兼容）。
- **D3 settings 字符串字段（默认空）**：空 = 沿用现有 env / alias 链；非空 = 覆盖。零迁移成本、老用户无感。UI 加两个 text input。
- **D4 codex hand-off 走 codex SDK + 用 medium reasoning**：新增 `src/main/adapters/codex-cli/handoff-runner.ts`，镜像 `summarizer-runner.ts` 但 prompt 用 4 节结构化模板、`modelReasoningEffort: 'medium'`（high 太慢，low 结构化精度不够，medium 折中）。codex SDK startThread 不接受 model 参数（model 由 codex CLI 全局 config 决定），所以 settings.handOffModel **只对 claude session 生效**，UI label 注明。
- **D5 codex teammate spawn 不识别 frontmatter model**：codex SDK startThread API 不接受 model override（codex 自己 toml 全局值），spawn 给 codex teammate 设的 frontmatter `model` 没法落地。`spawn.handler` 检测到 `agent.model` 但 adapter='codex-cli' 时 `console.warn` 一行，**不报错**（reviewer-codex.md `model: sonnet` 这种现状不阻断 spawn）。
- **D6 兜底 alias 不变**：summarize 'haiku' / hand-off 'sonnet' 这两个写死的 SDK alias 兜底保留 — 万一用户 settings 和 env 都没配，至少不挂掉。

# 步骤 checklist

## Step 1 — DB migration + sessionRepo model column

- [x] Step 1.1 — 新建 `src/main/store/migrations/v018_sessions_model.sql`：`ALTER TABLE sessions ADD COLUMN model TEXT;`
- [x] Step 1.2 — `src/main/store/migrations/index.ts` MIGRATIONS 数组加 v018 入口
- [x] Step 1.3 — `src/main/store/session-repo/core-crud.ts` upsert 三处 + setModel setter；`src/main/store/session-repo/types.ts` Row + rowToRecord；`src/shared/types/session.ts` SessionRecord.model 字段

## Step 2 — Adapter 接口与 createSession 透传 model

- [x] Step 2.1 — `src/main/adapters/types.ts` `CreateSessionOptions.model?: string`
- [x] Step 2.2 — claude bridge createSession opts 加 model + 新建 `model-resolve.ts` + `session-finalize.ts` 加 setModel 持久化
- [x] Step 2.3 — `query-options-builder.ts` 透传 `...(model ? { model } : {})` 给 SDK
- [x] Step 2.4 — `recoverer.ts` CreateSessionThunk + 两条路径透传 `model: rec.model ?? undefined`
- [x] Step 2.5 — codex adapter setModel 持久化 + console.warn（runtime 不生效，D5）

## Step 3 — spawn handler 提取 frontmatter model

- [x] Step 3.1 — `spawn.ts` agent_name 分支 parseFrontmatter 提取 fm.model 传 createSession
- [x] Step 3.2 — codex-cli adapter + 非空 fm.model 时 console.warn（D5）
- [x] Step 3.3 — `schemas.ts` agent_name describe 补一句

## Step 4 — settings 加 summaryModel + handOffModel

- [x] Step 4.1 — `shared/types/settings.ts` AppSettings + DEFAULT_SETTINGS
- [x] Step 4.2 — `settings-store.ts` 用 electron-store DEFAULT_SETTINGS 自动包含，无需 allow-list 改动
- [x] Step 4.3 — `llm-runners.ts:summariseViaLlm` 优先级 settingsStore > env > alias
- [x] Step 4.4 — `llm-runners.ts:summariseSessionForHandOff` 同款
- [x] Step 4.5 — `SummarySection.tsx` 加 ModelInput 控件 + 两输入 + hint 注明只对 claude-code 生效

## Step 5 — codex hand-off runner

- [x] Step 5.1 — 新建 `adapters/codex-cli/handoff-runner.ts` `summariseCodexSessionForHandOff`（4 节模板 + reasoningEffort='medium' + 60s timeout）
- [x] Step 5.2 — `ipc/sessions.ts:70` 按 session.agentId 派发
- [x] Step 5.3 — claude bridge `summariseForHandOff` protected wrapper 不需改（codex 没 recoverer，wrapper 只 claude session 用）

## Step 6 — 验证

- [x] Step 6.1 — `pnpm typecheck` ✅
- [ ] Step 6.2 — 手动 e2e（dev mode 重启）由 lead 自行验证（A frontmatter model / B sessionRepo 持久化 / C settings UI / D codex hand-off）— **agent 不能在 plan mode 自动跑**
- [x] Step 6.3 — `pnpm test` ✅ 504 passed | 64 skipped（pre-existing skipped）
- [x] Step 6.4 — `hand-off.test.ts` 加 settings.handOffModel 覆盖 case ✅

# 当前进度

Step 1-6 全完成（除 Step 6.2 手动 e2e 由 lead 自验）。typecheck + 504 tests / 64 skipped 双端全过。准备 archive_plan 入项目 git。

# 下一会话第一步

无 — plan 已收口；CHANGELOG_109 引用归档已写。新会话起任务请按 user CLAUDE.md「复杂 plan」走新 plan 流程。

# 已知踩坑

- **wire prefix 参与变量**：spawn.ts 已有大量 wire prefix / lead context block 逻辑，新增 frontmatter parse 必须在 line 84 `let promptToUse = args.prompt;` 之后、line 142 `teammateDisplayName` 计算之前插入，避免污染下游 wire format 注入
- **sessionRepo upsert 三处同步**：core-crud.ts INSERT cols / UPDATE SET / param binding 必须同步加，漏一处都会让 SQLite 报 "column count mismatch" 或 silent NULL；migration 测试可对照 v013 改动 commit 看完整 surface
- **codex SDK startThread 不接受 model**：D5 已说明不阻断；UI label 必须注明「只对 claude-code session 生效」防误导
- **settingsStore.get 在 oneshot SDK 子进程内可调**：summariseViaLlm / summariseSessionForHandOff 都跑在 main 进程（不是 SDK 子进程），settingsStore 单例直接可用
