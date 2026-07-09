---
plan_id: "mcp-tool-camelcase-migration-20260529"
created_at: "2026-05-29T17:40:00+08:00"
status: "completed"
base_commit: "f0c790b0fdde8af718e4e5ceeac52bfd9336e7e5"
base_branch: "main"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/mcp-tool-camelcase-migration-20260529"
parent_task_id: "26181f20-a772-434d-9ee5-bc4fe768e432"
final_commit: "7f0b865ea230b796981bde26857f902ea219c12c"
completed_at: "2026-05-29"
---
# mcp tool 命名统一 camelCase plan (breaking change)

## 上下文

继承自 follow-up task `26181f20-a772-434d-9ee5-bc4fe768e432`(plan `deep-project-review-comprehensive-20260528` Phase 5.3 收口期间 user 反馈)。

现状(本 RFC grep 全景实证修正 + R1 deep-review fix):
- **入参 unique 字段名**:**32 个** snake_case(plan 创建时 caller 估「51」含 schema 重复出现 / nested 多次定义;去重后实际 32 个 — 详 §32 字段映射表 节;**R1 fix HIGH-A**:剔除 owner_session_id 不在 zod input + 加入 hand_off top-level field)
- **出参字段**:全 camelCase(`sessionId` / `teamId` / `messageId` / ...)
- **enum 值**:kebab-case + lowercase(`'claude-code'` / `'clear-team'` / `'workspace-write'` / ...)
- **schemas.ts L12-13 注释明文「有意为之」** snake_case 入参 + 内部映射 camelCase(**R1 fix HIGH-B**:caller 写 plan 时把 L23-25 file size guardrail 注释错认作 snake_case 约定注释,实际 L12-13 才是)

User 反馈:三轨道并存导致 caller 体感不一致(JS / TS 圈主流入参出参全 camelCase)。

## 总目标

15 个 mcp tool 入参 **32 unique 字段名** snake_case → camelCase,出参保持 camelCase,**enum 值不动**(kebab-case 保留 — `'claude-code'` / `'clear-team'` 等 user 实际看到的 string 不变)。

## 不变量

1. **不引依赖** — 仅 zod schema + handler 内部引用改写,不引新 lib(`jscodeshift` 等不引)
2. **enum 值不动** — `'claude-code'` / `'codex-cli'` / `'workspace-write'` / `'read-only'` / `'danger-full-access'` / `'plan'` / `'generic'` / `'active'` / `'dormant'` / `'closed'` / `'all'` / `'pending'` / `'completed'` / `'blocked'` / `'abandoned'` / `'clear-team'` / `'preserve-team'` / `'skip'` / `'keep'` / `'remove'` / `'null-personal'` 全保留(降低 breaking 面)
3. **breaking change 一次性** — 不做 snake_case alias 兼容,按本应用 §提示词资产维护 约束 2「不写兼容/预测」
4. **schemas.ts L12-13 注释删 / 改** — 「字段命名约定:tool args **snake_case**(与 task-manager 既有约定一致),handler 内部消费时再映射 camelCase(不在 schema 层映射,避免 zod 推导出错)」改为「字段命名约定:tool args **camelCase**(plan mcp-tool-camelcase-migration-20260529 改造,从 snake_case → camelCase 入参出参对齐);handler 内部直接消费 args.<camelCase> 不再手工映射」(**R1 fix HIGH-B**:R1 评审现场 Read schemas.ts:1-50 实测 L12-13 才是 snake_case 约定注释,L23-25 是 file size guardrail SOP 注释)
5. **handler 内部消费同步改** — 现有 `args.reply_to_message_id` 等 → `args.replyToMessageId`,删手工映射代码(如 `args.reply_to_message_id ?? null` → `args.replyToMessageId ?? null` 直接用)。**R1 fix HIGH-F**:覆盖范围**不限** `tools/handlers/*.ts`,还含 `tools/index.ts:132-142`(makeCtx 函数签名 + body args.caller_session_id / args.parent_session_id 消费)+ `schemas.ts:642-651`(HAND_OFF_SESSION_ARGS_SCHEMA refine 内 args.adopt_teammates / args.team_name 消费)+ SDK tool description string(内部字段名 prose 提及)
6. **测试同步改** — 所有 e2e / unit test 内 mcp tool input fixture 改 camelCase(详 §测试 fixture 清单 — **R1 fix HIGH-D**:30 文件 773 occurrence,补漏的 6 文件 19 处含 spoofing-attack-paths.test.ts string literal 形式)
7. **文档同步改** — `resources/claude-config/CLAUDE.md` / `resources/codex-config/CODEX_AGENTS.md` / `reviewer-{claude,codex}.md` / `SKILL.md` 引用 mcp tool 入参章节同步改 camelCase(详 §文档清单 — **R1 fix MED-A**:实际 328 处含合法 prose 不可机械 sed;**R1 fix LOW-A**:补 flow-arch-plantuml SKILL.md 1 处)
8. **resources/codex-config/ mirror 自动同步** — `scripts/sync-codex-skills.mjs` 跑一次让 codex 端 SKILL 镜像同步;CLAUDE.md / CODEX_AGENTS.md 不通过 sync script,需手工对齐
9. **CHANGELOG / breaking change 公告** — `ref/changelogs/CHANGELOG_X.md` 含 32 字段映射表 + release note 给 caller migration guide
10. **不破坏出参** — 出参字段保持原样(已是 camelCase),仅 入参改
11. **SQLite 列名 / DB schema / mcp tool 函数名 / plan frontmatter 三类不动**(**R1 fix MED-C** + **HIGH-C** 综合扩展):
    - **a. SQLite 列名 / DB schema 字段**:`sessions.session_id` / `tasks.team_id` / `team_members.session_id` / `m.session_id` / `r.session_id` 等 alias.col 引用(grep 实测 ~70+ 处)+ `'team_id'` / `'owner_session_id'` 等 SQL parameter binding key string literal(grep `src/main/store/` 实测 11 处)— SQLite schema 字段名是 snake_case 不可改
    - **b. mcp tool 函数名**:`archive_plan` / `hand_off_session` / `enter_worktree` / `exit_worktree` / `shutdown_baton_teammates` / `task_create` / `task_get` / `task_list` / `task_update` / `task_delete` / `spawn_session` / `send_message` / `get_session` / `list_sessions` / `shutdown_session` 共 15 tool 名 — wire-level identifier `mcp__agent-deck__<tool_name>` 的 `<tool_name>` 部分,改了 caller 端 LLM 学到的 mcp tool 名 / SDK 调用全失效。grep 实测:CLAUDE.md 62 处 + CODEX_AGENTS.md 68 处 + 多文档
    - **c. plan workflow frontmatter 字段**:`plan_id` / `created_at` / `base_commit` / `base_branch` / `final_commit` / `completed_at` / `worktree_path` / `parent_task_id` / `status` 共 9 字段 — archive_plan / hand_off_session / EnterWorktree(path:) 都按 snake_case key 读 plan 文件 frontmatter,改了 plan workflow 全坏。grep 实测:CLAUDE.md 19 处 + CODEX_AGENTS.md 21 处
    - **d. owner_session_id**(R1 fix LOW-B 归入此处):虽是 mcp tool 字段名形式,但**不在任何 zod input schema** 内(仅 schemas.ts:317 / L1025 注释 prose 提及 SQL UPDATE 操作描述),属 SQLite 列名引用,不进 §32 字段映射表迁移

## 设计决策(不再争论)

| 决策 | 选项 | 理由 |
|---|---|---|
| **方案选择** | A. 全 camelCase 入参出参 + enum 保留 kebab-case | RFC 第 1 轮 user 选定(降低 enum 改动 caller 端 string 完全保留) |
| **breaking 模式** | 一次性 hard breaking,不做 snake_case alias | 应用 §提示词资产维护 约束 2「不写兼容/预测」 + 一次性彻底统一比双轨道维护成本低 |
| **enum 值** | 不动(kebab-case) | 降低 breaking 面;`'claude-code'` 等 string user 心智已建立,改了 user 调用代码全部要改 enum 值 |
| **Codemod 方案** | **混合 POSIX ERE sed + 手工 Edit + 白名单**(**R1 fix HIGH-C / HIGH-E**) | RFC 第 2 轮 user 选定;基于 §字段映射表 grep 全景实测 32 字段简单 1:1 转换;**R1 fix HIGH-E**:sed 模板用 POSIX ERE(`[[:space:]]` / `[^_[:alnum:]]`)替代 PCRE 记号(`\s` / `\w` / `\b` 在 BSD `sed -E` 不识别 — R1 现场 printf mini-test 实测);**R1 fix HIGH-C**:文档 Pattern 4 改手工 Edit + 白名单(避开 mcp tool 函数名 / plan frontmatter / SQLite column prose 三类误伤) |
| **Spike 决策** | **不需 spike** | RFC 第 2 轮 user 选定;32 字段简单 1:1 机械转换,nested `hand_off` 已 camelCase(详 §字段映射表),enum value 不动与字段名改 camelCase 独立,无歧义边角;typecheck + vitest 自动捕获误伤 |
| **description prose 处理** | 手工 Edit | RFC 第 1 轮 user 选定(避开 schemas.ts description 长字符串内中文 / 例子 / 公式误伤) |
| **R1 fix MED-E:中间 commit 策略** | **schemas 改 + handler args 改 + index.ts/refine 改合并为同一 green commit**(Step 3.1+3.2+3.1.5 合并) | R1 reviewer-codex 提:plan §Step 3 总标题写「每段后 commit + typecheck + vitest」但 Step 3.1 又预期 typecheck 失败提交 schemas-only commit,语义冲突 → 中间 commit 不可构建违反 checklist 语义。改为合并 commit 让 typecheck 全过才 commit |

## 32 字段映射表(完整 SSOT — R1 fix HIGH-A 修订)

基于 `grep -nE '^[[:space:]]+[a-z][a-z0-9]*(_[a-z0-9]+)+[[:space:]]*:' src/main/agent-deck-mcp/tools/schemas.ts | awk ... | sort -u` 实测全景(reviewer-codex R1 复现命令):

| snake_case | camelCase | 出现 schema(15 mcp tool) | schemas.ts 行号(主定义) |
|---|---|---|---|
| `active_form` | `activeForm` | task_create / task_update | 1047 / 1146 |
| `adapter_filter` | `adapterFilter` | list_sessions | 187 |
| `adopt_teammates` | `adoptTeammates` | hand_off_session | 468 |
| `agent_name` | `agentName` | spawn_session | 66 |
| `archive_caller` | `archiveCaller` | hand_off_session | 453 |
| `base_branch` | `baseBranch` | archive_plan / enter_worktree | 254 / 523 |
| `base_commit` | `baseCommit` | enter_worktree | 514 |
| `blocked_by` | `blockedBy` | task_create / task_update | 1063 / 1149 |
| `caller_session_id` | `callerSessionId` | 全 15 tool | 119 / 149 / 178 / 202 / 215 / 280 / 439 / 539 / 570 / 607 / 1077 / 1119 / 1131 / 1162 / 1178 |
| `changelog_id` | `changelogId` | archive_plan | 270 |
| `claude_code_sandbox` | `claudeCodeSandbox` | spawn / hand_off | 100 / 413 |
| `codex_sandbox` | `codexSandbox` | spawn / hand_off | 94 / 407 |
| `discard_changes` | `discardChanges` | exit_worktree | 564 |
| `display_name` | `displayName` | spawn_session | 80 |
| `extra_allow_write` | `extraAllowWrite` | spawn / hand_off | 112 / 424 |
| **`hand_off`** | **`handOff`** | **spawn_session(top-level nested object 字段)** | **132** |
| `parent_session_id` | `parentSessionId` | spawn / hand_off | 127 / 447 |
| `permission_mode` | `permissionMode` | spawn / hand_off | 88 / 401 |
| `phase_label` | `phaseLabel` | hand_off_session | 367 |
| `plan_file_path` | `planFilePath` | archive / enter / hand_off | 262 / 431 / 531 |
| `plan_id` | `planId` | archive / enter / exit / hand_off | 238 / 350 / 497 / 615 |
| `reply_to_message_id` | `replyToMessageId` | send_message | 167 |
| `session_id` | `sessionId` | send / get / shutdown | 147 / 210 / 214 |
| `spawned_by_filter` | `spawnedByFilter` | list_sessions | 190 |
| `status_filter` | `statusFilter` | list_sessions / task_list | 186 / 1088 |
| `subject_filter` | `subjectFilter` | task_list | 1092 |
| `task_id` | `taskId` | task_get / task_update / task_delete | 1130 / 1142 / 1173 |
| `team_id` | `teamId` | send / task_create / task_update | 158 / 1069 / 1153 |
| `team_id_filter` | `teamIdFilter` | task_list | 1100 |
| `team_name` | `teamName` | spawn / hand_off | 57 / 393 |
| `team_task_policy` | `teamTaskPolicy` | hand_off_session | 475 |
| `worktree_path` | `worktreePath` | archive / enter / exit / hand_off | 246 / 505 / 555 |

**字段总数核对**:32 unique snake_case 字段(plan 创建时 caller 估「51」含 schema 重复出现:`caller_session_id` 在 15 tool 各定义一次 → 15 occurrence + `plan_id` 在 4 tool 各定义一次 → 4 occurrence + ... 累加 ≈ 67 schema 字段定义行,去重后 32 unique 字段名)。

**R1 fix HIGH-A 修订内容**:
- **删除** `owner_session_id` 行(reviewer-codex R1 现场实测:grep schemas.ts 仅 L317 / L1025 注释 prose 提及 SQL UPDATE 操作描述,**不在任何 z.string() 内** — 已归入 §不变量 #11 列项 d)
- **新增** `hand_off` 行(reviewer-codex R1 现场实测:schemas.ts:132 `hand_off: z.object(...)` 是 SPAWN_SESSION_SCHEMA top-level input field;spawn.ts:271 消费 `args.hand_off`;tools.test.ts:804/827 有 `hand_off` fixture)

**nested object 验证**(R1 fix INFO-A 修订表述):
- `hand_off` **顶层字段名本身是 snake_case 必须改 `handOff`**(已加入上 §32 字段映射表表格行)
- `hand_off` nested object **内部** 5 字段(`mode` / `planId` / `phaseLabel` / `fromCallerSid` / `hasAdoptedBlock`)**已是 camelCase 不需改**(schemas.ts:132-145 实测)
- 其他 nested(`metadata` / etc):全是 user-defined key 不属本 plan scope

## sed pattern(POSIX ERE — R1 fix HIGH-E + HIGH-C)

### ⚠ 关键修正(R1 fix HIGH-E)

R1 reviewer-codex 现场 printf mini-test 实测:**macOS BSD `sed -E` 不识别 PCRE 记号 `\s` / `\w` / `\b`**:
- Test 1: `printf '  session_id: z.string()' | sed -E 's/^(\s*)session_id(\s*:\s*z\.)/\1sessionId\2/g'` → **输出未变**(`\s` 不是 whitespace)
- Test 2: `printf 'x args.reply_to_message_id y' | sed -E 's/\bargs\.reply_to_message_id\b/.../g'` → **输出未变**(`\b` 不是 word boundary)
- Test 3: `printf '{session_id: 1, sessions.session_id: 2, xxx_session_id: 3}' | sed -E 's/([^.\w])session_id(\s*:)/.../g'` → **`xxx_session_id` 误改成 `xxx_sessionId`**(`[^.\w]` 排除前缀字符仅 `.` 和字面 `\w` 不是 word char,`xxx_session_id` 中 `_` 不在排除集 → 命中误改)

**修正方案**:全部 sed pattern 改 POSIX ERE:
- `\s` → `[[:space:]]`
- `\w` → `[[:alnum:]_]`(POSIX `\w` 等价的 char class)
- `\b` → 显式前后缀 `[^_[:alnum:]]`(字面排除 word char 边界)

实测 POSIX ERE 替代版本工作正常:
- Test 4: `printf '  session_id: z.string()' | sed -E 's/^([[:space:]]*)session_id([[:space:]]*:[[:space:]]*z\.)/\1sessionId\2/g'` → **`  sessionId: z.string()` 正确替换**
- Test 5: `printf 'x args.reply_to_message_id y' | sed -E 's/([^_[:alnum:]])args\.reply_to_message_id([^_[:alnum:]])/\1args.replyToMessageId\2/g'` → **`x args.replyToMessageId y` 正确替换**

### Pattern 1: schemas.ts 字段定义(R2-C2-H1 修法:perl -0pi 跨行 + 双 sed pattern 兜底)

⚠ **R2-C2-H1 关键修正**:R2 reviewer-codex + caller spot check 实测 schemas.ts 69 行 snake_case 字段定义中,**只有 12 行同行 `:[[:space:]]*z\.`,57 行(83%)是 `field: z\n .object()/.string()/.enum()` 换行链式形式**(典型 hand_off:schemas.ts:132 实测就是 `hand_off: z\n .object(...)`)。原 Pattern 1 单行 `: z\.` regex **直接漏改 83%**!

**修法 — perl -0pi 跨行匹配主路径**(perl 默认能识别 `\s` PCRE,且 `-0` 模式将整文件作为一个字符串处理):

```bash
# Pattern 1 主路径(perl multi-line,32 字段全部展开)
perl -0pi -E 's/^(\s*)<snake>(\s*:\s*z\b)/$1<camelCase>$2/gm' src/main/agent-deck-mcp/tools/schemas.ts
```

例:
```bash
perl -0pi -E 's/^(\s*)session_id(\s*:\s*z\b)/$1sessionId$2/gm' src/main/agent-deck-mcp/tools/schemas.ts
perl -0pi -E 's/^(\s*)caller_session_id(\s*:\s*z\b)/$1callerSessionId$2/gm' src/main/agent-deck-mcp/tools/schemas.ts
perl -0pi -E 's/^(\s*)hand_off(\s*:\s*z\b)/$1handOff$2/gm' src/main/agent-deck-mcp/tools/schemas.ts
# ... 32 字段类推
```

**关键**:`\b` perl 内是真 word boundary,`\s` 是 whitespace,`/gm` 让 `^` 匹配每行开头(含 multi-line 内容)。匹配 `field: z\n` (换行链式) 与 `field: z.string()` (同行) 都 cover。

**审计验证**:
```bash
# Pattern 1 跑完后必为空(任何残留 = 漏改)
grep -nE '^[[:space:]]+(active_form|adapter_filter|adopt_teammates|agent_name|archive_caller|base_branch|base_commit|blocked_by|caller_session_id|changelog_id|claude_code_sandbox|codex_sandbox|discard_changes|display_name|extra_allow_write|hand_off|parent_session_id|permission_mode|phase_label|plan_file_path|plan_id|reply_to_message_id|session_id|spawned_by_filter|status_filter|subject_filter|task_id|team_id|team_id_filter|team_name|team_task_policy|worktree_path)[[:space:]]*:' src/main/agent-deck-mcp/tools/schemas.ts
# 必为空(0 命中);若有命中 = perl pattern 漏匹配,逐字段补
```

**fallback — sed 双 pattern 兜底**(若 perl 不可用):

```bash
# 双 pattern:同行 z. + 行尾 z (R2-C2-H1 拆两条 sed)
# Pattern 1a: field: z.xxx (12 行同行命中)
sed -i '' -E 's/^([[:space:]]*)<snake>([[:space:]]*:[[:space:]]*z\.)/\1<camelCase>\2/g' src/main/agent-deck-mcp/tools/schemas.ts
# Pattern 1b: field: z$ (57 行换行链式命中)
sed -i '' -E 's/^([[:space:]]*)<snake>([[:space:]]*:[[:space:]]*z[[:space:]]*$)/\1<camelCase>\2/g' src/main/agent-deck-mcp/tools/schemas.ts
```

(注:perl 主路径更稳;sed 双 pattern 适合应急或 perl 不可用环境)

### Pattern 2: handler `args.<snake>` 引用(R1 fix HIGH-F:覆盖范围扩展)

**R1 fix HIGH-F**:Pattern 2 必须覆盖三处运行时代码,**不限** `tools/handlers/*.ts`:

| 文件 path | 命中行 | 内容 |
|---|---|---|
| `src/main/agent-deck-mcp/tools/handlers/*.ts` + `handlers/**/*.ts` | 190 处 | handler args 消费 |
| `src/main/agent-deck-mcp/tools/index.ts:132/138/140` | 3 处 | makeCtx 函数签名 + body args.caller_session_id / args.parent_session_id |
| `src/main/agent-deck-mcp/tools/schemas.ts:646` | 1 处 | HAND_OFF_SESSION_ARGS_SCHEMA refine 内 `args.adopt_teammates === true && args.team_name !== undefined` |

```bash
# Pattern 2 用 `[^_[:alnum:]]args\.<snake>[^_[:alnum:]]` 严格匹配 args 前缀 + word boundary 模拟
# 不命中 SQLite 列名(`sessions.session_id` / `m.session_id` 等)
# 注意 sed 显式 capture 前后字符,替换时还原
sed -i '' -E 's/([^_[:alnum:]])args\.<snake>([^_[:alnum:]])/\1args.<camelCase>\2/g' src/main/agent-deck-mcp/tools/handlers/*.ts
sed -i '' -E 's/([^_[:alnum:]])args\.<snake>([^_[:alnum:]])/\1args.<camelCase>\2/g' src/main/agent-deck-mcp/tools/handlers/**/*.ts
# R1 fix HIGH-F:补 index.ts + schemas.ts 非 handler 运行时代码
sed -i '' -E 's/([^_[:alnum:]])args\.<snake>([^_[:alnum:]])/\1args.<camelCase>\2/g' src/main/agent-deck-mcp/tools/index.ts
sed -i '' -E 's/([^_[:alnum:]])args\.<snake>([^_[:alnum:]])/\1args.<camelCase>\2/g' src/main/agent-deck-mcp/tools/schemas.ts
```

例:
```bash
sed -i '' -E 's/([^_[:alnum:]])args\.reply_to_message_id([^_[:alnum:]])/\1args.replyToMessageId\2/g' src/main/agent-deck-mcp/tools/handlers/send.ts
# 同时把 handler 内的手工映射代码(`args.reply_to_message_id ?? null`)删除/改成 `args.replyToMessageId ?? null` 直接用
# index.ts:132-142 makeCtx 函数签名 + body 同步:
sed -i '' -E 's/([^_[:alnum:]])args\.caller_session_id([^_[:alnum:]])/\1args.callerSessionId\2/g' src/main/agent-deck-mcp/tools/index.ts
sed -i '' -E 's/([^_[:alnum:]])args\.parent_session_id([^_[:alnum:]])/\1args.parentSessionId\2/g' src/main/agent-deck-mcp/tools/index.ts
# 函数签名 args: { caller_session_id?: string; parent_session_id?: string; } 也需手工 Edit 改 type
# schemas.ts:646 refine 内消费:
sed -i '' -E 's/([^_[:alnum:]])args\.adopt_teammates([^_[:alnum:]])/\1args.adoptTeammates\2/g' src/main/agent-deck-mcp/tools/schemas.ts
sed -i '' -E 's/([^_[:alnum:]])args\.team_name([^_[:alnum:]])/\1args.teamName\2/g' src/main/agent-deck-mcp/tools/schemas.ts
```

⚠ **sed 替换边界注意**:`[^_[:alnum:]]` capture 前后单字符,行首/行末需显式 anchor 处理 — 实施时若行首/行末漏改,补一条 `^args\.<snake>` / `args\.<snake>$` 或先 `head/tail` 看上下文手工 Edit。

### Pattern 3: 测试 fixture mcp tool input(R2-L-H1 + L-H3 + L-H4 修法:改手工 Edit + 白名单 audit)

⚠ **R2-L-H1 + L-H3 + L-H4 关键修正**:caller R1 写 sed Pattern 3 用字符级 boundary `[^_[:alnum:].]<snake>([[:space:]]*:)`,**字符级排除不能区分**以下四类 snake_case 出现位置:

1. **真 mcp tool input fixture**(典型:`handler({ session_id: 'foo' })` / `task_create({ team_id: ..., ... })`)— **改 camelCase**
2. **plan frontmatter mock template literal**(典型:`` `plan_id: ${planId}` `` / `` `worktree_path: ${tmp}` ``)— **不改**(违反 §不变量 #11.c plan workflow frontmatter snake_case)
3. **describe/it test 名 prose**(典型:`describe('archive_plan with plan_id', ...)`)— **不改**(test 名描述无业务影响)
4. **注释 prose**(典型:`// session_id is closed by the SDK`)— **不改**

**实测铁证**(R2 reviewer-claude + caller spot check):
- `archive-plan.impl-followup-20260515.test.ts` 64 命中 = 9 template literal mock + 8 test 名 + 4 注释 + 0 真 input fixture(spot check `grep -nE '\.handler\(\{[^}]*plan_id'` 实测 0 处)
- 单 sed Pattern 3 字符级 boundary 跑完 → 全部 64 处都改成 camelCase → **plan workflow frontmatter mock 误伤 9 处** + **test 名 / 注释 prose 误改 12 处**(无业务必要)+ **真 input fixture 0 处实际不改**

**修法 — 改手工 Edit + 白名单 audit**(类比 §sed pattern §Pattern 4 文档处理):

1. **第一步:每个测试文件 grep 全景列出 snake_case 出现行**:
   ```bash
   # 32 字段 union pattern(POSIX ERE)
   grep -nE '(active_form|adapter_filter|adopt_teammates|agent_name|archive_caller|base_branch|base_commit|blocked_by|caller_session_id|changelog_id|claude_code_sandbox|codex_sandbox|discard_changes|display_name|extra_allow_write|hand_off|parent_session_id|permission_mode|phase_label|plan_file_path|plan_id|reply_to_message_id|session_id|spawned_by_filter|status_filter|subject_filter|task_id|team_id|team_id_filter|team_name|team_task_policy|worktree_path)' src/main/agent-deck-mcp/__tests__/<file>.ts
   ```
2. **第二步:每行目视审上下文,白名单 = 真 mcp tool input fixture / 黑名单 = 其他三类**:
   - **白名单(改 camelCase)**:
     - `handler({ <field>: ... })` / `tools.get('xxx').handler({ <field>: ..., ... }, {})`
     - 直接对象 literal 内字段 `{ <field>: 'value', <field2>: ... }`
   - **黑名单(不改)**:
     - **template literal mock**(任何 `` ` `` backtick 包围的字符串内 `<field>: ${...}` 形式 — plan workflow frontmatter mock,§不变量 #11.c)
     - **describe/it test 名 prose**(`describe('xxx <field> yyy', ...)` / `it('should do X with <field>', ...)`)
     - **注释 prose**(`// <field>` / `/* ... <field> ... */`)
     - **SQLite 列名引用**(`m.<field>` / `r.<field>` / `<table>.<field>` / `'<field>'` SQL parameter binding)
3. **第三步:`git diff src/main/agent-deck-mcp/__tests__/` 必目视审**所有改动行都是真 mcp tool input fixture 上下文,无白名单外误改

**Audit 信号词**(命中后 skip 不改 — 黑名单上下文识别):
- 行内含 backtick `` ` `` — template literal,可能是 plan frontmatter mock
- 行内含 `describe(` / `it(` / `test(` — test 名 prose
- 行首是 `//` 或 `/*` 或在 `/* ... */` 块内 — 注释 prose
- 行内含 `m.` `r.` `s.` `<table_alias>.` `agent_deck_*.` — SQLite 列名引用

**特殊处理 — string literal 形式**(reviewer-claude HIGH-D 提的 spoofing-attack-paths.test.ts 14 处):
```bash
# string literal 形式(单引号 / 双引号包裹)— 单独审是否真 mcp tool input
grep -nE "['\"]<snake>['\"]" src/main/agent-deck-mcp/__tests__/spoofing-attack-paths.test.ts
# 14 处全部目视审上下文:是 mcp tool input field key 形式还是 spoofing scenario raw key prose?
# 真是 input field key 形式(`'session_id'` 当 object key 用)→ 改 `'sessionId'`
# spoofing scenario 描述 raw key 字符串(攻击向量 prose)→ 不改保持原 attack vector
```

**Audit 完成验证**(R4-C4-M1 修法:拆两条 audit 1a + 1b cover 真 input fixture 两类形式):
```bash
# audit 1a: .handler({...}) 形式真 input fixture(R3-L-H1 前缀 cover 紧贴 brace)
grep -rEh '\.handler\(\{[^}]*(\{|,|[[:space:]])(active_form|adapter_filter|adopt_teammates|agent_name|archive_caller|base_branch|base_commit|blocked_by|caller_session_id|changelog_id|claude_code_sandbox|codex_sandbox|discard_changes|display_name|extra_allow_write|hand_off|parent_session_id|permission_mode|phase_label|plan_file_path|plan_id|reply_to_message_id|session_id|spawned_by_filter|status_filter|subject_filter|task_id|team_id|team_id_filter|team_name|team_task_policy|worktree_path)[[:space:]]*:' src/main/agent-deck-mcp/__tests__/
# 必为空(0 命中)

# audit 1b: const args: <Type> = {...} 直接对象 fixture(R4-C4-M1 新增,补 .handler 之外的直接对象路径)
# 实测 shutdown-baton-teammates.handler.test.ts:66 + hand-off-session.handler-cwd-generic.test.ts:92,174 等 const args 形式
grep -rEnh 'const args[^=]*= \{[^}]*(\{|,|[[:space:]])(active_form|adapter_filter|adopt_teammates|agent_name|archive_caller|base_branch|base_commit|blocked_by|caller_session_id|changelog_id|claude_code_sandbox|codex_sandbox|discard_changes|display_name|extra_allow_write|hand_off|parent_session_id|permission_mode|phase_label|plan_file_path|plan_id|reply_to_message_id|session_id|spawned_by_filter|status_filter|subject_filter|task_id|team_id|team_id_filter|team_name|team_task_policy|worktree_path)[[:space:]]*:' src/main/agent-deck-mcp/__tests__/
# 必为空(0 命中)

# audit 2: 测试文件内注释 prose(// 或 * 起首行)中 args.<snake> 引用 — 仅人工提示不设守门
# 测试注释 prose 是黑名单合法保留(§Pattern 3 §修法 §黑名单上下文):caller 实测 9+ 处含 hand-off-session.adopt-teammates / task-events / helpers.deny-external / transport-http-extra-auth 注释 prose
grep -rEn '^[[:space:]]*(//|\*).*\b(active_form|adapter_filter|adopt_teammates|agent_name|archive_caller|base_branch|base_commit|blocked_by|caller_session_id|changelog_id|claude_code_sandbox|codex_sandbox|discard_changes|display_name|extra_allow_write|hand_off|parent_session_id|permission_mode|phase_label|plan_file_path|plan_id|reply_to_message_id|session_id|spawned_by_filter|status_filter|subject_filter|task_id|team_id|team_id_filter|team_name|team_task_policy|worktree_path)\b' src/main/agent-deck-mcp/__tests__/
# 仅人工目视审,不设必为空守门
# 注:audit 1a / 1b 仅看真 input fixture 上下文(`.handler({...})` 与 `const args: <Type> = {...}` 内),不查 template literal / test 名 / 注释 — 与白名单语义一致(详 §修法 §白名单 §黑名单)
```

### Pattern 4: 文档(.md) 引用(R1 fix HIGH-C:重写为手工 Edit + 白名单)

⚠ **R1 fix HIGH-C 关键修正**:文档 sed pattern blast radius 大,会无差别命中三类绝对不能改的内容(详 §不变量 #11 列项 b/c):
- mcp tool 函数名(15 tool 名,grep CLAUDE.md 62 处 + CODEX_AGENTS.md 68 处)
- plan workflow frontmatter 字段(9 字段,grep CLAUDE.md 19 处 + CODEX_AGENTS.md 21 处)
- SQLite column prose 提及(`team_id` 等词义重载场景)

**修正方案**:**不**用 sed Pattern 4 全文替换,改为**手工 Edit + 白名单 audit**:

1. **第一步:grep 全景列出文档内每处 snake_case identifier 出现行**:
   ```bash
   grep -nE '(active_form|adapter_filter|adopt_teammates|agent_name|archive_caller|base_branch|base_commit|blocked_by|caller_session_id|changelog_id|claude_code_sandbox|codex_sandbox|discard_changes|display_name|extra_allow_write|hand_off|parent_session_id|permission_mode|phase_label|plan_file_path|plan_id|reply_to_message_id|session_id|spawned_by_filter|status_filter|subject_filter|task_id|team_id|team_id_filter|team_name|team_task_policy|worktree_path)' resources/<doc-path>.md
   ```
2. **第二步:每处目视审上下文**,按以下规则分类处理:
   - **白名单(改 camelCase)**:mcp tool input field 描述上下文 — 典型:`mcp__agent-deck__xxx({field, ...})` 调用示例 / 字段 props 表 `| field | ... |` 行 / `args.<snake>` prose 提及 → 手工 Edit 改 camelCase
   - **黑名单(不改)**:三类合法引用 — mcp tool 函数名 / plan frontmatter 字段(`plan_id` / `base_commit` 等)/ SQLite column prose 提及(`sessions.team_id`)→ skip 不动
3. **第三步:`git diff` 必目视确认**所有改动行都是 mcp tool input field 描述上下文,无白名单外误改

**Audit 信号词**(命中后 skip 不改 — 黑名单上下文识别):
- `mcp__agent-deck__` / `mcp tool` / `tool 名` / `tool name` — mcp tool 函数名上下文
- `frontmatter:` / `plan_id:` / `base_commit:` / `EnterWorktree(path:)` — plan frontmatter 上下文
- `sessions.` / `tasks.` / `team_members.` / `agent_deck_team_members.` / `SQLite` / `column` / `列名` / `<table>.<col>` — SQLite schema 上下文

## SQLite 列名 / mcp tool 函数名 / plan frontmatter 三类误伤排除策略(R1 fix MED-C / HIGH-C 综合)

### 误伤范围(grep 实测)

| Pattern | 含义 | 命中数 | 不能改 |
|---|---|---|---|
| `sessions.session_id` `tasks.team_id` `team_members.session_id` `m.session_id` `r.session_id` `p.session_id` `o.task_id` etc | SQLite alias.col / 表.列 引用 | ~70+ 处(28+12+11+11+9+9+7+6+4 ...) | DB schema 字段名 |
| `'team_id'` `'owner_session_id'`(字符串字面量 in `src/main/store/`) | SQL parameterized binding key | 7+4 = 11 处 | 对应 SQLite 列名 |
| `agent_deck_team_members.session_id` / `agent_deck_teams.archived_at` 等 prefix table.col | 全限定 SQL 引用 | 少量 | 同上 |
| `archive_plan` `hand_off_session` `enter_worktree` `task_create` `task_list` etc(R1 fix HIGH-C 新增)| mcp tool 函数名(15 tool) | CLAUDE.md 62 处 + CODEX_AGENTS.md 68 处 + 多文档 | wire-level identifier `mcp__agent-deck__<tool_name>` 的 `<tool_name>` 部分 |
| `plan_id:` `base_commit:` `base_branch:` `worktree_path:` `final_commit:` `completed_at:` etc(R1 fix HIGH-C 新增)| plan workflow frontmatter 字段 | CLAUDE.md 19 处 + CODEX_AGENTS.md 21 处 | plan workflow 按 snake_case key 读 frontmatter |

### 排除策略(三层防线 + R1 fix HIGH-C 文档黑名单)

1. **sed pattern 用前缀约束**:
   - Pattern 2(handler / index / refine `args.<snake>`)用 `[^_[:alnum:]]args\.<snake>[^_[:alnum:]]`(POSIX ERE 等价 `\bargs\.<snake>\b`)— 强制 `args.` 前缀,SQLite alias `m.session_id` / `r.session_id` 等不命中
   - Pattern 3(测试 fixture)用 `[^_[:alnum:].]<snake>([[:space:]]*:)` — 排除 `.` 前缀(SQLite 列名)+ word char 前缀(`xxx_session_id` 不再误伤,R1 fix HIGH-E `[^.\w]` PCRE 误读修正)
   - Pattern 4(文档)**改手工 Edit + 白名单 audit**(R1 fix HIGH-C — 见 §sed pattern §Pattern 4)
2. **每批 sed 后 git diff audit**:每 pattern 跑完后目视审 diff,确认所有改动行都是 mcp tool input field 上下文,无 §不变量 #11 列项 a/b/c/d 误伤
3. **typecheck + vitest 自动捕获**:
   - 误改 SQLite 列名 → typecheck error(SQL query 字段名与 column 名不匹配)
   - 误改 mcp tool 函数名 → vitest fail(tool 名引用断链)+ 应用启动 mcp tool registration 失败
   - 误改 plan frontmatter → archive_plan / hand_off_session 解析 frontmatter 失败 fail-fast

### 实施 audit 步骤

```bash
# 每批 sed 后必做
git diff src/main/agent-deck-mcp/tools/schemas.ts  # Pattern 1
git diff src/main/agent-deck-mcp/tools/handlers/ src/main/agent-deck-mcp/tools/index.ts  # Pattern 2(R1 fix HIGH-F 扩展)
git diff src/main/agent-deck-mcp/__tests__/        # Pattern 3
git diff resources/                                 # Pattern 4(手工 Edit + 白名单)
# 目视确认(R1 fix MED-C / HIGH-C 综合扩展):
# - schemas.ts 改动行全是 zod schema field 定义(`<camelCase>: z.xxx`)
# - handlers/ + index.ts + schemas.ts:646 改动行全是 `args.<camelCase>` 引用 / makeCtx 函数签名 / refine,无 SQLite alias
# - __tests__/ 改动行全是 `{<camelCase>:` 测试 fixture,无 SQL 列名引用,无 mcp tool 函数名误伤
# - resources/ 改动行全是 mcp tool input field 描述上下文,无:
#   * mcp tool 函数名(`archive_plan` 等 15 tool 名)
#   * plan frontmatter 字段(`plan_id:` / `base_commit:` 等)
#   * SQLite schema 提及(`sessions.<col>` 等)
```

## 测试 fixture 清单(R2-L-H3 + C2-L1 修法:30 文件 + raw / 估真 input fixture / 估不改 三栏)

⚠ **R1 fix HIGH-D**:caller 写 plan 时 grep 命中 24 文件 534/535 occurrence,实际 reviewer-claude R1 grep audit:**30 文件**(漏 6 文件 19 处含 spoofing-attack-paths.test.ts 14 处显著)。

⚠ **R2-C2-L1 + L-H3 修法**:R2 reviewer-codex + reviewer-claude 实测 plan 表 raw occurrence 数字三方不一致(标题 773 / 表合计 551 / grep -o 实测 814)— 因 `grep -rEho`(-o 多次命中同行)与 `grep -rE`(每行一次)语义不同。改 plan 用**两个区分明确的可复现 grep 命令** + 加「估真 input fixture」+「估不改」分类列。

**两个可复现 grep 命令**(R2 修法,数字一致性可复现):

```bash
# 命令 A: raw -o 每次命中(同行多命中重复)— 与 caller R1 grep -rEho 一致
grep -rEho '(active_form|adapter_filter|adopt_teammates|agent_name|archive_caller|base_branch|base_commit|blocked_by|caller_session_id|changelog_id|claude_code_sandbox|codex_sandbox|discard_changes|display_name|extra_allow_write|hand_off|parent_session_id|permission_mode|phase_label|plan_file_path|plan_id|reply_to_message_id|session_id|spawned_by_filter|status_filter|subject_filter|task_id|team_id|team_id_filter|team_name|team_task_policy|worktree_path)' src/main/agent-deck-mcp/__tests__/ | wc -l
# 实测 raw -o 命中: 814(R2 实测 — caller R1 写 773 是旧数据 / 不复现)

# 命令 B: 文件数 -l(unique 文件)
grep -rl -E '(<32 字段 union>)' src/main/agent-deck-mcp/__tests__/ | wc -l
# 实测命中文件数: 30

# 命令 C: 真 mcp tool input fixture 数 — 仅 .handler({...}) 上下文 (R2-L-H3 关键修法)
grep -rEh '\.handler\(\{[^}]*(\{|,|[[:space:]])(<32 字段 union>)[[:space:]]*:' src/main/agent-deck-mcp/__tests__/ | wc -l
# 实测真 input fixture: ~待 audit 阶段实测;R2 caller spot check archive-plan.impl-followup-20260515 单文件命令 C = 0(全部 24 raw 命中都是 template literal / test 名 / 注释)
# **R3-L-H1 + L-H2 修法**:前缀 `(\{|,|[[:space:]])` 替代 `\b`(`\b` PCRE BSD grep silent no-op + `[[:space:]]` 单一前缀漏紧贴 brace 形式)
```

**完整 30 文件清单 + R2-L-H3 三栏分类**(reviewer-claude R2 grep audit 实测 + caller spot check):

| 文件 | raw -o 命中(命令 A 实测)| 真 input fixture 数(命令 C 实测)| 估「不改」(命令 A − 命令 C — template literal mock + test 名 + 注释 + SQLite alias)|
|---|---|---|---|
| `tools.test.ts` | 194 | (audit 阶段实测)| (按命令 A − 命令 C)|
| `hand-off-session.adopt-teammates.test.ts` | 82 | (audit 阶段实测)| |
| `archive-plan.impl-followup-20260515.test.ts` | 64 | **0**(R2 spot check 实测全部是 template literal mock + test 名 + 注释)| 64 |
| `hand-off-session.handler-deny-happy.test.ts` | (重新实测)| (audit 阶段实测)| |
| `hand-off-session.archive-caller-false.test.ts` | 34 | (audit 阶段实测)| |
| `archive-plan.impl-ff-merge-body.test.ts` | 18 | (audit 阶段实测)| |
| `spoofing-attack-paths.test.ts` | 16 | (audit 阶段实测 — string literal `'session_id'` 形式 14 处需区分 attack vector raw key prose vs object key)| |
| `hand-off-session.handler-cwd-generic.test.ts` | 16 | (audit 阶段实测)| |
| `archive-plan.handler.test.ts` | (重新实测)| (audit 阶段实测)| |
| `spawn-agent-name-routing.test.ts` | 14 | (audit 阶段实测)| |
| `hand-off-session.task-reassign.test.ts` | (重新实测)| (audit 阶段实测)| |
| `lead-context-block.test.ts` | (重新实测)| (audit 阶段实测)| |
| `archive-plan.impl-r33.test.ts` | (重新实测)| (audit 阶段实测)| |
| `enter-exit-worktree.test.ts` | (重新实测)| (audit 阶段实测)| |
| `task-crud.test.ts` | (重新实测)| (audit 阶段实测)| |
| `archive-plan/_setup.ts` | (重新实测)| (audit 阶段实测)| |
| `hand-off-session/_setup.ts` | (重新实测)| (audit 阶段实测)| |
| `hand-off-session.impl-core.test.ts` | (重新实测)| (audit 阶段实测)| |
| `shutdown-baton-teammates.handler.test.ts` | (重新实测)| (audit 阶段实测)| |
| `archive-plan.impl-core.test.ts` | (重新实测)| (audit 阶段实测)| |
| `task-events.test.ts` | (重新实测)| (audit 阶段实测)| |
| `transport-http-extra-auth.test.ts` | (重新实测)| (audit 阶段实测)| |
| `adopted-teams-context-block.test.ts` | (重新实测)| (audit 阶段实测)| |
| `spawn-guards.test.ts` | (重新实测)| (audit 阶段实测)| |
| `baton-cleanup.test.ts` | (重新实测)| (audit 阶段实测)| |
| `archive-plan.base-branch-named-only.test.ts` | (重新实测)| (audit 阶段实测)| |
| `archive-plan.impl-cwd-marker.test.ts` | (重新实测)| (audit 阶段实测)| |
| `dormant-teammate-shutdown.test.ts` | (重新实测)| (audit 阶段实测)| |
| `helpers.deny-external.test.ts` | (重新实测)| (audit 阶段实测)| |
| `task-external-caller.test.ts` | (重新实测)| (audit 阶段实测)| |
| **合计** | **814 raw -o**(命令 A 实测)| **(audit 阶段实测出真 input fixture 总数)** | **(命令 A − 命令 C)** |

⚠ **R2 修法重要**(L-H3 核心):**Step 3.3 实施时绝不能机械按 raw 命中数全改**;必须按 §sed pattern §Pattern 3 节描述的「手工 Edit + 白名单 audit」流程,**每行目视审上下文白名单**(真 mcp tool input fixture)vs **黑名单**(template literal mock / test 名 / 注释 / SQLite alias 引用)— 详 §sed pattern §Pattern 3 §修法。

⚠ **实施流程顺序**:Step 3.3 走 audit 时**先**跑命令 C 拿真 input fixture 总数 + per-file count,**然后**逐文件按白名单/黑名单手工 Edit。Plan 内不预先固化 per-file 数字(数字会随 codebase 漂移,以实施时实测为准)。

## 文档清单(R1 fix MED-A + LOW-A:7 文件 328 raw occurrence)

⚠ **R1 fix MED-A**:caller 写 plan 时 grep 命中 6 文件 49 处(仅排查 mcp tool input 上下文);实际 reviewer-claude R1 grep audit:**7 文件 328 raw occurrence**(含合法 prose 不能改的 mcp tool 函数名 / plan frontmatter / SQLite column,详 §不变量 #11)。改 plan 拆「需改 mcp tool input field 描述」vs「合法 prose 不能改」两栏。

⚠ **R1 fix LOW-A**:补 1 文件 1 处命中(`resources/claude-config/agent-deck-plugin/skills/flow-arch-plantuml/SKILL.md` L82 `Caller -> Tool: invoke({plan_id, worktree_path, changelog_id})`)。

| 文件 | raw 命中(grep 总命中)| 估「需改 input field」| 估「合法 prose 不改」| 同步方式 |
|---|---|---|---|---|
| `resources/codex-config/CODEX_AGENTS.md` | 140 | ~17 | ~123(68 mcp tool 函数名 + 21 plan frontmatter + ~34 SQLite/其他)| 手工 Edit + 白名单 audit |
| `resources/claude-config/CLAUDE.md` | 113 | ~16 | ~97(62 mcp tool 函数名 + 19 plan frontmatter + ~16 SQLite/其他)| 手工 Edit + 白名单 audit |
| `resources/codex-config/agent-deck-plugin/agents/reviewer-codex.md` | 17 | ~4 | ~13 | 手工 Edit + 白名单 audit |
| `resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md` | 17 | ~4 | ~13 | 手工 Edit + 白名单 audit |
| `resources/claude-config/agent-deck-plugin/skills/deep-review/SKILL.md` | 14 | ~4 | ~10 | 手工 Edit + 白名单 audit;改完跑 sync-codex-skills.mjs |
| `resources/codex-config/agent-deck-plugin/skills/deep-review/SKILL.md` | 14 | ~4 | ~10 | sync-codex-skills.mjs 自动镜像(不手工改 codex 端 SKILL) |
| **`resources/claude-config/agent-deck-plugin/skills/flow-arch-plantuml/SKILL.md`**(R1 fix LOW-A 新增)| **1** | **1**(L82 `invoke({plan_id, worktree_path, changelog_id})`) | **0** | 手工 Edit + 白名单 audit;**仅 claude 端**(R2-C2-M2 修法:scripts/sync-codex-skills.mjs:46 SKIP_SKILLS 含 'flow-arch-plantuml',codex 端不存在镜像)|
| **合计** | **~327 raw**(7 文件,R2-C2-M2 修法删 codex flow-arch mirror 行)| **~50 需改** | **~277 不改** |  |

**双端 SSOT 同步规则**(P35 候选教训):
- `resources/claude-config/agent-deck-plugin/skills/*/SKILL.md` 是 SSOT,改完 `pnpm exec node scripts/sync-codex-skills.mjs` **自动镜像** 到 `resources/codex-config/agent-deck-plugin/skills/`
- `CLAUDE.md` / `CODEX_AGENTS.md` 不通过 sync script,**手工对齐** 两份(双端约定有不同部分,需手工 audit)
- `reviewer-{claude,codex}.md` 在双端 `agents/` 下,**双端各自维护**(两端 prompt 因 adapter 差异不完全一致,不能 sync)

## 测试矩阵覆盖度(R1 fix MED-D + R2 fix L-H2/C2-M1/L-M1 修法:全 POSIX ERE + 精确化 + 声明隐含承诺)

⚠ **R1 fix MED-D**:plan §不变量 11 条但**无独立测试矩阵节**列每条不变量对应的 test case 守门;R1 reviewer-claude 提 plan 设计阶段应补 testing strategy。

⚠ **R2 fix L-H2 修法**:R2 reviewer-claude 提原表内 6 处 grep 含 PCRE 记号(`\b` / `\s` / `\|` 转义错)与 plan §HIGH-E sed POSIX ERE 修正约定不一致(macOS BSD grep 虽 GNU compatible 实测能 match,但 plan 内一致性应统一)— 全部改 POSIX ERE。

⚠ **R2 fix C2-M1 修法**:R2 reviewer-codex 提 #2 enum grep / #10 出参 grep 命令实测 no-op 或大量噪声 — 改用精确 vitest assertion / TypeScript satisfies 替代宽泛 grep。

⚠ **R2 fix L-M1 修法**:#5 audit grep 隐含承诺「应用层 args.<snake> 全部都在 32 字段映射表内」未声明 — 显式声明实测 32 unique args.<snake> 与 §32 字段映射表 32 字段完全 match,故 grep 为空既是充分条件也是必要条件。

本节 11 条不变量 × test case 对照表:

| 不变量 | 对应 test case / verify 命令(全 POSIX ERE) | Test 文件 / 行号 |
|---|---|---|
| #1 不引依赖 | `pnpm typecheck && grep -E '"(jscodeshift|recast|babel)"' package.json` 必无新 codemod 依赖(限定具体名,非泛 grep)| (Step 3.5 verify) |
| #2 enum 值不动 | **vitest assertion**(替代 grep):tools.test.ts 已有 enum value fixture 断言(`adapter: 'claude-code'` / `team_task_policy: 'clear-team'` 等);`pnpm vitest run -- enum` 必过 + audit grep 看 enum value literal 保留:`grep -nE "z\.enum\(\[[^]]*'(claude-code|codex-cli|workspace-write)'" src/main/agent-deck-mcp/tools/schemas.ts` 实测有命中(R2-C2-M1:原表 grep `\.` 假设单行 z.enum 已修;R3-C3-H1 修法 `\|` → `|` ERE alternation)| tools.test.ts(已有 enum value 断言)|
| #3 breaking change 一次性(无 alias)| `grep -rEn '(snake_case alias|backward compat|legacy field)' src/main/agent-deck-mcp/tools/` 必无 alias 注释 / 兼容代码(R3-C3-H1 修法:`\|` → `|` ERE alternation)| (R1 fix MED-D 新增 audit grep)|
| #4 schemas.ts L12-13 注释改写 | `grep -nE '字段命名约定.*camelCase' src/main/agent-deck-mcp/tools/schemas.ts` 必命中 L12-13 + grep snake_case 注释必为空:`grep -nE 'tool args.*snake_case' src/main/agent-deck-mcp/tools/schemas.ts` 必为空 | (Step 3.1+3.2 内手工 Edit)|
| #5 handler 内部消费同步改 | **R4-C4-M1 + R5-C5-M1 修法**(prefix-aware 注释过滤):`grep -rInE 'args\.[a-z]+(_[a-z0-9]+)+' src/main/agent-deck-mcp/tools/ | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*)'` 必为空(R5-C5-M1:用 `grep -rInE` 输出 `file:line:content` 格式 + `grep -vE` POSIX ERE 排除 `<file>:<line>:<注释开头>` 形式,**避开 grep -rE 输出注释行被前缀 file path 污染无法用 `^\s*//` 匹配的 bug**;限定运行时代码 `tools/` 排除 `__tests__/` + 注释 prose `//` / `*` 行 — 测试文件内 args.<snake> 注释 prose 是黑名单合法保留)。**R2-L-M1 显式声明**:caller 实测 32 unique args.<snake> 与 §32 字段映射表 32 字段完全 match,故 grep 为空既是充分条件也是必要条件 | (Step 3.5 verify audit grep)|
| #6 测试同步改 | **R4-C4-M1 修法 — 拆两条 audit**:**(audit 1a `.handler({...})` 形式真 input fixture)** `grep -rEh '\.handler\(\{[^}]*(\{|,|[[:space:]])(active_form|adapter_filter|adopt_teammates|agent_name|archive_caller|base_branch|base_commit|blocked_by|caller_session_id|changelog_id|claude_code_sandbox|codex_sandbox|discard_changes|display_name|extra_allow_write|hand_off|parent_session_id|permission_mode|phase_label|plan_file_path|plan_id|reply_to_message_id|session_id|spawned_by_filter|status_filter|subject_filter|task_id|team_id|team_id_filter|team_name|team_task_policy|worktree_path)[[:space:]]*:' src/main/agent-deck-mcp/__tests__/` **必为空**。**(audit 1b `const args: <Type> = {...}` 直接对象 fixture)** `grep -rEnh 'const args[^=]*= \{[^}]*(\{|,|[[:space:]])(active_form|adapter_filter|adopt_teammates|agent_name|archive_caller|base_branch|base_commit|blocked_by|caller_session_id|changelog_id|claude_code_sandbox|codex_sandbox|discard_changes|display_name|extra_allow_write|hand_off|parent_session_id|permission_mode|phase_label|plan_file_path|plan_id|reply_to_message_id|session_id|spawned_by_filter|status_filter|subject_filter|task_id|team_id|team_id_filter|team_name|team_task_policy|worktree_path)[[:space:]]*:' src/main/agent-deck-mcp/__tests__/` **必为空**。**(audit 2 prose/comment 仅人工提示不设必为空)**:`grep -rEn '^[[:space:]]*(//|\*).*\b(active_form|...|worktree_path)\b' src/main/agent-deck-mcp/__tests__/` 命中行人工目视审,但**不**设守门(测试注释 prose 是黑名单合法保留,详 §sed pattern §Pattern 3 §修法 §黑名单上下文)| (Step 3.5 verify audit grep)|
| #7 文档同步改 | 7 文件每文件按 §文档清单白名单/黑名单手工 audit;`git diff resources/` 必目视审无白名单外误改;**+ R2 fix(L-M2 反驳)**:实测 `find resources/ -name "*.md" -type f` = 20 文件,7 文件外**无** mcp tool input 引用(caller spot check `find ... | xargs grep -lE '<32字段union>'` 在 7 文件外为空),故 7 文件白名单已充分 | (Step 3.4 手工 Edit + audit)|
| #8 sync-codex-skills.mjs 自动同步 | `pnpm exec node scripts/sync-codex-skills.mjs` 跑后,对**非 SKIP_SKILLS** SKILL 子目录(deep-review / hello-from-deck)diff:`diff resources/claude-config/agent-deck-plugin/skills/deep-review/SKILL.md resources/codex-config/agent-deck-plugin/skills/deep-review/SKILL.md` 必无 mcp tool input field 差异(R2-C2-M2 修法:不能用全目录 diff,flow-arch-plantuml 在 SKIP_SKILLS 内,codex 端不存在)| (Step 3.4 末尾命令)|
| #9 CHANGELOG / breaking change 公告 | Step 4 `ref/changelogs/CHANGELOG_X.md` 含 32 字段映射表 + release note + migration guide | (Step 4 收口)|
| #10 不破坏出参 | **vitest assertion 兜底**(替代宽泛 grep):tools.test.ts / hand-off-session.handler-deny-happy.test.ts 已有 response shape assertion(`expect(result).toMatchObject({ sessionId, teamId, ... })` 等);`pnpm vitest run` 必过(R2-C2-M1:原表 `grep 'return \\{ ...sessionId|teamId|messageId'` alternation 无分组导致命中 lead-context-block.ts 等普通变量,改用现有测试)+ TypeScript satisfies 守门:`pnpm typecheck` 命中出参 type mismatch 自动 fail | tools.test.ts(已有 response shape 断言)|
| #11 a/b/c/d SQLite 列名 / mcp tool 函数名 / plan frontmatter / owner_session_id 不动 | a: `src/main/store/__tests__/v023-migration.test.ts` / `v024-migration.test.ts` 已有列名断言;b/c: `grep -nE '(archive_plan|hand_off_session|enter_worktree|exit_worktree|shutdown_baton_teammates|task_create|task_get|task_list|task_update|task_delete|spawn_session|send_message|get_session|list_sessions|shutdown_session)' resources/<7 file>` 仍命中(数量不变,~130 处,R3-C3-H1 修法 `\|` → `|` ERE alternation);d: `grep -nE 'owner_session_id' src/main/agent-deck-mcp/tools/schemas.ts` 仍命中 L317/L1025(注释 prose 保留;**R3-L-M1 修法**:实测全仓 8 处含 schemas.ts:317 / L1025 + index.ts:353 + task-helpers.ts:79+87 + task-list.ts:14 + task-create.ts:2+40,SQLite column / task_create description prose 全部不动,仅 audit prose 范围)| migration test(已有)+ audit grep |

**audit 时机**:Step 3.5 build verify 内集中跑;任一 audit grep 命中或 test fail → 回 Step 3.1+3.2 / 3.3 / 3.4 fix。

**R2-L-I2 修法 — §sed pattern §Pattern 2 行首/行末 audit 补具体命令**:
```bash
# 实施 Pattern 2 后,补 audit 行首/行末漏改:
grep -rnE '^args\.([a-z]+(_[a-z0-9]+)+)|args\.([a-z]+(_[a-z0-9]+)+)$' src/main/agent-deck-mcp/ 
# 必为空(行首 `args.<snake>` 或行末 `args.<snake>` 残留 = 漏改);若有命中按字段手工 Edit
```

## 步骤 Checklist

### Step 0 RFC(已完成 — RFC 第 1 轮 + 第 2 轮)
- [x] 方案 A/B/C/D 选定:user 选 A(全 camelCase 入参出参 + enum 保留)
- [x] **RFC 第 2 轮 codemod 决策**:user 选混合方案(sed + 手工 Edit)
- [x] **RFC 第 2 轮 spike 决策**:user 选不需 spike(简单 1:1 转换 + nested 已 camelCase + enum value 不动独立 + typecheck/vitest 双保险)
- [x] **RFC 第 1 轮 description prose 处理**:user 选手工 Edit
- [x] grep 全景实证:32 unique snake_case 字段(plan 创建估「51」修正)
- [x] grep 全景实证:SQLite 列名误伤 ~70+ 处(详 §SQLite 列名误伤排除策略)

### Step 0.5 Spike(已 skip — RFC 决策不需 spike)
- [x] ~~spike1:51 字段 snake_case → camelCase 自动转换正确性~~(skip — 32 字段简单 1:1 + nested 已 camelCase + typecheck/vitest 双保险足以捕获误伤)

### Step 1 plan 文件细化(R1 fix 已完成)
- [x] frontmatter / 总目标 / 不变量 / 设计决策骨架
- [x] §32 字段映射表(行号 reference + nested 验证 + R1 fix HIGH-A 修订:加 hand_off 删 owner_session_id)
- [x] §sed pattern(POSIX ERE — R1 fix HIGH-E + HIGH-C 修订)
- [x] §SQLite 列名 / mcp tool 函数名 / plan frontmatter 三类误伤排除策略(R1 fix MED-C / HIGH-C 综合扩展)
- [x] §测试 fixture 清单(R1 fix HIGH-D + LOW-C 修订:30 文件 773 occurrence)
- [x] §文档清单(R1 fix MED-A + LOW-A 修订:7 文件 328 raw occurrence)
- [x] §测试矩阵覆盖度节(R1 fix MED-D 新增:11 不变量 × test case 对照表)
- [x] 步骤行级 reference + R1 fix MED-E 合并 Step 3.1+3.2 single green commit
- [x] §已知踩坑 R1 fix MED-B / LOW-B 修订(10 条)

### Step 1.5 Deep-Review plan(R1 R2 R3 R4 R5 完成 + 全部 fix 完成 + R6 待执行)
- [x] R1 invoke `agent-deck:deep-review` SKILL kind='plan' 评审 plan(16 finding 全 ✅)
- [x] R1 三态裁决 + R1 fix 16 处
- [x] R2 复用 reviewer pair `send_message` 发 R2 prompt
- [x] R2 三态裁决:17 finding(6 HIGH ✅ + 5 MED ✅+1 反驳 + 3 LOW + 2 INFO ✅)+ R2 fix 16 处
- [x] R3 复用 reviewer pair `send_message` 发 R3 prompt
- [x] R3 三态裁决:14 finding(4 HIGH ✅ + 5 MED ✅ + 3 LOW + 2 INFO ✅)+ R3 fix 14 处
- [x] R4 复用 reviewer pair `send_message` 发 R4 prompt
- [x] R4 三态裁决:reviewer-claude 全 ✅ + reviewer-codex 1 真 MED(C4-M1 audit 漏扫 / 误扫)+ R4 fix 1 处
- [x] R5 复用 reviewer pair `send_message` 发 R5 prompt
- [x] R5 三态裁决:**reviewer-claude 「0 HIGH/0 真 MED → 共识可合」+ reviewer-codex 「0 HIGH + 2 真 MED(C5-M1 #5 grep 注释过滤 prefix bug + C5-M2 line 266 多余 fence)」+ 我现场 spot check 确认 → 必修**
- [x] R5 fix 2 处(C5-M1 + C5-M2 + 顺手 INFO-R5-I1)
- [ ] **R6 复用 reviewer pair `send_message` 发 R6 prompt**(skip 摘要 = R5 fix 2 处);R6 focus 只 verify line 436 prefix-aware filter + line 266 fence 删除 + fence parity ✓
- [ ] fix loop 直到 0 HIGH / 0 真 MED 共识可合(SKILL §收口判定 + R6 stop 条件:**R6 出 ≥ 1 HIGH → 继续 fix R7;R6 出 0 HIGH/0 真 MED → 共识可合 → 进 Step 2** — **预估快速通过**)

### Step 2 EnterWorktree(user 显式 confirm 后,严禁自动进)
- [ ] **user 显式 confirm 进 worktree 实施**(应用 §复杂 plan workflow §Step 2 EnterWorktree 节硬约束)
- [ ] `git -C /Users/apple/Repository/personal/agent-deck worktree add -b worktree-mcp-tool-camelcase-migration-20260529 /Users/apple/Repository/personal/agent-deck/.claude/worktrees/mcp-tool-camelcase-migration-20260529`
- [ ] `EnterWorktree(path: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/mcp-tool-camelcase-migration-20260529)`(用 path 不用 name 避开 v2.1.112 stale base bug)
- [ ] 进 worktree 后 `Bash: pwd` 自检 + `git log --oneline -3` 自检 HEAD == `f0c790b` 或之后

### Step 3 实施(R1 fix MED-E:合并为单 green commit + 拆 5 段;每段 typecheck/vitest 必过才进下一段)

⚠ **R1 fix MED-E**:caller 写 plan 时 Step 3.1 / 3.2 各 commit 一次,但 Step 3.1 schemas 改完 handler 未同步必 typecheck error → 提交一个已知 typecheck 失败的中间 commit,与「每段 commit + typecheck + vitest」语义冲突。改为**Step 3.1 + 3.2 + 3.1.5 合并为单 green commit**(schemas + handler args + index.ts + schemas.ts:646 refine + description prose 一起改一起 commit)。

#### Step 3.1+3.2(合并 single green commit)— schemas + 全部 args 引用 + description prose

**改动范围**(R1 fix HIGH-A / HIGH-B / HIGH-E / HIGH-F 综合):
- (a) schemas.ts 字段定义 ~67 行(sed Pattern 1 POSIX ERE,32 字段含 hand_off)
- (b) **schemas.ts L12-13 注释手工改写**「字段命名约定:tool args **camelCase**(plan mcp-tool-camelcase-migration-20260529 改造);handler 内部直接消费 args.<camelCase> 不再手工映射」(R1 fix HIGH-B:**caller 原写 L23-25 是错的**,实际 L12-13 才是 snake_case 注释)
- (c) schemas.ts description prose 内字段名引用 **手工 Edit** ~86+ 处(R1 fix MED-B:caller 估 ~37 是低估,实际 grep `_id|_at|_by` 86+ 含 owner_session_id 等不改字段)
- (d) handler `args.<snake>` 引用 ~190 处(sed Pattern 2 POSIX ERE,32 字段)
- (e) **R1 fix HIGH-F + R3-L-H3 行号回滚(R2-L-M3 反向错)**:`tools/index.ts:132/138/140` makeCtx 函数签名 `args: { caller_session_id?: string; parent_session_id?: string; }`(type sig 起 L132,L132 = `caller_session_id?:` field / L133 = `parent_session_id?:` field)+ body 消费 `args.caller_session_id`(L138)/ `args.parent_session_id`(L140)改 camelCase(手工 Edit type sig + sed args)。**R3-L-H3 教训**:R1 reviewer-claude L-M3 finding 实测错(说 L132 是注释 / L140 是 type 闭括号),caller R2 fix L-M3 跟着改成 138/143/145 反向错 — R3 reviewer-claude 重新现场 Read 实测确认 R1 原版 132/138/140 才对;**lesson learned**:行号 reference 漂移风险高,implementation 前必现场 Read verify,reviewer finding 实测铁证不要无脑信
- (f) **R1 fix HIGH-F**:`schemas.ts:646` HAND_OFF_SESSION_ARGS_SCHEMA refine 内 `args.adopt_teammates === true && args.team_name !== undefined` 改 `args.adoptTeammates === true && args.teamName !== undefined`(sed args 引用)
- (g) **R1 fix HIGH-F + MED-B**:source code 内 prose 提及字段名(`tools/index.ts:24/169` / `tools/handlers/adopted-teams-context-block.ts:27/89/90/131/132` / `tools/handlers/spawn.ts:197/437` / `tools/handlers/lead-context-block.ts:98` / `tools/handlers/send.ts:7/11/80` ~20 处)手工 Edit
- (h) handler 内手工映射代码删(grep `args\.[a-z]+(_[a-z0-9]+)+[[:space:]]*\?\?` 显式 fallback,R3-L-H2 修法 PCRE `\s` → POSIX ERE `[[:space:]]`,如 `args.reply_to_message_id ?? null` → `args.replyToMessageId ?? null` 直接用)

**Audit 步骤**:
- [ ] sed Pattern 1 + Pattern 2 跑 32 字段(全部展开 POSIX ERE 形式,见 §sed pattern)
- [ ] schemas.ts L12-13 注释手工改写
- [ ] schemas.ts description prose 86+ 处手工 Edit
- [ ] index.ts:132/138/140 + schemas.ts:646 + source code prose 手工 Edit
- [ ] handler 手工映射代码删
- [ ] **`pnpm typecheck` 必过**(任何 args.<snake> 残留漏改 → typecheck error 暴露)
- [ ] **git diff audit**:确认改动行全是 zod field 定义 / args.camelCase 引用 / makeCtx 函数签名 / refine / description prose 合法位置,无 SQLite alias / mcp tool 函数名 / plan frontmatter 误伤
- [ ] commit `feat(mcp-tool): 32 字段 snake_case → camelCase 全栈同步(schemas + handler args + index/refine + description prose)`

#### Step 3.3 测试 fixture(R2-L-H1 + L-H3 + L-H4 修法:30 文件 + 手工 Edit + 白名单 audit)

⚠ **R2-L-H1 + L-H3 + L-H4 关键修正**:R2 review 实测原 sed Pattern 3 字符级 boundary 不能区分真 mcp tool input fixture vs template literal mock / test 名 / 注释 prose;改手工 Edit + 白名单 audit(详 §sed pattern §Pattern 3)。

- [ ] **第一步**:30 个测试文件每文件按 §sed pattern §Pattern 3 §修法第一步 跑 grep 拿 32 字段命中行
- [ ] **第二步**:每行目视审上下文(白名单 = 真 mcp tool input fixture in `.handler({...})` / 直接对象 literal;黑名单 = template literal mock / test 名 / 注释 / SQLite alias)
- [ ] 手工 Edit 白名单内每处改 camelCase
- [ ] **特殊处理**:`spoofing-attack-paths.test.ts` 14 处 string literal `'session_id'` 形式按 §sed pattern §Pattern 3 §特殊处理 — 目视审是 attack vector raw key prose 还是真 input field key,真是 input key 才改
- [ ] **R2-L-H3 数字提醒**:Step 3.3 实施时**绝不能机械按 §测试 fixture 清单 raw -o 命中数全改**;每文件 audit 实测真 input fixture 数(命令 C),按白名单 / 黑名单逐行手工
- [ ] **重点 audit**:30 个测试文件 git diff 排查 — 确认仅真 mcp tool input fixture 改 camelCase,无 template literal mock(§不变量 #11.c plan workflow frontmatter)/ test 名 / 注释 / SQLite 列名误伤
- [ ] `pnpm vitest run` verify 全过(任何 mock 数据 / parametric assertion 漏改会 fail)
- [ ] **§测试矩阵 #6 audit grep**(R3-L-H1 + R3-L-H2 + R3-C3-H1 + R4-C4-M1 修法 — 拆两条 audit cover 真 input fixture 两类):
  - **audit 1a `.handler({...})` 形式**: `grep -rEh '\.handler\(\{[^}]*(\{|,|[[:space:]])(<32 字段 union>)[[:space:]]*:' src/main/agent-deck-mcp/__tests__/` 必为空
  - **audit 1b `const args: <Type> = {...}` 直接对象 fixture**: `grep -rEnh 'const args[^=]*= \{[^}]*(\{|,|[[:space:]])(<32 字段 union>)[[:space:]]*:' src/main/agent-deck-mcp/__tests__/` 必为空(R4-C4-M1 新增 — caller R4 reviewer-codex 实测 shutdown-baton-teammates.handler.test.ts:66 / hand-off-session.handler-cwd-generic.test.ts:92,174 等 const args 直接对象 fixture)
  - **audit 2 注释 prose** 仅人工目视提示,不设守门(测试注释 prose 是 §Pattern 3 黑名单合法保留)
- [ ] commit `test(mcp-tool): 测试 fixture 字段 snake_case → camelCase 同步 schemas(详 audit 实测真 input fixture 总数)`

#### Step 3.4 文档同步(R1 fix HIGH-C / MED-A / LOW-A:7 文件 ~51 需改 ~277 不改;手工 Edit + 白名单 audit)

⚠ **R1 fix HIGH-C**:文档**不**用 sed Pattern 4 全文替换,改手工 Edit + 白名单 audit(详 §sed pattern §Pattern 4)。

- [ ] **第一步:grep 全景列出 7 文件每处 snake_case identifier 出现行**(详 §sed pattern §Pattern 4 §第一步)
- [ ] **第二步:每处目视审上下文,白名单 = mcp tool input field 描述上下文 / 黑名单 = mcp tool 函数名 + plan frontmatter + SQLite column prose**(详 §sed pattern §Pattern 4 §第二步)
- [ ] 手工 Edit 白名单内每处改 camelCase
- [ ] **第三步**:`git diff resources/` 必目视审 — 确认所有改动行都是 mcp tool input field 描述上下文,无:
  - mcp tool 函数名误伤(`archive_plan` 等 15 tool 名)
  - plan frontmatter 字段误伤(`plan_id:` / `base_commit:` 等)
  - SQLite column prose 误伤(`sessions.<col>` 等)
- [ ] `pnpm exec node scripts/sync-codex-skills.mjs` 同步 codex 端 SKILL(R2-C2-M2 + R3-C3-M2 修法:scripts/sync-codex-skills.mjs:46 `SKIP_SKILLS = new Set(['flow-arch-plantuml'])`,仅 deep-review + hello-from-deck 镜像;flow-arch-plantuml **仅 claude 端**手工 Edit,codex 端不存在镜像不可 diff)
- [ ] 双端手工对齐:`resources/claude-config/CLAUDE.md` 与 `resources/codex-config/CODEX_AGENTS.md` 字段名 prose 同步
- [ ] commit `docs(mcp-tool): ~51 处文档 mcp tool input field 改 camelCase + codex 端 mirror 同步`

#### Step 3.5 build verify(全量回归 + R1 fix MED-D 测试矩阵 audit)

- [ ] `pnpm typecheck`(必过)
- [ ] `pnpm build`(必过)
- [ ] `pnpm vitest run`(全 unit + e2e 测试,必过)
- [ ] **R2-L-L2 修法:Step 3.6 deep-review SKILL 与 mcp tool runtime e2e 拆分**:
  - Step 3.6 deep-review SKILL kind='mixed' 是 reviewer LLM **静态评审 plan + code 一致性**,**不**跑 mcp tool runtime
  - mcp tool runtime e2e(真起 reviewer-* teammate / 真发 send_message / 真跑 archive_plan)需**显式手工验证**:
    ```bash
    # 重启应用让 SDK system prompt 注入新 camelCase mcp tool description
    # R3-L-M2 修法:pkill 必须含 Agent Deck Helper(GPU/renderer/utility 子进程)— 仅 kill 主进程留 Helper 残留 → IPC 端口冲突 / asar chunk hash 错配 → renderer 显示 monaco 源码(项目 CLAUDE.md §打包踩坑案例)
    pkill -f "Agent Deck.app/Contents/MacOS/Agent Deck" 2>/dev/null
    pkill -f "Agent Deck Helper" 2>/dev/null
    rm -rf build/dist && pnpm dist
    rm -rf "/Applications/Agent Deck.app" && cp -R "build/dist/mac-arm64/Agent Deck.app" /Applications/
    codesign --force --deep --sign - "/Applications/Agent Deck.app"
    xattr -dr com.apple.quarantine "/Applications/Agent Deck.app"
    open -a "Agent Deck"
    # 应用内开 chat 测:spawn_session({adapter, cwd, prompt, ...}) / send_message / archive_plan({planId, worktreePath, baseBranch}) — 全部 camelCase 入参,确认 zod schema 接受 + handler 正常 + 出参无变化
    ```
- [ ] **R1 fix MED-D + R2 fix L-H2/C2-M1 测试矩阵 audit**:11 不变量 × test case 对照表(verify 每条不变量都有对应 test 守门,详 §测试矩阵覆盖度;全部 grep 命令已升级 POSIX ERE + 精确化)

### Step 3.6 Deep-Review code(实施后,fix loop)
- [ ] invoke `agent-deck:deep-review` SKILL kind='mixed'(plan + code 一并 review)
- [ ] fix loop 直到 0 HIGH / 0 真 MED 共识可合

### Step 4 收口
- [ ] 经验沉淀:`ref/conventions/tally.md` 加候选「mcp tool 入参出参 enum 三轨道命名分歧」(若 count ≥ 3 升级 → ref/conventions/<X>-<topic>.md)
- [ ] CHANGELOG_X 写归档:32 字段 snake_case → camelCase 映射表 + breaking change release note + caller migration guide
- [ ] `ExitWorktree(action: "keep")` + `mcp__agent-deck__archive_plan({planId:"mcp-tool-camelcase-migration-20260529", worktreePath:"<abs-path>", baseBranch:"main", changelogId:"<X>"})`(**R2-C2-H2 修法**:迁移完成后 mcp tool 入参必须用 camelCase,旧 snake_case key 会被 strict schema reject `Unrecognized key(s) in object`)

## 当前进度

**已完成**:
- Step 0 RFC 全部完成(第 1 轮方案选定 + 第 2 轮 codemod 方案 + spike 决策 + description prose 处理)
- Step 0.5 spike skip(RFC 决策不需)
- Step 1 plan 文件全部细化 + R1+R2+R3+R4+R5 fix 共 49 处(详 §下一会话第一步 §R5 fix 摘要 + 历史摘要)
- Step 1.5 R1+R2+R3+R4+R5 deep-review SKILL 完成 + 全部 fix 完成

**当前位置**(R3-L-M3 修法:去 hardcode HEAD;Step 1.5 实施时 plan 写完是 HEAD `30b21d6`,后续提交持续漂移;进 Step 2 EnterWorktree 前 caller 现场自检 `git -C <main-repo> log --oneline -1` 拿 actual HEAD): main repo HEAD `<EnterWorktree 前 git log -1 实测>`(本 R3 fix 时已漂到 `57147d9` 「docs(diagrams): REVIEW_64 PlantUML SSOT 失真度评审 R1+R2+R3 三轮收口」,均与本 plan 无关是别的 in-flight 工作),main repo 可能 dirty 含别的 in-flight 工作(本 plan 文件在 `.claude/plans/` 不入 git tracked,worktree 隔离与 main repo dirty 不冲突)。caller 仍 active(本 session sid `45982d7f-e624-4a59-8037-3d465eed7172`),task `1d7388cb-5470-4ddc-b5b5-4c192031b4d4` 跟踪中(R3 fix 进行中,待 R4)。reviewer pair sid `6e8aeeba` reviewer-claude + sid `019e7331` reviewer-codex 仍 active 待复用发 R4 prompt

**Step 2 EnterWorktree 提醒**:user 显式 confirm 后 `git worktree add -b worktree-mcp-tool-camelcase-migration-20260529 <path>` 默认从当前 HEAD(随 main repo 漂移,**不**是 plan frontmatter base_commit `f0c790b`)— 应用本应用 §EnterWorktree CLI stale base bug callout Bash 形式无需手工指定 base commit 默认 HEAD,实施 OK;若 plan §32 字段映射表 schemas.ts 行号 reference 与当前 HEAD 主仓库代码不同步(R3-L-H3 教训:R1 → R2 → R3 三轮 index.ts 行号反复修法),**实施前必现场 Read verify schemas.ts / index.ts 真实行号锚定**(reviewer finding 实测铁证不要无脑信)

**未完成**:
- Step 1.5 R6 deep-review(复用 reviewer pair 发 R6 prompt + skip 字段 = R5 fix 2 处)— **预估快速通过收口**(R5 reviewer-claude 已判全 ✅,reviewer-codex 仅 2 MED 内部一致性 bug 已 fix)
- Step 1.5 fix loop 直到 0 HIGH / 0 真 MED 共识可合(R6 stop 条件:R6 出 ≥ 1 HIGH → 继续 fix R7;R6 出 0 HIGH/0 真 MED → 共识可合 → 进 Step 2)
- Step 2 EnterWorktree(待 user 显式 confirm;实施前必现场 Read verify schemas.ts / index.ts 真实行号锚定 — R3-L-H3 教训)
- Step 3 实施(合并 3.1+3.2 single green commit / 3.3 / 3.4 / 3.5 build verify)
- Step 3.6 deep-review code
- Step 4 收口

## 下一会话第一步

按本 plan **Step 1.5 R6 Deep-Review plan**(本 R5 review 完成 + R5 fix 完成后等 R6 评审):

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/mcp-tool-camelcase-migration-20260529.md` 全文读 plan(已含 R1+R2+R3+R4+R5 fix 共 49 处)
2. **R1 + R2 + R3 + R4 fix 摘要**(已在 R2/R3/R4/R5 skip 字段发出过,reviewer 已知;R6 skip 不再重复)
3. **R5 fix 摘要**(skip 字段,Round 6 发给 reviewer pair 时附带,避免重复评审 R5 已 fix 的内容):
   ```
   R5 fix 2 处(R4 fix 之外新增):
   - C5-M1: §测试矩阵 #5 grep 改 prefix-aware filter — 原 `grep -rE | grep -v '^\s*//' | grep -v '^\s*\*'` 在 grep -rE 输出 `file:content` 格式上无效(行首是 file path 不是 `//`),改 `grep -rInE 'args\.[a-z]+(_[a-z0-9]+)+' tools/ | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*)'`(prefix-aware filter + POSIX ERE)— 实测过滤注释 prose 后仅留运行时代码命中(R1 fix HIGH-F + MED-B 范围内 description prose / handler args 引用)
   - C5-M2: 删 plan line 266 多余裸 ``` fence — R4 fix 引入的 markdown 结构错位,实测 awk 跑 fence parity 从 23 odd → 22 even,后续 Pattern 4 fence 配对恢复正确
   - 顺手 INFO-R5-I1: reviewer-claude R5 INFO 提的 `\s` PCRE 记号一致性已被 C5-M1 prefix-aware filter 用 `[[:space:]]` POSIX ERE 一并修了
   ```
4. **invoke `agent-deck:deep-review` SKILL R6**(完整 Skill() 命令形式):
   ```
   Skill(skill: "agent-deck:deep-review", args: '{"kind": "plan", "paths": ["/Users/apple/Repository/personal/agent-deck/.claude/plans/mcp-tool-camelcase-migration-20260529.md"]}')
   ```
   或直接复用 reviewer pair `send_message(reply_to_message_id)`(SKILL Step 5 复用)
5. fix loop 直到 0 HIGH / 0 真 MED 共识可合(**R6 stop 条件**:R6 出 ≥ 1 HIGH → 继续 fix → R7;R6 出 0 HIGH / 0 真 MED → 共识可合 — **R5 已 reviewer-claude 全 ✅ + reviewer-codex 2 MED 内部一致性已 fix,R6 预估快速通过**)
6. **与 user 显式 confirm 进 Step 2 EnterWorktree;严禁自动进 worktree**
7. Step 2 后**必现场 Read verify schemas.ts / index.ts 真实行号锚定**(R3-L-H3 教训)→ 按 Step 3.1+3.2 → 3.3 → 3.4 → 3.5 顺序实施,每段后 commit + typecheck + vitest;Step 3.6 deep-review code;Step 4 收口

## 已知踩坑

1. **schemas.ts L12-13 注释「字段命名约定 snake_case」是有意为之** — 改 camelCase 时这条注释也改写,不要保留旧版误导(R1 fix HIGH-B:caller 写 plan 时把 L23-25 file size guardrail 注释错认作 snake_case 注释,实际 L12-13 才是;Step 3.1+3.2 内手工 Edit)
2. **handler 内部手工映射代码删** — `args.reply_to_message_id ?? null` 这种映射 (`send.ts:109` 等) 改成 `args.replyToMessageId ?? null` 直接用,不要保留双重映射(Step 3.1+3.2)
3. **claude/codex 双端文档 SSOT mirror** — claude `resources/claude-config/` 改完 跑 `pnpm exec node scripts/sync-codex-skills.mjs` 同步 codex 端 SKILL(自动 mirror),**不要双端各自改 SKILL**(SSOT 漂移)。但 CLAUDE.md / CODEX_AGENTS.md 不通过 sync script 同步,需手工对齐(P35 候选教训)
4. **测试 fixture grep 范围广** — **30 文件**(R3-C3-M1 修法:删除 fixed per-file 数字 773 — 数字会随 codebase 漂移,以实施时实测为准,详 §测试 fixture 清单 R2-L-H3 拆三栏);Pattern 3 **禁用** sed 字符级 boundary,改**手工 Edit + 白名单 audit**(详 §sed pattern §Pattern 3 R2 修法);spoofing-attack-paths.test.ts string literal `'session_id'` 形式独立目视审是 attack vector raw key prose 还是真 input field key
5. **mcp tool description string + source code prose 内字段名出现处** — schemas.ts 内 description string 提到字段名时(用作给 LLM 的契约文档),需手工 Edit 同步改 camelCase(**~86+ 处**,R1 fix MED-B 修订;原 caller 估 ~37 是低估);+ source code 内额外 prose ~20 处(`tools/index.ts:24/169` / `tools/handlers/adopted-teams-context-block.ts:27/89/90/131/132` / `tools/handlers/spawn.ts:197/437` / `tools/handlers/lead-context-block.ts:98` / `tools/handlers/send.ts:7/11/80`)需一并改(Step 3.1+3.2)
6. **breaking change release timing** — 本 plan 改完 commit + push 后,下次 user 启动应用调 mcp tool 必须用新 camelCase 入参,旧 caller(若有第三方 mcp client / 文档残留旧示例)调用立即报错。release note 必须 prominent 警告;**特别 hand_off_session 中途 caller 用 snake_case 调老 mcp tool**:caller cold start 老 session 接旧 plan 走 hand_off 时若用 snake_case 调用 → schema reject + caller fail-fast(symptom:`mcp tool args invalid: Unrecognized key(s)` error message),user 需重启 Claude Code CLI 让新 system prompt 注入新 camelCase tool description
7. **SQLite 列名 / mcp tool 函数名 / plan frontmatter 三类不能改**(R1 fix HIGH-C / MED-C 综合扩展):
    - a. SQLite 列名 / DB schema 字段(`sessions.session_id` 等 ~70+ 处 alias.col + `'team_id'` 等 ~11 处 SQL parameter binding string literal)
    - b. mcp tool 函数名(15 tool 名:`archive_plan` / `hand_off_session` / `enter_worktree` / `task_create` 等 — wire-level identifier)
    - c. plan workflow frontmatter 字段(9 字段:`plan_id` / `created_at` / `base_commit` / `base_branch` 等 — archive_plan / hand_off_session 按 snake_case key 读)
    - d. owner_session_id(R1 fix LOW-B):虽是 mcp tool 字段名形式但不在 zod input schema(仅注释 prose 提及 SQL UPDATE 描述)
   - 三层防线(详 §SQLite 列名 / mcp tool 函数名 / plan frontmatter 三类误伤排除策略):sed pattern 前缀约束 + 每批 git diff audit + typecheck/vitest 双保险
8. **enum field name 与 enum value 独立** — `status_filter` 字段名改 `statusFilter`,但 enum value `'active'` / `'dormant'` / `'closed'` / `'all'` 不动(同理 `adapter_filter` / `team_id_filter` / `team_task_policy` / `claude_code_sandbox` / `codex_sandbox` / `permission_mode` 等)。zod schema 内字段名 / 值在两个独立 layer,改字段名不影响 enum value 解析
9. **macOS BSD `sed -E` 不识别 PCRE 记号 `\s` / `\w` / `\b`**(R1 fix HIGH-E:R1 reviewer-codex printf mini-test 实测 5 测全过证明)— 必须改 POSIX ERE `[[:space:]]` / `[[:alnum:]_]` / 显式前后缀 `[^_[:alnum:]]`(详 §sed pattern §⚠ 关键修正)。否则 Pattern 1/2 不匹配真实代码完全 no-op + Pattern 3/4 `[^.\w]` 误伤 `xxx_session_id` → `xxx_sessionId` 双重 bug
10. **改名范围漏 handler 外运行时代码**(R1 fix HIGH-F + R3-L-H3 修法回滚):`tools/index.ts:132/138/140` makeCtx 函数签名 + body args 消费 + `schemas.ts:646` HAND_OFF_SESSION_ARGS_SCHEMA refine 内 args.adopt_teammates / args.team_name 消费 — 这些**不**在 Pattern 2 `handlers/*.ts` glob 内,必须独立处理(详 §sed pattern §Pattern 2 + §步骤 Step 3.1+3.2 改动范围 e/f/g);**R3-L-H3 教训**:R1 reviewer-claude L-M3 finding 实测错(说 L132 注释 / L140 type 闭括号),R2 fix 跟着改 138/143/145 反向错,R3 reviewer-claude 重新现场 Read 实测 R1 原版 132/138/140 才对;实施时**必现场 Read verify 真实行号**,reviewer finding 不要无脑信
