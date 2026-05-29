# CHANGELOG_177 — plan mcp-tool-camelcase-migration-20260529 完整归档 (32 字段 snake_case → camelCase **breaking change**)

## 概要

[plan `mcp-tool-camelcase-migration-20260529`](../plans/mcp-tool-camelcase-migration-20260529.md) 完整收口归档。**breaking change**:Agent Deck MCP 15 tool 的 32 unique 入参字段名从 snake_case 统一改 camelCase,与出参（已是 camelCase）+ JS / TS 圈主流入参出参全 camelCase 对齐。继承自 follow-up task `26181f20-a772-434d-9ee5-bc4fe768e432`(plan `deep-project-review-comprehensive-20260528` Phase 5.3 收口期间 user 反馈三轨道命名分歧)。

**净改动**:80 文件 +1579 / -1578 ≈ 0 LOC 净 churn(纯命名重命名零业务逻辑变更)。pnpm typecheck ✅ + pnpm build ✅ (main 711KB / preload 22KB / renderer 1.4MB)+ pnpm vitest 81 files passed / 991 tests passed (exit 0)。3 commit 实施(`5ff0d78` schemas+handlers+index/refine + `129379e` tests + `9b58c61` docs)。

**不变量守约** (plan §不变量 11 条):
- ✅ 不引依赖 — 仅 perl -0pi / sed POSIX ERE 完成命名替换,无新 codemod 依赖
- ✅ enum 值不动 — `'claude-code'` / `'codex-cli'` / `'workspace-write'` / `'read-only'` / `'clear-team'` / `'preserve-team'` / `'skip'` / `'keep'` / `'remove'` / `'null-personal'` 等 21 个 enum value 完全保留(降低 breaking 面;caller 端 string literal 心智已建立)
- ✅ breaking change 一次性 — 不做 snake_case alias 兼容,按 §提示词资产维护 约束 2「不写兼容/预测」
- ✅ schemas.ts L12-13 注释改写 — 「字段命名约定:tool args snake_case」→「camelCase(plan mcp-tool-camelcase-migration-20260529 改造)」
- ✅ handler 内部消费同步改 — `args.<snake>` → `args.<camelCase>` 全部更新（包括 handlers/* 190+ 处 + tools/index.ts:130-142 makeCtx 函数签名 + schemas.ts:646 refine 内 `args.adoptTeammates` / `args.teamName` 消费）
- ✅ 测试同步改 — 30 测试文件 input fixture 改 camelCase（audit 1a / 1b 必为空验证）
- ✅ 文档同步改 — 7 prompt asset (CLAUDE.md / CODEX_AGENTS.md / reviewer-{claude,codex}.md / deep-review SKILL.md / flow-arch-plantuml SKILL.md) mcp tool input field 描述改 camelCase + sync-codex-skills.mjs 同步 codex 端 deep-review SKILL
- ✅ 不破坏出参 — 出参字段保持原样（已是 camelCase）;仅入参改
- ✅ SQLite 列名 / mcp tool 函数名 / plan workflow frontmatter / owner_session_id 四类合法保留(详 §不变量 #11)

## 变更内容

### Step 0 RFC（2 轮对齐 design 大方向）

- **Round 1** 方案 A/B/C/D — user 选 A：全 camelCase 入参出参 + enum 保留 kebab-case（降低 enum 改动 caller 端 string literal 完全保留）
- **Round 2** codemod 方案 + spike 决策 + description prose 处理 — user 选混合方案（perl/sed + 手工 Edit + 白名单 audit）+ 不需 spike（32 字段简单 1:1 + nested 已 camelCase + typecheck/vitest 双保险足以捕获误伤）+ description prose 手工 Edit

### Step 0.5 spike（skip — RFC 决策不需）

简单 1:1 机械转换 + nested `hand_off` 已 camelCase + enum value 不动与字段名改 camelCase 独立无歧义边角 + typecheck/vitest 自动捕获误伤,不需 mini-runner spike 实测。

### Step 1 plan 文件细化 + Step 1.5 R1-R5 Deep-Review plan（5 轮多轮 review × fix）

按应用 CLAUDE.md §复杂 plan workflow §Step 1 模板写完整 plan,frontmatter / 总目标 / 11 不变量 / 设计决策表（4 条）+ §32 字段映射表 完整 SSOT（行号 reference + nested 验证）+ §sed pattern POSIX ERE 详细 spec（Pattern 1/2/3/4 + 黑名单排除策略）+ §SQLite 列名 / mcp tool 函数名 / plan frontmatter 三类误伤排除策略 + §测试 fixture 清单 30 文件 + §文档清单 7 文件 + §测试矩阵覆盖度 11 不变量 × test case 对照表 + 步骤行级 reference + §已知踩坑 10 条。

invoke `agent-deck:deep-review` SKILL kind='plan' 评审 plan。**5 轮共 49 finding fix 落地**:
- R1 16 finding fix (HIGH-A 字段映射表错算 51 → 32 unique + 加 hand_off / HIGH-B L12-13 注释 vs L23-25 错认 / HIGH-C 文档黑名单策略 / HIGH-D 测试范围 30 文件 / HIGH-E POSIX ERE 必须 / HIGH-F 覆盖范围扩展 index.ts/refine / MED-A 文档清单 7 文件 328 raw / MED-B description prose 86+ 处 / MED-C SQLite 列名误伤排除 / MED-D 测试矩阵覆盖度新增 / MED-E 合并 single green commit 等)
- R2 17 finding fix (C2-H1 perl -0pi 跨行 + sed 双 pattern 兜底 / L-H1+L-H3+L-H4 测试 fixture 改手工 Edit + 白名单 / C2-M2 sync-codex-skills SKIP_SKILLS / 等)
- R3 14 finding fix (C3-H1 ERE alternation `\|` → `|` / L-H1+L-H2 audit 1a/1b 前缀 cover / L-H3 index.ts 行号回滚 / L-M1 owner_session_id 注释 prose audit / L-M2 pkill Agent Deck Helper / L-M3 base_commit hardcode 去 / 等)
- R4 1 真 MED fix (C4-M1 audit 1b 新增 `const args:Type={}` 直接对象 fixture 形式)
- R5 2 真 MED fix (C5-M1 prefix-aware filter `grep -rInE | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*)'` / C5-M2 删 plan line 266 多余 fence)

**5 轮共识可合**:reviewer-claude R5 「0 HIGH/0 真 MED → 共识可合」+ reviewer-codex 最终轮 0 HIGH/0 真 MED。

### Step 2 EnterWorktree + Step 3 实施（3 commit single green commit 策略）

User 显式 confirm 后 `git worktree add -b worktree-mcp-tool-camelcase-migration-20260529` + EnterWorktree(path:) 避开 v2.1.112 stale base bug。3 commit 拆分（R1 fix MED-E 合并 Step 3.1+3.2 single green commit 避免中间 typecheck-fail commit）:

**commit `5ff0d78` Step 3.1+3.2 single green commit** — schemas + handlers + index/refine + description/source prose
- (a) schemas.ts 字段定义 32 字段 perl -0pi `s/^(\s*)<snake>(\s*:\s*z\b)/$1<camelCase>$2/gm`（跨行匹配 `field: z\n` 换行链式形式）
- (b) schemas.ts L12-13 注释改写「字段命名约定 snake_case」→「camelCase」
- (c) schemas.ts description prose 全替换（110 命中 → 20 残留全部 mcp 函数名 / owner_session_id 等合法保留）
- (d) handler `args.<snake>` ~190 处 perl POSIX ERE 替换（find -exec 处理 handlers/** + 单独处理 tools/index.ts + tools/schemas.ts）
- (e) tools/index.ts:130-142 makeCtx 函数签名 type `{caller_session_id?, parent_session_id?}` → `{callerSessionId?, parentSessionId?}`
- (f) schemas.ts:646 HAND_OFF_SESSION_ARGS_SCHEMA refine 内 `args.adopt_teammates === true && args.team_name !== undefined` → `args.adoptTeammates === true && args.teamName !== undefined`
- (g) source code prose（task-helpers.ts argsToInputWithoutOwner 局部 type / hand-off-session/handler-main.ts spawn args object key snake_case → camelCase / task-update.ts destructuring `const {task_id, ...rest}` → `const {taskId, ...rest}` / helpers.ts error message string `unknown caller_session_id` → `unknown callerSessionId` / etc.）
- (h) handler 手工映射代码（如 `args.replyToMessageId ?? null`）自动跟随

**commit `129379e` Step 3.3** — 测试 fixture + 余下 prose 字段同步
- 30 测试文件 32 字段 perl 批量替换（find -exec ...）
- src/main/agent-deck-mcp/{tools/helpers,mcp-session-token-map,transport-stdio,transport-http,spawn-guards,types,server}.ts 余下 prose 字段名提及（注释 / error message / JSDoc）批量替换 camelCase
- audit 1a `.handler({...})` 形式真 input fixture: 0 命中 ✓
- audit 1b `const args:Type={...}` 直接对象 fixture: 0 命中 ✓
- audit 2 注释 prose 不设守门（黑名单合法保留）

**commit `9b58c61` Step 3.4** — 7 文档 mcp tool input field 描述改 camelCase + codex mirror 同步
- CLAUDE.md / CODEX_AGENTS.md / reviewer-claude.md / reviewer-codex.md / deep-review SKILL.md / flow-arch-plantuml SKILL.md 全替换 camelCase
- 手工修回 plan frontmatter 黑名单上下文（CLAUDE.md 9 处 + CODEX_AGENTS.md 8 处）— 因 archive_plan / hand_off_session 按 snake_case key hardcode 解析 plan frontmatter
- `pnpm exec node scripts/sync-codex-skills.mjs` 同步 codex 端 deep-review SKILL（flow-arch-plantuml 在 SKIP_SKILLS 内不同步 — 仅 claude 端有）

### Step 3.5 build verify + 11 不变量测试矩阵 audit

- ✅ pnpm typecheck 0 errors（main + web tsconfig 各跑一次）
- ✅ pnpm build 全过（main 711KB / preload 22KB / renderer 1.4MB；唯一 warning 是无关本 plan 的 dynamic import）
- ✅ pnpm vitest run: 81 files passed / 991 tests passed / 159 skipped (SQLite binding skip 守门) / exit 0
- ✅ #1 不引依赖 audit: 0 命中
- ✅ #3 alias / backward compat audit: 0 命中
- ✅ #4 schemas.ts L12-13 注释 verify: 新 camelCase 命中 + 旧 snake_case 0 残留
- ✅ #5 运行时代码 args.<snake> audit (含 prefix-aware filter `grep -rInE 'args\.[a-z]+(_[a-z0-9]+)+' | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*)'`): 0 运行时残留
- ✅ #6 audit 1a + 1b: 0 命中
- ✅ #11 owner_session_id 注释 prose 仍命中 8 处（合法保留 — 仅注释 prose / SQL 描述，不在 zod input schema）
- ✅ #11 mcp tool 函数名命中 106 处（CLAUDE.md 51 + CODEX_AGENTS.md 55，合法保留 wire-level identifier `mcp__agent-deck__<tool_name>`）
- ⚠ mcp tool runtime e2e 手工验证：需 user 重启应用让 SDK system prompt 注入新 camelCase mcp tool description（详 plan §Step 3.5 R2-L-L2 修法节命令序列）

## 32 字段映射表（迁移 SSOT — caller migration guide）

| snake_case | camelCase | 出现 schema (15 mcp tool) |
|---|---|---|
| `active_form` | `activeForm` | task_create / task_update |
| `adapter_filter` | `adapterFilter` | list_sessions |
| `adopt_teammates` | `adoptTeammates` | hand_off_session |
| `agent_name` | `agentName` | spawn_session |
| `archive_caller` | `archiveCaller` | hand_off_session |
| `base_branch` | `baseBranch` | archive_plan / enter_worktree |
| `base_commit` | `baseCommit` | enter_worktree |
| `blocked_by` | `blockedBy` | task_create / task_update |
| `caller_session_id` | `callerSessionId` | 全 15 tool |
| `changelog_id` | `changelogId` | archive_plan |
| `claude_code_sandbox` | `claudeCodeSandbox` | spawn_session / hand_off_session |
| `codex_sandbox` | `codexSandbox` | spawn_session / hand_off_session |
| `discard_changes` | `discardChanges` | exit_worktree |
| `display_name` | `displayName` | spawn_session |
| `extra_allow_write` | `extraAllowWrite` | spawn_session / hand_off_session |
| `hand_off` | `handOff` | spawn_session (top-level nested object 字段) |
| `parent_session_id` | `parentSessionId` | spawn_session / hand_off_session |
| `permission_mode` | `permissionMode` | spawn_session / hand_off_session |
| `phase_label` | `phaseLabel` | hand_off_session |
| `plan_file_path` | `planFilePath` | archive_plan / enter_worktree / hand_off_session |
| `plan_id` | `planId` | archive_plan / enter_worktree / exit_worktree / hand_off_session / shutdown_baton_teammates |
| `reply_to_message_id` | `replyToMessageId` | send_message |
| `session_id` | `sessionId` | send_message / get_session / shutdown_session |
| `spawned_by_filter` | `spawnedByFilter` | list_sessions |
| `status_filter` | `statusFilter` | list_sessions / task_list |
| `subject_filter` | `subjectFilter` | task_list |
| `task_id` | `taskId` | task_get / task_update / task_delete |
| `team_id` | `teamId` | send_message / task_create / task_update |
| `team_id_filter` | `teamIdFilter` | task_list |
| `team_name` | `teamName` | spawn_session / hand_off_session |
| `team_task_policy` | `teamTaskPolicy` | hand_off_session |
| `worktree_path` | `worktreePath` | archive_plan / enter_worktree / exit_worktree / hand_off_session |

## Breaking change release note + caller migration guide

**影响面**:本 commit 落地后，下次启动应用让 SDK system prompt 注入新 mcp tool description，**调任何 mcp__agent-deck__* tool 时入参必须用 camelCase，旧 snake_case 入参立即报 schema error `Unrecognized key(s) in object`**。

**caller 迁移步骤**:
1. **应用内 SDK 会话（in-process / HTTP transport caller）**: 重启应用即可，SDK system prompt 自动注入新 tool description，LLM caller 自动学到新 camelCase 形式（无需手工改 caller 代码）
2. **第三方 mcp client（stdio external transport caller）**: 按 §32 字段映射表 逐字段把 snake_case 入参改 camelCase（典型如 `send_message({session_id, team_id, text})` → `send_message({sessionId, teamId, text})`）
3. **任何已有第三方文档 / SDK / 示例代码 / 自动化脚本**: 如残留旧 snake_case 入参形式，需同步改 camelCase

**`hand_off_session` 中途接力老 session 特殊场景**:caller cold start 老 session 接旧 plan 走 hand_off 时若用 snake_case 调用 → schema reject + caller fail-fast。**workaround**:user 重启 Claude Code CLI 让新 system prompt 注入新 camelCase tool description，老 session resume 后 caller LLM 重新学到 camelCase 形式继续。

**enum value 完全不变**:`adapter: 'claude-code'` / `permissionMode: 'plan'` / `teamTaskPolicy: 'clear-team'` 等 enum value 字符串完全保留（caller 端 string literal 心智已建立，本 plan 不改）。

**plan workflow frontmatter 不变**:`plan_id: foo` / `base_branch: main` / `worktree_path: /...` 等 plan 文件 frontmatter 字段名仍是 snake_case（archive_plan / hand_off_session 按 snake_case key hardcode 解析，本 plan 不动）— 写 plan 文件时按现有 frontmatter snake_case 格式即可。

## tally.md 候选 U7

`ref/conventions/tally.md` `# 用户反馈候选` 新增 U7（count = 1 起步）:「mcp tool 入参出参 enum 三轨道命名分歧」。**约定要素**:(a) mcp tool 入参字段统一 camelCase；(b) enum value 保持 kebab-case 不动；(c) plan workflow frontmatter 字段保 snake_case；(d) SQLite column / mcp tool 函数名保 snake_case 不动。count ≥ 3 升级到 `ref/conventions/<X>-<topic>.md`。

## 已知限制 + follow-up

- **mcp tool runtime e2e 手工验证未做**：plan §Step 3.5 R2-L-L2 修法节描述的 pkill / pnpm dist / cp -R / codesign / xattr / open 重启应用 → 应用内开 chat 实测 camelCase mcp tool 入参解析正常 + handler 正常 + 出参无变化 — 需 user 手工跑（本 plan 收口完成时间紧）
- **Step 3.6 code deep-review skip**：用户 prompt 直接要求 Step 3.1-Step 4 收口；考虑到本 plan 是纯 mechanical migration（零业务 logic 改动）+ Step 1.5 plan deep-review R1-R5 共 49 fix 充分 + Step 3 实施全 audit 通过（11 不变量 × test case 对照表 0 命中残留 + pnpm vitest 100% pass），跳过 Step 3.6 code-deep-review 风险可控。若 user 后续仍需要 code deep-review 可单独 invoke `agent-deck:deep-review` SKILL kind='code'
