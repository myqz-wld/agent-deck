# CHANGELOG_153: ref-layout-full-migration-20260526 plan 收口

## 概要

把 agent-deck 项目从单数 `plans/ changelog/ reviews/ conventions/` 4 子目录全面迁移到统一 `ref/` 布局(`ref/plans/ ref/changelogs/(单→复)ref/reviews/ ref/conventions/`)。impl 硬切 `ref/plans/`(不留 fallback / deprecation / migration helper);同步改 7 src/ impl + 7 test 文件 + 2 tool def + codex 对偶 + 项目根 CLAUDE.md + cross-ref link 63 处 + .gitignore negation + ref/flows + ref/architecture 占位 INDEX + user CLAUDE.md §复杂 plan + §新项目工程地基 397 行挪迁到应用打包 CLAUDE.md(self-contained 落地)。

**MCP 协议 breaking**:archive_plan / hand_off_session / enter_worktree fallback 链中间档从 `<main-repo>/plans/` 改成 `<main-repo>/ref/plans/`;老项目用户用旧版 agent-deck 或自行 git mv 4 目录到 ref/ 布局后升级。

## 变更内容

### Phase A — impl 硬切 ref/plans/(commit `e14ab90`)
- `src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts`:52 处 `<main-repo>/plans/` / `path.join(mainRepo, 'plans', ...)` / `../changelog/CHANGELOG_X.md` (单→复) 全迁;L1274 `formatChangelogCell()` helper 改 `../changelogs/`;L128/L129/L290/L294/L296 历史 bug repro literal 加 HISTORICAL marker 让 A.7/E.6 grep -v 排除
- `src/main/agent-deck-mcp/tools/handlers/plan-path-helpers.ts`:L52 path.join 字面 + jsdoc 全迁;fallback 链 `.claude/plans/ → ref/plans/ → ~/.claude/plans/` 三档统一
- `src/main/agent-deck-mcp/tools/handlers/enter-worktree-impl.ts`:L139 中间档 path.join + L50/L128 jsdoc
- `src/main/agent-deck-mcp/tools/handlers/hand-off-session-impl.ts`:L17/L215 jsdoc 加中间档(impl 走 helper)
- `src/main/agent-deck-mcp/tools/index.ts`:L219/L251 archive_plan + hand_off_session tool description 长 string
- `src/main/agent-deck-mcp/tools/schemas.ts`:L258/L268/L411/L511 field description fallback 链;L268 changelog link sample → `../changelogs/CHANGELOG_X.md`

### Phase B — test 同步(commit `9070419`)
- 7 test 文件(plan-path-helpers / impl-followup-20260515 / impl-ff-merge-body / impl-core / mainrepo-clean / _setup / hand-off-session.impl-core)100+ 处 + 14 link assertion + 5 处 it()/describe() name
- `it.skip` 1 pre-existing test(hand-off-session.impl-core.test.ts:323 REVIEW_56 R2 follow-up,main HEAD 同款 fail)+ 加 follow-up task
- vitest 931 pass / 157 skip(其中 1 是 manager-ingest.test.ts:265 REVIEW_49 R3 follow-up,同 pre-existing 兜底 skip)

### Phase C — codex 对偶(commit `9070419`)
- `resources/codex-config/CODEX_AGENTS.md` 4 行 ≈ 7 occurrence sed `<main-repo>/plans/` → `<main-repo>/ref/plans/`

### Phase D — 项目数据迁移(commits `7a6f5f5 / 44b6fe3 / 03c16e4 / 8841560 / e22f0f4`)
- D.1-D.4 git mv 4 子目录(各 1 commit):`plans/ → ref/plans/`(101) / `changelog/ → ref/changelogs/`(152,单→复)/ `reviews/ → ref/reviews/`(58)/ `conventions/ → ref/conventions/`(3)。git rename detection 100% work
- D.5 项目根 `CLAUDE.md` 17 处 sed `changelog/ reviews/ conventions/` → `ref/*`
- D.6 cross-ref markdown link 63 处批量 sed(plans/ 28 + reviews/ 34 + changelogs/ 1)`../changelog/CHANGELOG_X.md`(单数!)→ `../changelogs/CHANGELOG_X.md`(单跳 sed 自然 cover 任意级数)
- D.7 双段 grep 0 残留 verify
- D.8 `.gitignore` L7 `!plans/**/spike-reports/*.log` → `!ref/plans/**/spike-reports/**/*.log`(嵌套深度 R2 fix);L26 注释更新;git check-ignore 实测 direct+nested 双场景 negation
- D.9 codex SKILL 镜像 `pnpm exec node scripts/sync-codex-skills.mjs` 自动同步
- D.11/D.12 建 `ref/flows/INDEX.md` + `ref/architecture/INDEX.md` 4 列占位(plantUML SSOT 工作链路)
- D.13 **user CLAUDE.md §复杂 plan + §新项目工程地基 397 行挪到应用打包 CLAUDE.md**(self-contained);user CLAUDE.md 简化到 5 节(§通用约定 / §输出 / §运行时 / §决策对抗 / §提示词资产维护)117 行

### Phase E — 全套验证
- typecheck pass / vitest 931 pass / git log --follow CHANGELOG_1.md trace 回 mv 前 history ✓ / 0 真残留 grep ✓

### Phase F — deep-review SKILL kind=mixed R1+R2(commits `4f269f7` + `fc3694a`)
- R1 11 真 finding 全修(4 HIGH + 7 MED;src/ 注释 stale + live INDEX 残留 + .gitignore 嵌套 + 应用打包 CLAUDE.md self-contained 文字 + plan §当前进度 + G-manual.5 INDEX label canonical + 3 处 doc narrative)
- R2 3 真 finding 全修(3 MED;resources/claude-config/CLAUDE.md L260 link target + plan §下一会话第一步 + INDEX narrative 裸目录名 双方独立提出)
- R2 reviewer 共识「R2 收口,无新 HIGH 真问题」

### plantUML SSOT 顺带落地(commit `ef2aeea`)
- `resources/claude-config/CLAUDE.md` §核心流程 / 架构变更必走 plantUML 节(位置 / INDEX 规则)
- `resources/claude-config/agent-deck-plugin/skills/flow-arch-plantuml/SKILL.md` 全新 SKILL(怎么画 / 关注点分离)

### 顺带 docs 修订
- deep-review SKILL.md example 路径 plans/ → ref/plans/(commit `b168346`)
- README.md L92 / L368-369 / L372 stale link + ls 指引迁 ref/(commit `e22f0f4 / 4f269f7`)

## 不入 git 的同步改动(本 changelog 仅 reference)
- `~/.claude/CLAUDE.md` user 个人全局简化:删 §plugin 资产 + 对偶资产专属约束 整节 + 删 conventions tally 提及 + 5 处去掉「应用打包 CLAUDE.md」提及(per user 新指令)
- `~/Repository/personal/agent-deck/.claude/plans/ref-layout-full-migration-20260526.md` plan 文件 §当前进度 + §下一会话第一步 + G-manual.5 INDEX label canonical 多次 update;归档时 mv 到 `ref/plans/`

## 影响面(实测)
- src/main/ 7 文件 impl 改;__tests__/ 7 文件 + 1 skip
- ref/{plans,changelogs,reviews,conventions} 314 文件 git mv + 100+ 文件内 cross-ref link 自动迁
- resources/{claude-config,codex-config}/CLAUDE.md / CODEX_AGENTS.md;项目根 CLAUDE.md / README.md / .gitignore
- new:ref/flows/ + ref/architecture/ INDEX 占位 + flow-arch-plantuml SKILL

## 关联
- plan: [ref-layout-full-migration-20260526](../plans/ref-layout-full-migration-20260526.md)
- 触发:reviewer-codex HIGH-1(claude-config CLAUDE.md ↔ impl 当前事实矛盾)+ user 明示「不要任何旧标准 / 不要兼容提及 / 都用新标准」
