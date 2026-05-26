# CHANGELOG_123 — archive_plan tool UX 完善 4 项 followup (a)+(b)+(c)+(d)

## 概要

REVIEW_44(plan archive-plan-content-overwritten-fix-20260515 收口)留 4 条同主题 followup 一次性收口,**全部属 archive_plan tool UX 完善范畴**(default 路径 / INDEX append 行为 / INDEX 列数错位 / 7 phase GENERIC hint)。3 轮异构对抗 review × fix 收口(R1 deep review 0 HIGH + 5 真 MED + 1 polish + 1 反驳;R2 复查双方 ack + 0 HIGH/MED + 共识 LOW polish 2 项合进)。详 [plan archive-plan-tool-ux-followup-20260515.md](../plans/archive-plan-tool-ux-followup-20260515.md)。

**baseline**:vitest 638 → 652 全 pass(+14 case 守门)+ typecheck 通过。

## 4 项主 fix(Phase 1-2 异构对抗设计 → 落地)

### (a) fallback 链加 `<main-repo>/plans/<id>.md` 中间档

`archive-plan-impl.ts:225-265` step 5 解析 plan 文件路径优先级:`<main-repo>/.claude/plans/<id>.md` > **`<main-repo>/plans/<id>.md`**(新加)> `~/.claude/plans/<id>.md`。本项目所有 stub plan 实际都直接创在 `<main-repo>/plans/`(与 user CLAUDE.md §Step 2 文档约定的 `.claude/plans/` 优先有差异);加中间档让 caller 不传 plan_file_path 时本项目 stub plan 自动找到。

### (b) INDEX smart update + changelog_id arg + return shape 升级

- **schema 加 `changelog_id`**(`schemas.ts:218-228`):optional string + csv regex `/^\s*\d+(\s*,\s*\d+)*\s*$/`,caller 显式传 X 数字(单值 `"122"` / 多值 `"121,122"` / `"121, 122"`含空格亦合法)
- **INDEX smart update**(`syncPlansIndex` helper):行级匹配锚定行首 `^| [<plan_id>.md](`,canonical rewrite 4 列;不存在 plan_id 行 → append 4 列;INDEX 不存在 → 创建 4 列 header + 4 列 row
- **caller 不传 changelog_id 降级**:已有 4 列 row 保留原 changelog 列(α fallback);旧 2 列 row 或新 append 用 `—` placeholder(β fallback);**严禁强制清空已有**避免数据丢失
- **return shape 升级**:`plansIndexAppended: boolean` → `plansIndexAction: 'created'|'appended'|'updated'|'unchanged'` 四态 enum
- **`warnings: string[]` 字段**:non-fatal warning 收集(silent override 等场景)

### (c) INDEX 4 列 canonical 格式 + escape

- **4 列 header**:`| 文件 | 状态 | 关联 changelog | 概要 |` + 4 列 row `| [X.md](X.md) | completed | <changelog ref or "—"> | <description> |`
- **`escapeTableCell` helper**:description / changelog 列 escape `\|` + 换行(`replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')`)防 frontmatter 破表
- **`formatChangelogCell` helper**:caller 传 `"122"` → `[122](../changelog/CHANGELOG_122.md)`;`"121,122"` → 两个 link 用 ` / ` 分隔

### (d) 7 phase 专用 phaseHint 措辞

`postFfMergeErr` 7 个 phase(`rev-parse-HEAD` / `mkdir-plans-dir` / `write-archived-plan` / `sync-plans-INDEX` / `unlink-original-plan` / `git-add` / `git-commit`)各加 ~3 行 cleanup 决策树(替代旧通用 GENERIC hint)。给具体 manual recovery 步骤(`git -C <main-repo> rev-parse HEAD` / `mkdir -p` / `rm` / `git add ...` 等)。

## R1 fix(0 HIGH + 5 真 MED + 1 polish + 1 反驳)

R1 双方异构 reviewer 对抗给出的 finding 全修:

1. **HIGH-1 plan_file_path stem != plan_id 守门**(claude 单方 + lead 现场代码追踪验证):impl 层 `path.basename(planFilePath, '.md') !== planId` → reject + clear hint(防 step 12 silent unlink caller 文件)
2. **HIGH-2 silent override warn**(双方独立 HIGH 共识):`.claude/plans/<id>.md` 与 `<main-repo>/plans/<id>.md` 同 id 双存 + caller path != archivedPath → push warning(用户决策 Q1:不 reject 只 warn)
3. **codex MED-1 旧 2 列 INDEX header 升级**:`upgradeIndexHeader` helper 自动 detect `| 文件 | 概要 |` + `|---|---|` → 升级 4 列 canonical(idempotent + 保守 detect 防误改)
4. **MED-2 共识 retry-invariant prefix**:`postFfMergeErr` 自动给 phaseHint override 路径加 `POST_FF_MERGE_RETRY_INVARIANT_PREFIX`「Cannot retry archive_plan as a whole」(GENERIC fallback 自含,不重复)
5. **claude MED-3 schema regex 放松**:`/^\d+(,\d+)*$/` → `/^\s*\d+(\s*,\s*\d+)*\s*$/`(容空格,与 helper trim 对齐)
6. **codex MED-3 / claude MED-4 polish**:`oldCols[2]` 仅读 changelog 列 invariant 注释 + 守门 case(防未来扩展 `oldCols[3+]` 撞 escape pipe race)
7. **codex LOW-1 / 文档同步**:`resources/claude-config/CLAUDE.md` archive_plan 节字段 `plans_index_appended` → `plans_index_action` + `warnings`
8. **codex LOW-2 / claude LOW-3 schema 校验 case**:6 个 changelog_id zod parse case(invalid `"abc"` / `"122,abc"` reject + valid `"121,122"` / `"121, 122"` / `" 122 "` / `"122"` / omitted 通过)
9. ❌ **claude MED-1 反驳**:'unchanged' + git-commit "nothing to commit" 死锁 — `status: in_progress → completed` 必产生 archivedPath frontmatter diff,死锁不可达。**未加 fix**(反驳依据成立)

## R2 复查 ack(双方共识)

R2 双方 reviewer 对抗复查 R1 fix:**0 HIGH + 0 MED + 共识 LOW(全 polish 不阻塞)+ codex 明确「ack 收口推荐 Phase 4」**。R1 6 项 fix 100% 修对 + 0 新问题 + 漏修判断成立。R2 polish 2 项已加:

- **codex R2 LOW-2 / claude R2 LOW-5 共识**:加 escape-aware 守门 case(老 4 列 row description 含 escaped `\|` 仍正确读 `oldCols[2]` changelog 列)
- **codex R2 LOW-1 单方**:多 table INDEX 边角 — invariant 注释「`upgradeIndexHeader` 假设 INDEX 单 table」(本应用约定不支持多 table INDEX)

## 改动文件 + 新增 case

| 文件 | 说明 |
|---|---|
| `src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts` | 主 impl(+352 line):4 项 fix + 3 helper(`syncPlansIndex` / `escapeTableCell` / `formatChangelogCell`)+ `upgradeIndexHeader` + `POST_FF_MERGE_RETRY_INVARIANT_PREFIX` + `warnings` 字段 + 7 phase hint inline |
| `src/main/agent-deck-mcp/tools/handlers/archive-plan.ts` | handler 透传 `changelog_id` arg + return shape 改 `plans_index_action` + `warnings` |
| `src/main/agent-deck-mcp/tools/schemas.ts` | `ARCHIVE_PLAN_SCHEMA.changelog_id` 加 + `plan_file_path` describe 同步 + `ArchivePlanResult` interface 改 |
| `src/main/agent-deck-mcp/tools/index.ts` | mcp tool description 同步 4 列 INDEX + `plans_index_action` enum + `warnings` 字段 |
| `resources/claude-config/CLAUDE.md` | app-only `archive_plan` 节字段 + 4 项 followup UX 完善说明 |
| `src/main/agent-deck-mcp/__tests__/archive-plan.impl-core.test.ts` | 改 5 case 适配新 type(plansIndexAction 替代 boolean)+ 重写「plan_id 已在 INDEX → smart update」case |
| `src/main/agent-deck-mcp/__tests__/archive-plan.impl-r33.test.ts` | 改 2 case(stem refine 守门 + rev-parse-HEAD phase hint 改专用) |
| `src/main/agent-deck-mcp/__tests__/archive-plan.impl-ff-merge-body.test.ts` | 改 1 case summaryColumnRegex 4 列改造 |
| `src/main/agent-deck-mcp/__tests__/archive-plan.impl-followup-20260515.test.ts` | **新加 50 case 守门 11 项主 fix + R1/R2 fix**(含 helper 单测 / fallback 链 / stem refine / silent override warn / 4 列 row / changelog_id csv / α+β fallback / 7 phase hint / schema parse / header upgrade / retry-invariant prefix / escape-aware invariant) |

## baseline

- vitest 全套:**638 → 652 pass**(+14 case)+ 64 skip(SQLite native binding,与 fix 无关)+ 0 fail
- typecheck 全套:pass

## 已知未修(approved 反驳 / polish 接受)

- **claude R2 LOW-1 writeCallCount 隐性顺序**:`sync-plans-INDEX failure case` 用 `writeCallCount === 1` 假设 step 10b 在 step 11 之前。当前 impl 顺序固定符合假设,真问题需未来重构 impl 时修。LOW polish 不阻塞
- **claude R2 LOW-2 retry-invariant prefix grep 解析**:caller 若 `grep '^Manually'` 锚定行首 → 命中 prefix 而非 phaseHint。hint 是给人看的不应做严格 grep。LOW
- **claude R2 LOW-3 silent-override warn 多行可读性**:warn message 单字符串挤了 (1)(2)(3)。caller 终端宽度自然换行。LOW
- **claude R2 LOW-4 mcp tool description 'unchanged' 语义**:tools/index.ts:133 列 4 态 enum 但没解释 'unchanged'。impl jsdoc:84 + schema describe:225 已解释,SSOT 充足。LOW

## 关联

- 父 plan(REVIEW_44 收口):[archive-plan-content-overwritten-fix-20260515.md](../plans/archive-plan-content-overwritten-fix-20260515.md)(CHANGELOG_122)
- 兄弟 plan(本轮也建):[mcp-server-hot-reload-investigation-20260515.md](../plans/mcp-server-hot-reload-investigation-20260515.md)(本 plan 收口 dogfooding 撞同款 mcp server 不 hot reload 问题)
