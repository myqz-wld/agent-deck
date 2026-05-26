# CHANGELOG_92: start_next_session mcp tool 实现 + 文档同步（K2 hand-off 自动化）

**plan**: mcp-bug-and-feature-batch-20260513 Phase 4b Step 4b.1-4b.6（K2 实现 + 文档同步收口一文）

## 概要

完成 K2「start_next_session mcp tool」—— `~/.claude/CLAUDE.md` §Step 3 接力姿势 §选项 B 的自动化 backend：lead 调一次 mcp tool 自动起新 SDK session 接力下一 phase（plan-aware spawn_session 包装），免去用户手动新开会话 + 复制 cold start prompt：

- **mcp tool 实现**（deps inject 模式与 archive_plan 同款双层架构）：
  - `types.ts`：`AGENT_DECK_TOOL_NAMES` 9→10 tool 加 `startNextSession`，`EXTERNAL_CALLER_ALLOWED` 加 `start_next_session: false`（同 spawn / archive_plan，避免外部 client 起 SDK session 的 fork bomb）
  - `tools/schemas.ts`：`START_NEXT_SESSION_SCHEMA` 8 字段（plan_id 必填 + phase_label/cwd/adapter/team_name/permission_mode/plan_file_path/caller_session_id 可选 + parent_session_id）
  - `tools/handlers/start-next-session-impl.ts`（~190 LOC）：纯 deps inject impl 层做 plan 文件路径解析 + frontmatter parse + status 校验 + cold start prompt 构造（含 phase_label 后缀），返回 resolved 上下文
  - `tools/handlers/start-next-session.ts`（~95 LOC）：handler 入口做 deny external + caller 反查 + 调 impl + 调 spawnSessionHandler 完成实际 spawn + 透传 K2 metadata + 透传 spawn 字段
  - `tools/index.ts`：9→10 tool 注册，annotation 里完整描述 K2 自动化行为 + 默认值（cwd=worktree_path / adapter=claude-code / team_name=plan_id / 文件路径 fallback 链）
- **22 it 单测**：impl happy path（caller cwd 反查 main-repo / phase_label / 默认 fallback 链 / 显式 override / git 失败 fallback / git common dir 相对路径） + 校验失败分支（plan 文件不存在 / 无 frontmatter / 缺 worktree_path / 非绝对 worktree_path / status completed/abandoned/missing） + base_branch 透传 / handler deny external + happy path 透传 + impl 错误不调 spawn + spawn 错误透传不嵌套包装
- **文档同步**：
  - `~/.claude/CLAUDE.md` §Step 3 接力姿势节拆「§选项 A 用户手动 cold start prompt」+「§选项 B K2 mcp tool 自动起新会话」双姿势，agent 在 mcp 可用时优先 §B
  - `resources/claude-config/CLAUDE.md` §Agent Deck Universal Team Backend 节首句「9 tool」改「10 tool」+ tool list 加 `start_next_session`；新增 §plan hand-off 自动化：start_next_session 节，含完整 ts 调用模板 + 业务流程概述 + 预检失败 reject 行为说明 + 「新 session system prompt 必须含 user CLAUDE.md」校警

合 1 commit（实现 + 文档同步），typecheck 双端通过 + 全 vitest 25 文件 380 it 通过（含 22 新 start-next-session）。

## 变更内容

### A. mcp tool 实现

#### A1. `src/main/agent-deck-mcp/types.ts`

- `AGENT_DECK_TOOL_NAMES.startNextSession = 'start_next_session'`（10 tool 集合 + 头注释加 plan §Phase 4b reference）
- `EXTERNAL_CALLER_ALLOWED.start_next_session = false`（与 spawn_session / archive_plan 同档：起 SDK session 的 fork bomb 风险绝不允许 stdio external client 调用）

#### A2. `src/main/agent-deck-mcp/tools/schemas.ts`

`START_NEXT_SESSION_SCHEMA` 字段设计：
- `plan_id`（必填，charset `[A-Za-z0-9._-]` 与 EnterWorktree 同款）
- `phase_label`（可选 ≤80 chars，含值时附 prompt 后缀「（Phase: <label>）」）
- `cwd`（可选绝对路径，默认 plan frontmatter `worktree_path`）
- `adapter`（默认 `claude-code`，与 spawn_session 4 选项一致）
- `team_name`（可选，默认 `plan_id`）
- `permission_mode`（可选透传 spawn_session）
- `plan_file_path`（可选 override，与 archive_plan 同款 fallback 行为）
- `caller_session_id` / `parent_session_id`（透传 spawn_session）

加 `StartNextSessionArgs` z.infer type 与其他 args 类型平级。

#### A3. `src/main/agent-deck-mcp/tools/handlers/start-next-session-impl.ts`（新增 ~190 LOC）

deps inject 模式（与 archive-plan-impl 同款），5 步业务流程：

1. **plan 文件路径解析**：显式 `planFilePathOverride` > caller cwd 反查 main-repo 路径（git rev-parse --git-common-dir，failed 时跳过此层）→ `<main-repo>/.claude/plans/<plan_id>.md` > `~/.claude/plans/<plan_id>.md`，hint 区分 git 失败的兜底说明
2. **读 plan + parseFrontmatter**：用 `@main/utils/frontmatter` 已抽 helper（与 archive-plan 共享）
3. **校验 worktree_path 字段**：缺失或非绝对路径 reject
4. **校验 status === 'in_progress'**：completed / abandoned / missing 各自带不同 hint（已归档 / 中止 plan / 加 in_progress）
5. **构造 cold-start prompt**：基础形式 `按 <plan-abs-path> 接力`，phase_label 含值时附 `（Phase: <label>）` 后缀

返回 `StartNextSessionResolved` { planFilePath / worktreePath / coldStartPrompt / baseBranch }，error 走 `StartNextSessionError`（与 archive-plan 同款 union）。`_isStartNextSessionError` test helper export。

#### A4. `src/main/agent-deck-mcp/tools/handlers/start-next-session.ts`（新增 ~95 LOC）

handler 入口：
1. `denyExternalIfNotAllowed('start_next_session', caller)` → `validateExternalCaller(caller)`
2. 调 `startNextSessionImpl({ planId, phaseLabel, planFilePathOverride }, handlerDeps?.implDeps)` 拿 resolved
3. 组装 `SpawnSessionArgs`：cwd 默认 `resolved.worktreePath` / team_name 默认 plan_id / adapter 默认 claude-code / prompt = `resolved.coldStartPrompt`
4. 调 `spawnSessionHandler(spawnArgs, ctx)`（透传同一 ctx 让 caller 视角一致 → spawn 链路里的 spawn-link / lead 加入 / placeholder enqueue 全部按 caller 正确归属）
5. spawn isError → 直接透传不二次包装（避免「start_next_session error: spawn error: ...」嵌套）
6. spawn ok → JSON.parse content[0].text 拿 spawn 字段 → 包 K2 metadata（planId / planFilePath / worktreePath / baseBranch / phaseLabel / initialPrompt） + 透传 spawn 字段 → 返回 ok

`StartNextSessionHandlerDeps` 测试 inject seam（spawnSession + implDeps）让单测 mock spawn 不真起 SDK session。

#### A5. `src/main/agent-deck-mcp/tools/index.ts`

9→10 tool 注册，加 `startNextSession` 工具定义（annotation 详细描述 K2 自动化行为 + 默认值 + plan 文件路径 fallback 链 + 返回字段全集）。`return [...]` array 加 `startNextSession` 末尾。

### B. 单测（22 it 全过）

`src/main/agent-deck-mcp/__tests__/start-next-session.test.ts`（新增 ~440 LOC，与 archive-plan.test.ts 同款 in-memory deps fixture）：

- **impl happy path（6 it）**：caller cwd 反查 main-repo → main-repo/.claude/plans/ 命中 / phase_label 注入 prompt 后缀 / git 失败 → fallback ~/.claude/plans/ / main-repo 反查成功但 main-repo/.claude/plans/ 不存在 → fallback ~/.claude/plans/ / 显式 plan_file_path override / git rev-parse 返回相对路径 → resolve 成绝对
- **impl 校验失败分支（8 it）**：plan 文件默认两层都不存在 / git 失败时只走 user-global / 显式 override 不存在 / 无 frontmatter / 缺 worktree_path / 非绝对 worktree_path / status completed/abandoned/missing
- **impl base_branch 透传（2 it）**：含 / 不含 base_branch frontmatter
- **handler deny external（1 it）**：caller_session_id = `__external__` + transport=stdio → 拒绝
- **handler happy path with mock spawn（4 it）**：调 spawn handler + 透传 K2 metadata + spawn 字段（含 phase_label 注入 prompt）/ caller 显式 cwd / team_name 覆盖默认 / spawn 错误透传不嵌套 / impl 错误不调 spawn

### C. 文档同步

#### C1. `~/.claude/CLAUDE.md` §Step 3 接力姿势

- 原结构：单一「Cold start prompt（一句话接力）」节
- 新结构：拆 §选项 A 用户手动 cold start prompt（保留原内容 + cold start 5 步必做 + Bash cat callout） + §选项 B mcp tool 自动起新会话（K2，新增）
- §选项 B 内容：完整 K2 调用模板（plan_id / phase_label / 其他默认）+ 自动行为概述（4 条）+ 返回字段 + 适用 / 不适用场景 + 「新 session system prompt 必须含 user CLAUDE.md 复杂 plan 节」校警

> **注**：本文件改动在用户全局 home（~/.claude/），不在 worktree branch 内，本 commit 不带；改动是 in-place 的（agent 即时受益，但跨设备同步需用户手动）

#### C2. `resources/claude-config/CLAUDE.md`（应用打包注入，入 commit）

- §Agent Deck Universal Team Backend 节首句「9 tool」→「10 tool」+ tool list 加 `start_next_session`
- 新增 §plan hand-off 自动化：start_next_session 节，与 §plan hand-off 自动化：archive_plan 节平级
- 内容：完整 ts 调用模板（含 8 字段 args + 13 字段返回结构）+ 业务流程概述（解析 plan 路径 / 读 frontmatter / 校验 status / 构造 prompt / 调 spawn / 加 team） + 预检失败 reject 短路 + 「新 session system prompt 必须含 user CLAUDE.md」校警

## 不变量

- spawn_session 行为不变（K2 是 plan-aware 包装层，所有 spawn 防御链 / permission_mode 继承 / sandbox 继承 / placeholder enqueue / team ensure / addMember 全部走原 spawnSessionHandler）
- archive_plan 行为不变（K1 + K2 各自独立 mcp tool，文件路径 fallback 逻辑相似但实现独立）
- caller 视角一致：透传同一 ctx 给 spawnSessionHandler，spawn-link / team lead 加入按 caller 正确归属
- ~/.claude/CLAUDE.md 改动 in-place 不入 commit；resources/claude-config/CLAUDE.md 改动入 commit 应用 build 后注入新会话 system prompt 即时生效

## 验证

- `pnpm typecheck` 双端通过
- `pnpm exec vitest run` — 25 文件 380 it 全过（含 22 新 start-next-session + 11 archive-plan + 8 spawn-guards + 44 tools）
- 手动 review：~/.claude/CLAUDE.md §Step 3 §选项 B 与 resources/claude-config/CLAUDE.md §plan hand-off 自动化：start_next_session 双向一致
- dev smoke（Phase 6 收口时）：用 K2 tool 真起一个新 SDK session 接 plan 下一 phase（典型场景：H3 调 K2 起 H4，H4 完成后再调 K1 archive_plan 自验闭环）

## H2/H3 backlog 推进状态

完成本 phase 后剩：
- ✅ J bug + B check_reply（CHANGELOG_87 / Phase 1）
- ✅ C MED-D7 / E LOW / G MED-A7 / H HIGH-B2（CHANGELOG_88 / Phase 2）
- ✅ I `#sdkOwned` 真私有（CHANGELOG_89 / Phase 3）
- ✅ N bug：归档会话续聊自动 unarchive（CHANGELOG_90 / Phase 1.5 新增）
- ✅ K1 archive_plan mcp tool 实现（commit `81a15d8` / Phase 4a Step 1-5）
- ✅ K1 文档同步（CHANGELOG_91 / Phase 4a Step 6-9）
- ✅ K2 start_next_session mcp tool 实现 + 文档同步（本 CHANGELOG_92 / Phase 4b Step 1-6）
- ⏳ K3 UI hand off 按钮 + LLM 总结 — Phase 4c（H3+H4）
- ⏳ A HIGH 10 cross-session UI + L 卡片增强 + M 透明置顶解耦 — Phase 5
- ⏳ Phase 6 收口（typecheck + build + dev smoke + worktree merge + plan 归档；plan 归档可走 K1 自验）
