---
plan_id: ref-layout-full-migration-20260526
created_at: 2026-05-26
worktree_path: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/ref-layout-full-migration-20260526
status: completed
final_commit: eb379b6ec4bba2f3ba94e3a1db9dea808188d125
completed_at: 2026-05-26T12:47:19Z
base_commit: ef167940809bd22904a8f1bdd810f0cf8d02ace4
base_branch: main
---

# Plan: agent-deck 全面迁移到 ref/ 统一目录布局

## 总目标

应用 impl + 项目自身数据 + 全部对偶资产 1:1 迁移到 ref/ 统一目录布局(`ref/changelogs/` `ref/reviews/` `ref/plans/` `ref/conventions/`),消除 reviewer-codex HIGH-1 暴露的文档与 impl 矛盾,**当前事实硬切到新标准**。

**Why**:
- ref/ 统一目录已成新约定(user CLAUDE.md / claude-config CLAUDE.md 都按新标准写完);impl 仍硬编 `'plans'` 导致文档与运行时行为矛盾(reviewer-codex HIGH-1 铁证)
- 用户明示「**不要任何旧标准的东西,不要兼容提及**」— 硬切新标准,不留 fallback / deprecation / migration helper

**如何应用**(给下一会话):cold-start `Bash: cat <plan-abs-path>` 全文 → frontmatter 取 worktree_path → `EnterWorktree(path: <worktree_path>)` → 按 §下一会话第一步 接力

## 不变量

1. **impl 硬切 ref/plans/** — `path.join(mainRepo, 'plans', ...)` → `path.join(mainRepo, 'ref', 'plans', ...)`,**不**加 fallback 不加 deprecation
2. **文档 ↔ impl 1:1 一致** — claude-config CLAUDE.md / CODEX_AGENTS.md / tools/index.ts schema description / tools/schemas.ts field description / user CLAUDE.md §Step 4 全部 ref/plans/
3. **agent-deck 项目自身 git mv 4 子目录到 ref/** — `plans/ → ref/plans/` `changelog/ → ref/changelogs/`(单数→复数)`reviews/ → ref/reviews/` `conventions/ → ref/conventions/`
4. **每个 fix 必有同步测试** — 改 impl 同步改 __tests__ 命中点;改后跑全 vitest pass
5. **typecheck + build + vitest 全 pass** 是收口前置条件
6. **不留任何「兼容旧布局 / 老项目 / fallback / migration」描述**(user 硬指令)
7. **跨文件 link + .gitignore + helper 硬编路径必须随 ref/ 迁移同步**(R1 deep-review HIGH-1/2/3 共同根因):
   - `.gitignore !plans/**/spike-reports/*.log` exception → `!ref/plans/**/spike-reports/*.log`(否则 mv 后新归档 spike .log 被全局 `*.log` 过滤永久丢失);`.gitignore` 注释提及「顶级 plans/<plan-id>.md」也要改 `ref/plans/<plan-id>.md`
   - **跨文件 markdown link 批量替换**:`../changelog/CHANGELOG_X.md`(单数!)→ `../changelogs/CHANGELOG_X.md`,实测 `plans/` 28 处 + `reviews/` 34 处 = **62 处批量** sed,**不能** 靠「相对路径不变」幻觉跳过(reviews 名字不变 ✓ / changelog→changelogs 改名 ✗)
   - **helper 函数硬编路径**:`archive-plan-impl.ts:1260-1274 formatChangelogCell()` 生成 `[X](../changelog/CHANGELOG_X.md)` link 写入 INDEX 第 3 列;同款 `tools/schemas.ts:268` field description 含 sample link;同步改 + ~14 处 test assertion(`archive-plan.impl-followup-20260515.test.ts` 内 `expect(formatChangelogCell(...))` 等)
8. **Phase G 收口顺序**(R1 deep-review HIGH-4):**先**写 `ref/changelogs/CHANGELOG_X.md` + git commit changelog,**再**调 `archive_plan({changelog_id: X})`。schema 契约要求 caller 在 archive_plan 前 changelog 已 commit;且 archive_plan 默认归档 caller session,放在 changelog commit 后是不可逆终点
9. **codex SKILL 镜像由 build-time 同步**(R1 deep-review MED-2):`resources/codex-config/agent-deck-plugin/skills/` 是 build-time 镜像(不入 git),由 `scripts/sync-codex-skills.mjs` 从 SSOT `resources/claude-config/agent-deck-plugin/skills/` 生成;npm `predev` / `prebuild` hook 自动跑。本 plan 改 SSOT 后必须 `pnpm exec node scripts/sync-codex-skills.mjs` 触发同步,否则 codex 端镜像仍持旧路径
10. **dog-fooding 必须重启 dev 让新 impl 生效**(R2 deep-review HIGH-2 + R4-H2 修订 — 仅 **§Phase G-tool 路径专属**,§Phase G-manual 路径不调 archive_plan tool 不需此约束):Phase A 改的 `archive-plan-impl.ts` / `plan-path-helpers.ts` / `enter-worktree-impl.ts` / `hand-off-session-impl.ts` 都是 main 进程代码;archive_plan tool 是 in-process mcp tool,调用的是**当前运行的应用 mcp server impl**(由启动 dev 时所在 cwd 的 src/build 产物决定)。**仅当 user 选 G-tool 路径**(dog-fooding archive_plan tool),才需:① pkill 旧 electron-vite dev + 已装 .app 进程 ② 在 worktree cwd `pnpm dev` 重启 ③ `lsof -p $PID -d cwd` 确认新 dev 进程 cwd 在 worktree(macOS ps 不显示 cwd 列,必须用 lsof);**G-manual 路径**绕过 archive_plan tool(走 user CLAUDE.md §Step 4 5 步手工),不需重启 dev。**死锁警示**:本会话(.app 内)走 G-tool 必须 pkill .app → 终结本会话 — 必须 user cold-start dev mode 新会话走 G-tool(详 §Phase E.0 + §已知踩坑「dog-fooding 死锁」)
11. **sed 命令统一 macOS BSD 形态**(R2 deep-review MED-3):本仓库 macOS 环境,所有 sed inline 编辑用 BSD 形态 `sed -i '' -e 's|...|...|g' <file>`(空字符串作为 backup suffix);**严禁** GNU 形态 `sed -i 's|...|...|g'`(macOS BSD sed 会把 pattern 当 backup suffix 处理生成意外文件)。Phase D.5 / D.6 等 sed step 全用 BSD 形态;`find -exec sed` 同款
12. **Phase D mv 边界 — 仅项目根级 4 子目录,不动 `.claude/plans/`**(R4 INFO-3):Phase D.1-D.4 仅 git mv 项目根级 `plans/ changelog/ reviews/ conventions/` 4 子目录到 `ref/`,**不动** `<main-repo>/.claude/plans/` 内的 in-progress plan 文件(`.gitignore` 已忽略该目录;plan 实施期间本 plan 文件持续在 `.claude/plans/` 路径,§下一会话第一步 cold-start cat 路径不变);仅 §Phase G-tool.4 / G-manual.5 才把本 plan 文件 mv 到归档位置 `<main-repo>/ref/plans/`
13. **核心流程 / 架构变更必走 plantUML**(本会话新加,在本 plan 范围内捎带建 `ref/flows/` + `ref/architecture/` 两子目录):应用打包 CLAUDE.md `resources/claude-config/CLAUDE.md` §核心流程 / 架构变更必走 plantUML 节定**位置 + INDEX 规则**;`resources/claude-config/agent-deck-plugin/skills/flow-arch-plantuml/SKILL.md` 定**怎么画**(关注点分离)。本 plan **实施时**(详 §Phase D.10/D.11)在 worktree 内建 `ref/flows/INDEX.md` + `ref/architecture/INDEX.md` 占位(空 4 列表头),后续真画图时由 SKILL append 行。**本会话已在 main working tree 改 SSOT**(`resources/claude-config/CLAUDE.md` 加 plantUML 节 + 新建 `resources/claude-config/agent-deck-plugin/skills/flow-arch-plantuml/SKILL.md`),plan 实施时需 stash + worktree 内 pop 带过去(详 §Phase Pre-A + §已知踩坑)
14. **应用打包 CLAUDE.md self-contained — user CLAUDE.md 关键工程实践节挪到应用 CLAUDE.md**(本会话 user 新需求):应用打包 CLAUDE.md(`resources/claude-config/CLAUDE.md`)inline 全部关键工程约定(`复杂 plan` workflow / `新项目工程地基` / `ref/ 布局双轨` / `已审文件过期` / `单文件大小护栏` / `反复反馈 / 反复踩坑 升级约定` 等),**不依赖** user CLAUDE.md(`~/.claude/CLAUDE.md`)。**理由**(详 §提示词资产维护 约束 6 plugin 资产专属约束):应用 SDK 会话可能没加载 user CLAUDE.md(典型: oneshot SDK 不加载 settingSources / 其他用户不一定有同款 user CLAUDE.md / 应用打包 = self-contained);plugin 资产必须 inline 关键操作。**本 plan 实施时**(详 §Phase D.13)挪 user CLAUDE.md §复杂 plan + §新项目工程地基 全节到应用 CLAUDE.md;user CLAUDE.md 这两节删(或保留概要 + reference 到应用打包)

## 设计决策(不再争论)

### D1: impl 硬切策略(RFC Q1 答 = A)

`archive-plan-impl.ts` / `plan-path-helpers.ts` / `enter-worktree-impl.ts` / `hand-off-session-impl.ts` 内**所有** `path.join(mainRepo, 'plans', ...)` 改成 `path.join(mainRepo, 'ref', 'plans', ...)`。

- **不**加 fallback 检测 `ref/plans/` 是否存在
- **不**加 deprecation warning 给老项目用户
- **不**加 manifest / 配置文件

**Why**: user 明示「不要兼容提及」+ agent-deck 自身同 plan 内迁移(D2),消除所有旧布局存在。

### D2: agent-deck 项目自身 git mv(RFC Q2 答 = A,Q3 答 = A)

本 plan 内一次性 `git mv` 4 子目录:
- `plans/ → ref/plans/`(101 文件 + 6 个 spike-reports/ 子目录)
- `changelog/ → ref/changelogs/`(152 文件)— **注意 changelog 单数 → changelogs 复数**
- `reviews/ → ref/reviews/`(58 文件)
- `conventions/ → ref/conventions/`(3 文件)

git rename detection 默认 50% 相似度,文件内容不变直接 mv,history 通过 `git log --follow <file>` 保留。

### D3: changelog → changelogs 命名(已确定)

全 4 子目录统一复数命名(`changelogs/` `reviews/` `plans/` `conventions/`),消除单复数混搭。**改名,不是 mv**:`git mv changelog ref/changelogs` 单步原子完成(rename detection 触发)。

### D4: 不向后兼容(RFC Q3 答 = A)

新版 agent-deck 跑在老项目(仍 plans/ 布局)上 → archive_plan tool 找不到 `<main-repo>/ref/plans/` 直接 error。**接受 break**。
老项目用户用旧版 agent-deck;升级前自行 git mv 4 目录。

### D5: deep-review 两轮独立(RFC Q4 答 = C)

- **§Step 1.5**(plan 评审):本 plan 写完后 invoke deep-review SKILL `kind='plan'`,scope = 本 plan 文件
- **§Step 5**(实施评审):实施完后(所有 impl + test + git mv 完成后)invoke deep-review SKILL `kind='mixed'`,scope = 改动文件清单 + 本 plan

### D6: claude-config CLAUDE.md 已撤回到 ref/plans/

本会话已撤回前轮误回滚的 4 处 `plans/` → `ref/plans/`(已删 callout)。**这是 plan 实施前的 baseline 状态**;plan 步骤不再改 claude-config CLAUDE.md。

## 影响面 spike(已实测 — R1 deep-review 后精确化)

> R1 deep-review 实测命中数(wc -l),与初版「~30 处 / ~40 处」估计严重不符,本节按实测数据重写。

### A. src/ 硬编路径(**精确化:R4 reviewer-claude-fresh wc -l 实测 archive-plan-impl.ts 52 处**)

- `src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts` — **实测 52 处**(R4-H3 修正,前几轮 v1-v3 报 ~10 → 24 → 24 全部低估;R4 reviewer-claude-fresh `grep -nE "['\"]plans['\"]|<main-repo>/plans|/plans/" archive-plan-impl.ts | wc -l` 命中 52 行);包含 path.join 字面值 / 注释 / jsdoc / hint message / `formatChangelogCell` L1260-L1274 helper / 历史 bug 复现 reference 等。**实施时**:A.1 先跑该 grep 拿完整行清单,**逐行分流判断**:必改 / HISTORICAL 白名单 / 已是 ref/plans/ 新形态(详 Phase A.1)
- `src/main/agent-deck-mcp/tools/handlers/plan-path-helpers.ts` — R2 HIGH-3 行号补全:实测 L8 / L10 / L11 / L33 / L35 / L37 jsdoc + L52 `path.join`
- `src/main/agent-deck-mcp/tools/handlers/enter-worktree-impl.ts` — R3 HIGH-3 修正:**L138 / L139 / L140 三档 path.join 全在**;L138 / L140 是 `.claude/plans/` / `~/.claude/plans/` 不变档;**L139 中间档 `path.join(mainRepo, 'plans', ...)` 必改 `path.join(mainRepo, 'ref', 'plans', ...)`**;jsdoc L50 / L128
- `src/main/agent-deck-mcp/tools/handlers/hand-off-session-impl.ts` — R2 HIGH-3 行号补全:L17 / L215 jsdoc;L17 fallback 链需加 `<main-repo>/ref/plans/` 中间档
- `src/main/agent-deck-mcp/tools/index.ts` — archive_plan tool description(L219 一行长 string,8+ 处 `plans/`)+ hand_off_session tool description(L251 一行长 string,3+ 处 `plans/`)
- `src/main/agent-deck-mcp/tools/schemas.ts` — **R1 MED-1 + R2 MED-3 扩列**:
  - L258 / L511 plan_file_path field description fallback 链
  - **L268** changelog_id field description sample link → `../changelogs/`
  - **L411** hand_off_session plan_file_path field description 加 `<main-repo>/ref/plans/` 中间档
  - L771 / L780 jsdoc

### B. test 影响面(**精确化:实测 100 处 + ~14 处 link assertion**)

实测(`grep -cE "plans/|<main-repo>/plans|'plans'"`):

| 文件 | 初版报 | **实测命中** | 备注 |
|---|---|---|---|
| `__tests__/plan-path-helpers.test.ts` | 13 | **9** | 包含 `${MAIN_REPO}/.claude/plans/` 临时位置不变 + `${HOME}/.claude/plans/` 跨项目位置不变 — 实际需改 6-7 |
| `__tests__/archive-plan.impl-followup-20260515.test.ts` | 20+ | **19** | 含 fallback 链测试 case 描述 + path.join + 期望路径 |
| `__tests__/archive-plan.impl-ff-merge-body.test.ts` | 3 | **10** | 初版严重低估 ≈ 3.3x |
| `__tests__/archive-plan.impl-core.test.ts` | 3 | **17** | 初版严重低估 ≈ 5.7x;含 spike-reports 子目录路径 L257/L258/L301/L306 + 多 assertion |
| `__tests__/archive-plan.mainrepo-clean.test.ts` | 1 | **42** | **初版严重低估 ≈ 42x!**实际是 mainrepo dirty 关键 test 含大量 `plans/INDEX.md` mock path |
| `__tests__/archive-plan/_setup.ts` | 1 | **3** | 含 `expectedArchivedPath` |
| **合计** | ~40 | **100** | 实际 2.5x |

**R1 HIGH-2 link assertion**:`archive-plan.impl-followup-20260515.test.ts` 内 ~14 处 `expect(formatChangelogCell(...))` assertion 形如 `'[122](../changelog/CHANGELOG_122.md)'`(L313/L336/L363/L372/L394/L475/L480/L486/L500/L505/L537/L544/L551/L555/L558/L923/L932 等)— D3 改名后全部同步改 `../changelogs/`(初版 §B 完全没列)。

### C. codex 对偶(`resources/codex-config/CODEX_AGENTS.md`,**精确化:实测 ≈ 7 处 occurrence 跨 4 行**)

- L145 — archive_plan 5 步原子操作:**3 处** `plans/`(plan_id.md + spike-reports 路径 + INDEX.md)
- L157 — spike-reports/ 自动归档目标路径:**1 处** `plans/<plan_id>/spike-reports/`
- L159 — fallback 链 `<main-repo>/.claude/plans/` > `<main-repo>/plans/` > `~/.claude/plans/`:**1 处需改**(中间档),前后两档不变
- L164 — `warnings` 同 id 双存覆盖描述:**1 处** `plans/<id>.md`
- **R1 MED-3 新增 L162**(若存在):INDEX.md 同步描述也含 `<main-repo>/plans/INDEX.md`(确认行号实施时 grep)

**改法**:用 sed `s|<main-repo>/plans/|<main-repo>/ref/plans/|g` 批量(注意 `.claude/plans/` 与 `~/.claude/plans/` 不变档需通过 grep -F 前缀差异区分;改后跑 grep 二次确认)。

### D. agent-deck 项目自身 git mv 范围(实测 314 文件 + 6 个 spike-reports/ 子目录)

- `plans/`(101 文件): `git mv plans ref/plans`,含 6 个 spike-reports/ 子目录(reverse-rename-sid-stability-20260520 / deep-review-batch-a1-b-followup-r3-20260519 / reviewer-codex-cross-adapter-20260519 / add-claude-cli-path-override-and-bump-sdks-20260520 / review-56-followups-20260526 / hand-off-session-adopt-teammates-20260520)
- `changelog/`(152 文件): `git mv changelog ref/changelogs`(单数 → 复数,改名同时迁目录)
- `reviews/`(58 文件): `git mv reviews ref/reviews`
- `conventions/`(3 文件): `git mv conventions ref/conventions`

### E. 项目根 CLAUDE.md 引用更新(**精确化:实测 17 处 — 初版报 10+ 漏列 7 处**)

`/Users/apple/Repository/personal/agent-deck/CLAUDE.md` 实测 `grep -nE "changelog/|reviews/|conventions/| plans/| ref/plans"` 命中 **17 行**:

L24 / L30 / L31 / L33 / L35 / L38 / L39 / L41 / L43 / L45 / L50 / L64 / L146 / L152 / L153 / L157 / L160

(初版仅列 line 24 / 30 / 31 / 33 / 35 / 38 / 39 / 41 / 43 / 45 共 10 处,**漏 L50 / L64 / L146 / L152 / L153 / L157 / L160 共 7 处**)

**改法**:Phase D.5 改用 sed 批量替换(`s|changelog/|ref/changelogs/|g` + `s|reviews/|ref/reviews/|g` + `s|conventions/|ref/conventions/|g`)+ 跟随 grep 验证 0 残留。

### F. cross-ref markdown link 兼容性(**R1 HIGH-3 判定文字修正**)

实测 `grep -rnE "\.\./changelog/CHANGELOG_"`:

- `plans/` 内 `../changelog/CHANGELOG_X.md` 引用:**28 处**(含 plans/INDEX.md 多处 + 其他 plans/*.md)
- `reviews/` 内 `../changelog/CHANGELOG_X.md` 引用:**34 处**
- **合计 62 处批量 sed 替换需求**

**判定**(R1 HIGH-3 修正):
- **reviews → ref/reviews/ 路径变 / 名字不变**:`../reviews/REVIEW_X.md` 相对路径形态**仍 work**(在 ref/ 内部仍平级,目录名一致)
- **changelog → changelogs 名字变 + plans → ref/plans/ 位置变**:`../changelog/CHANGELOG_X.md`(单数!)指向已不存在的目录 → **必须批量 sed 改成 `../changelogs/CHANGELOG_X.md`**;初版 §F 判定「相对路径不变 ✓」**错误**,需 Phase D.6.5 新 step 显式批量替换
- **conventions 3 文件 cross-ref**:同上判定(若引用 `../reviews/` `../changelogs/` 等需检查)

**Phase D.6 grep 验证升级**(R1 HIGH-3):分两段
1. `grep -rnE "\.\./changelog/CHANGELOG_" ref/` 必须返回 **0 行**(无单数 `changelog/` 残留)
2. `grep -rnE "\(changelog/CHANGELOG_|\(reviews/REVIEW_" ref/` 必须返回 **0 行**(无绝对路径形态)— **不能** 用旧 `grep -v '\.\./'` 因为断 link 仍带 `../` 会通过验证

### G. 收口顺序约束(**R1 HIGH-4 — schema 契约 + archive_plan 终点性**)

`src/main/agent-deck-mcp/tools/schemas.ts:268` 明文:「**caller 在 archive_plan 之前已经写完 CHANGELOG_X.md 并 commit**」+ archive_plan 默认归档 caller session(本会话归档后即不可继续跑 shell)→ Phase G 必须先 changelog 后 archive_plan,不能反过来。详 §不变量 8。

### H. plantUML SSOT 改动(本会话已改 main working tree,实施时 stash + worktree 内 pop)

本会话已在 main working tree dirty 改动:

- **改:** `resources/claude-config/CLAUDE.md`(L52 后加新 ## 二级节「核心流程 / 架构变更必走 plantUML」— 定位置 + INDEX 4 列格式 + 与 user 确认机制)
- **新建:** `resources/claude-config/agent-deck-plugin/skills/flow-arch-plantuml/SKILL.md`(定 plantUML syntax + 图类型 + workflow,与 CLAUDE.md 关注点分离)
- **build-time 镜像**(D.9 sync 自动生成,不入 git): `resources/codex-config/agent-deck-plugin/skills/flow-arch-plantuml/SKILL.md` 由 `scripts/sync-codex-skills.mjs` 自动生成

**dirty 处理流程**(详 §Phase Pre-A + §已知踩坑):本 plan 实施会话 user 进 worktree 前 `git stash push -u` 含 untracked,worktree 内 `git stash pop` 把改动带过去 worktree branch 内 commit;后续 Phase D.10/D.11 建 `ref/flows/INDEX.md` + `ref/architecture/INDEX.md` 占位完成 plantUML 工作链路

## 步骤 checklist

### Phase Pre-A: SSOT dirty 迁移到 worktree(若本 plan 实施前 main working tree 含 plantUML skill SSOT 改动)

> 本 plan 实施前若 main working tree dirty(典型场景:本会话 R1.5 阶段已改 plantUML SSOT 详 §影响面 spike H),user 进 worktree 后需把 dirty 迁过去。**正常实施时(main clean)跳过本 phase**。

- [ ] **Pre-A.0 检测 main working tree 是否含 SSOT dirty**:
  ```bash
  git -C /Users/apple/Repository/personal/agent-deck status --short \
    resources/claude-config/CLAUDE.md \
    resources/claude-config/agent-deck-plugin/skills/flow-arch-plantuml/
  ```
  - 0 行 → main clean,跳过 Pre-A 后续 step 直接 §Phase A
  - 非 0 行 → 走 Pre-A.1 stash + 进 worktree + Pre-A.2 pop
- [ ] **Pre-A.1 stash dirty(含 untracked 新文件)**:
  ```bash
  # 关键:新 SKILL.md 是 untracked,git stash 默认不含 — 需要 -u flag 或先 git add -N
  cd /Users/apple/Repository/personal/agent-deck
  git stash push -u -m "plantuml-skill-ssot-for-ref-layout-plan"
  # -u = 含 untracked;-m 加描述方便后续辨识
  ```
- [ ] **Pre-A.2 进 worktree 后 pop stash**:
  ```bash
  # 在 §Step 2 EnterWorktree 后立即跑(worktree cwd):
  git -C /Users/apple/Repository/personal/agent-deck/.claude/worktrees/ref-layout-full-migration-20260526 \
    stash pop
  # 应输出 "Changes not staged for commit" 含两文件
  ```
- [ ] **Pre-A.3 worktree 内 commit SSOT 改动**(让后续 plan A-F 改动建在新 SSOT 基线上):
  ```bash
  WT=/Users/apple/Repository/personal/agent-deck/.claude/worktrees/ref-layout-full-migration-20260526
  git -C "$WT" add \
    resources/claude-config/CLAUDE.md \
    resources/claude-config/agent-deck-plugin/skills/flow-arch-plantuml/SKILL.md
  git -C "$WT" commit -m "feat(skill): add flow-arch-plantuml SKILL + CLAUDE.md plantUML 位置约定"
  ```

### Phase A: impl 改造(应用源码)

- [ ] A.1 改 `src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts` — **R4-H3 实施流程**(实测 52 处,plan v1-v3 报 24 是低估):
  - **先 grep 拿完整行清单**:`grep -nE "['\"]plans['\"]|<main-repo>/plans|/plans/|\.\./changelog/CHANGELOG_" src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts > /tmp/a1-grep.txt`(52 行清单)
  - **逐行分流判断三类**:
    - **(a) impl 路径生成 / jsdoc 行为描述 / hint message**(典型 path.join 字面值 + `<main-repo>/plans/` 注释引用 + L72 INDEX.md jsdoc + L1260-L1274 `formatChangelogCell()` helper 硬编 `[X](../changelog/CHANGELOG_X.md)`)→ **必改** ref/plans/ 或 ../changelogs/
    - **(b) 历史 bug 复现 reference**(grep `H2 现场实测铁证|bug repro literal|status=` 命中行;典型 L128 / L129 / L296 含 `' M plans/INDEX.md\0'.trim()` 字面 bug input)→ **保留旧字面值** + 加 `// HISTORICAL: bug repro literal, do not migrate to ref/plans/` 注释让 A.7 grep 排除
    - **(c) 已是 ref/plans/ 新形态**(R2 修过的 L290 等)→ 跳过
  - **A.1 完成后 spot-check**:从 /tmp/a1-grep.txt 随机 5 行手工 verify 是否按三类分流处理正确(防数据低估同型再发生 — R1-R3 test 文件低估 42x 是先例)
- [ ] A.2 改 `src/main/agent-deck-mcp/tools/handlers/plan-path-helpers.ts` projectArchived 计算(L52 path.join 字面值 `'plans'`)+ jsdoc 描述 — **R2 HIGH-3 行号补全**:实测命中 **L8 / L10 / L11 / L33 / L35 / L37**(plan v1 漏 L11 / L33 / L37 三处);全部按 fallback 链描述更新中间档 `ref/plans/`
- [ ] A.3 改 `src/main/agent-deck-mcp/tools/handlers/enter-worktree-impl.ts` candidates fallback 链 — **R3 HIGH-1 + R4-M4 修正**:实测 L138 / L139 / L140 **三档全在**(L138 `.claude/plans/` 不变 / **L139 中间档 `path.join(mainRepo, 'plans', ...)` 必改 `path.join(mainRepo, 'ref', 'plans', ...)`** / L140 `~/.claude/plans/` 不变)+ L50 / L128 jsdoc 文字描述;**改完验证**(R4-M4 — 修正 R3 plan 内 grep 与 A.7 白名单口径冲突):
  ```bash
  grep -nE "path\\.join\\(mainRepo, 'plans'" src/main/agent-deck-mcp/tools/handlers/enter-worktree-impl.ts
  # 必须返 0 行(中间档已消失)
  grep -nE "path\\.join\\(mainRepo, 'ref', 'plans'" src/main/agent-deck-mcp/tools/handlers/enter-worktree-impl.ts
  # 必须返 1 行(新中间档已加)
  ```
  注:**不要** 用 `grep "plans/"` 校验(会把 L138/L140 合法 `.claude/plans/` 和 `~/.claude/plans/` 也判为残留;全局 0 残留验证留给 A.7 / E.6)
- [ ] A.4 改 `src/main/agent-deck-mcp/tools/handlers/hand-off-session-impl.ts` jsdoc — **R2 HIGH-3 行号补全**:实测命中 **L17 / L215**(plan v1 漏 L17);**关键** L17 jsdoc 描述 fallback 链「`<main-repo>/.claude/plans/<plan_id>.md > ~/.claude/plans/<plan_id>.md`」**没有中间档** → 同步加 `<main-repo>/ref/plans/<plan_id>.md` 中间档,保持与 A.6 L411 schema 修法一致
- [ ] A.5 改 `src/main/agent-deck-mcp/tools/index.ts` archive_plan + hand_off_session tool description(两行巨长 string,小心 escape;L219 / L251 各 8+ 处 `plans/`)
- [ ] A.6 改 `src/main/agent-deck-mcp/tools/schemas.ts` — **R1 MED-1 扩列**:
  - L258 / L511 plan_file_path field description fallback 链
  - **L268 changelog_id field description 含 sample link `[X](../changelog/CHANGELOG_X.md)` → `../changelogs/`**(与 A.1 formatChangelogCell 同步)
  - **L411 hand_off_session plan_file_path field description 加 `<main-repo>/ref/plans/` 中间档**(impl 通过 resolvePlanFilePath 实际三档,schema 必须暴露;与 A.4 L17 jsdoc 同步)
  - L771 / L780 jsdoc
- [ ] A.7 自检 0 残留(**R2 MED-4 升级正则**):
  - `grep -rnE "['\"]plans['\"]|<main-repo>/plans|/plans/|\.\./changelog/CHANGELOG_" src/`(原正则覆盖 path.join 字面值 + 文档路径 + 跨级 link)
  - `grep -rnE "\bplans/(INDEX|<id>|<plan|[A-Za-z0-9._-]+\.md)" src/`(R2 MED-4 新增 — catch 文档 / 注释纯相对 `plans/INDEX.md` `plans/<id>.md` 等)
  - 排除合法:`.claude/plans/` / `~/.claude/plans/` 临时位置 + `ref/plans/` 新位置 + A.1 白名单标注的历史 bug 复现 reference(grep -v 排除带 `HISTORICAL:` marker 的 line)

### Phase B: test 同步(必须全 pass)

- [ ] **B.0 it()/describe() name 改写**(R2 MED-1 新增):`grep -nE "it\(.*\bplans/|describe\(.*\bplans/" src/main/agent-deck-mcp/__tests__/*.test.ts` 列出 8 处实测命中,区分两类:
  - **(a) 不变档**(`<main-repo>/.claude/plans/` 临时位置 + `~/.claude/plans/` 跨项目位置):name 保留(实测 hand-off-session.impl-core.test.ts 3 处)
  - **(b) 中间档 / 默认档**(`<main-repo>/plans/`):name 同步改 `<main-repo>/ref/plans/`(实测 archive-plan.impl-core.test.ts:254 / archive-plan.impl-followup-20260515.test.ts:44/87/221 / archive-plan.mainrepo-clean.test.ts:126 共 5 处)
  - **Why**:it() name 是 vitest 报告字面输出,name 含 plans/ 与 impl ref/plans/ 行为错位 → 误导未来 reviewer
- [ ] B.1 改 `__tests__/plan-path-helpers.test.ts` 实测 9 处 `${MAIN_REPO}/plans/` → `${MAIN_REPO}/ref/plans/`(`/.claude/plans/` 临时位置 + `${HOME}/.claude/plans/` 跨项目位置不变;实际需改 6-7 处)
- [ ] B.2 改 `__tests__/archive-plan.impl-followup-20260515.test.ts` 实测 19 处 + **R1 HIGH-2 同步 ~14 处 `expect(formatChangelogCell(...))` link assertion**(L313 / L336 / L363 / L372 / L394 / L475 / L480 / L486 / L500 / L505 / L537 / L544 / L551 / L555 / L558 / L923 / L932 等,sed `-i '' -e 's|\.\./changelog/CHANGELOG_|../changelogs/CHANGELOG_|g'`)
- [ ] B.3 改 `__tests__/archive-plan.impl-ff-merge-body.test.ts` 实测 10 处(初版报 3 严重低估)
- [ ] B.4 改 `__tests__/archive-plan.impl-core.test.ts` 实测 17 处(初版报 3 严重低估;含 spike-reports 子目录路径 L257 / L258 / L301 / L306 + 多 assertion)
- [ ] B.5 改 `__tests__/archive-plan/_setup.ts` 实测 3 处(含 expectedArchivedPath)
- [ ] B.6 改 `__tests__/archive-plan.mainrepo-clean.test.ts` 实测 42 处(**初版报 1 严重低估 ≈ 42x**;含大量 `plans/INDEX.md` mock path)
- [ ] B.7 `pnpm exec vitest run src/main/agent-deck-mcp/` 全 test pass

### Phase C: codex 对偶同步

- [ ] C.1 改 `resources/codex-config/CODEX_AGENTS.md` — 实测 4 行 ≈ 7 处 occurrence;用 sed 批量 `s|<main-repo>/plans/|<main-repo>/ref/plans/|g`(注意 `.claude/plans/` 与 `~/.claude/plans/` 不变档需通过 grep -F 前缀差异区分);改后 `grep -nE "<main-repo>/plans/" resources/codex-config/CODEX_AGENTS.md` 必须 0 残留

### Phase D: agent-deck 项目自身数据迁移

- [ ] D.1 `git mv plans ref/plans`(101 文件;独立 commit)
- [ ] D.2 `git mv changelog ref/changelogs`(152 文件;**改名+迁目录一步**;独立 commit)
- [ ] D.3 `git mv reviews ref/reviews`(58 文件;独立 commit)
- [ ] D.4 `git mv conventions ref/conventions`(3 文件;独立 commit)
- [ ] **D.4.5 checkpoint**(R2 INFO-1 提示性新增 + R3 MED-8 改 for 循环 + R4-M6 删 `^R ` 行误报):确认 D.1-D.4 全部跑完才能进 D.5+:
  ```bash
  for d in plans changelogs reviews conventions; do
    if [ -d "ref/$d" ]; then echo "OK: ref/$d"; else echo "MISSING: ref/$d (D.? 漏跑)"; fi
  done
  ```
  全 4 OK 才进 D.5+。**注**(R4-M6):D.1-D.4 「每个 git mv 独立 commit」(详 §已知踩坑)— commit 后 git status empty,`^R ` rename entries 已消失;**不能** 用 `git status --short | grep "^R "` 校验(误报「漏跑」)。改用 `git -C <main> log --oneline -4 | grep -cE "git mv|mv .* ref/"` 校验最近 4 commit 是 git mv;或仅靠上面 for 循环 dir 存在性即可(commit 已成功 = dir 存在)
- [ ] D.5 改项目根 `/Users/apple/Repository/personal/agent-deck/CLAUDE.md` — **实测 17 处**(L24 / L30 / L31 / L33 / L35 / L38 / L39 / L41 / L43 / L45 / L50 / L64 / L146 / L152 / L153 / L157 / L160);用 BSD sed 批量(**R2 MED-3 完整命令模板**):
  ```bash
  sed -i '' \
    -e 's|`changelog/|`ref/changelogs/|g' \
    -e 's|`reviews/|`ref/reviews/|g' \
    -e 's|`conventions/|`ref/conventions/|g' \
    /Users/apple/Repository/personal/agent-deck/CLAUDE.md
  ```
  注意 `\``反引号 markdown 内 inline code 形态;改后 `grep -nE "changelog/|reviews/|conventions/" CLAUDE.md` 仅剩 `ref/changelogs/` / `ref/reviews/` / `ref/conventions/` 形态
- [ ] **D.6 cross-ref markdown link 批量 sed 替换(R1 HIGH-3 新增 + R2 HIGH-3/HIGH-6 升级 + R3 LOW-1 计数精修 + R3 MED-3 双跳删)**:**63 处** `../changelog/CHANGELOG_X.md`(单数!)→ `../changelogs/CHANGELOG_X.md`,实测分布:
  - 单跳 `../changelog/`:**62 处**(plans/ 27 + reviews/ 34 + changelogs/ 1)
  - 双跳 `../../changelog/`:**1 处**(plans/archive-toctou-fix-20260515.md:198)
  - 合计 **63 处**
  ```bash
  find ref/plans/ ref/reviews/ ref/conventions/ ref/changelogs/ -name "*.md" -exec \
    sed -i '' -e 's|\.\./changelog/CHANGELOG_|../changelogs/CHANGELOG_|g' {} \;
  ```
  **关键**(R3 MED-3 — reviewer-codex /tmp fixture 实测铁证):**单跳 sed pattern `\.\./changelog/CHANGELOG_` 自然 cover 任意级数 `../` 套层**(sed 是 substring greedy match `../changelog/` 子串,前面套多少层 `../` 都被命中替换);所以不需要单独写双跳 sed 命令 — 单条 sed 就能处理 `../changelog/` 和 `../../changelog/` 和 `../../../changelog/`。D.7 grep 用 `(\.\./)+changelog/CHANGELOG_` 覆盖任意级数兜底验证
- [ ] **D.7 cross-ref grep 验证(R1 HIGH-3 升级 + R2 HIGH-3 任意级数 + R2 LOW-1 inline code 豁免)**:分两段
  - `grep -rnE "(\.\./)+changelog/CHANGELOG_" ref/` 必须 **0 行**(覆盖任意级数 `../` `../../` `../../../` 等;D.6 sed 是否漏改)
  - `grep -rnE "\(changelog/CHANGELOG_|\(reviews/REVIEW_|\(conventions/" ref/` 必须 **0 行**(无绝对路径形态;**不能** 用旧 `grep -v '\.\./'`)
  - **R2 LOW-1 spot-check 豁免**:第二段 grep 命中后人工分流:
    - markdown 链接形态 `[text](url)` 必须修(D.6 sed 漏 → 加补 sed 单独处理)
    - inline code 形态 `` `text` `` 含字面字符串(如 `` `changelog/CHANGELOG_X.md` `` 当作纯文本展示)豁免不影响实际 link 渲染
- [ ] **D.8 .gitignore 修订(R1 HIGH-1 新增 + R3 MED-6 加 git check-ignore 验证)**:三件事 + 验证 negation 生效
  - L7 `!plans/**/spike-reports/*.log` → `!ref/plans/**/spike-reports/*.log`(否则新归档 spike .log 被 `*.log` 全局过滤永久丢失)
  - L26 注释「plan completed 后归档到顶级 plans/<plan-id>.md 入 git」→ 改 `ref/plans/<plan-id>.md`
  - 检查 `build/` entry 是否已有(无 → 加;已有 → 跳过 — `build/` entry 与本 plan 无关只是历史漏配兜底)
  - **R3 MED-6 验证 negation 生效**(改完立即跑):
    ```bash
    mkdir -p ref/plans/test-plan/spike-reports
    touch ref/plans/test-plan/spike-reports/test.log
    git check-ignore -v ref/plans/test-plan/spike-reports/test.log
    # 预期:无输出(L7 negation 生效)或显示 `.gitignore:7:!ref/plans/**/spike-reports/*.log`
    # ❌ 错误:若显示 `.gitignore:6:*.log` 命中说明 negation 没生效
    rm -rf ref/plans/test-plan  # cleanup
    ```
- [ ] **D.9 codex SKILL 镜像同步(R1 MED-2 新增)**:`pnpm exec node scripts/sync-codex-skills.mjs` 把 SSOT `resources/claude-config/agent-deck-plugin/skills/` 同步到 build-time 镜像 `resources/codex-config/agent-deck-plugin/skills/`(后者 .gitignore 不入 git,但 dev 启动时需要新镜像才能跑 codex 端 SKILL);改后 `grep -rn "plans/" resources/codex-config/agent-deck-plugin/skills/` 仅剩 `ref/plans/` 形态
- [ ] D.10 `grep -rnE "\(changelog/|\(reviews/|\(conventions/|\( plans/" ref/ CLAUDE.md README.md` 自检 0 旧绝对路径残留
- [ ] **D.11 建 `ref/flows/INDEX.md` + `ref/architecture/INDEX.md` 占位**(本会话不变量 13 衍生 — plantUML SSOT 工作链路):
  ```bash
  mkdir -p ref/flows ref/architecture
  # 建 ref/flows/INDEX.md 4 列空表头:
  cat > ref/flows/INDEX.md <<'EOF'
  # Flow Diagrams

  > plantUML 流程图(sequence / activity)SSOT。规则见应用打包 CLAUDE.md §核心流程 / 架构变更必走 plantUML 节;画图规约见 `agent-deck:flow-arch-plantuml` SKILL。

  | 文件 | 状态 | 关联 plan / commit | 概要 |
  |---|---|---|---|

  EOF
  # 建 ref/architecture/INDEX.md(同款 4 列表头,描述改架构图)
  cat > ref/architecture/INDEX.md <<'EOF'
  # Architecture Diagrams

  > plantUML 架构图(component / 模块依赖 / 跨进程边界)SSOT。规则见应用打包 CLAUDE.md §核心流程 / 架构变更必走 plantUML 节;画图规约见 `agent-deck:flow-arch-plantuml` SKILL。

  | 文件 | 状态 | 关联 plan / commit | 概要 |
  |---|---|---|---|

  EOF
  git add ref/flows/INDEX.md ref/architecture/INDEX.md
  git commit -m "chore(ref): 建 ref/flows + ref/architecture INDEX.md 占位"
  ```
- [ ] **D.12 grep 自检** ref/flows/ + ref/architecture/ 目录 + INDEX.md 4 列表头存在:
  ```bash
  test -d ref/flows && test -d ref/architecture && \
    grep -q "^| 文件 | 状态 | 关联 plan / commit | 概要 |$" ref/flows/INDEX.md && \
    grep -q "^| 文件 | 状态 | 关联 plan / commit | 概要 |$" ref/architecture/INDEX.md && \
    echo "OK: D.11 placeholders 就绪" || echo "FAIL"
  ```
- [ ] **D.13 user CLAUDE.md → 应用打包 CLAUDE.md 大块挪迁**(本会话 user 新需求 — §不变量 14 enforce):
  - **挪源**(user 全局,不入 git):`~/.claude/CLAUDE.md`
    - **§复杂 plan**(line 92-349,Step 0/0.5/1/1.5/2/2.5/3/4 全套 plan workflow + EnterWorktree stale base bug callout + worktree 路径陷阱 callout 等)
    - **§新项目工程地基**(line 351-490,§目录骨架 / src/build / .gitignore / README.md / `ref/changelogs/` `ref/reviews/` 双轨 / 已审文件过期 / 单文件大小护栏 / 反复反馈升级约定)
  - **挪目标**(本仓库,入 git):`<worktree>/resources/claude-config/CLAUDE.md`
    - **位置**:加在已有 §核心流程 / 架构变更必走 plantUML 节后,§Agent Deck Universal Team Backend 节前;新加 ## 二级节 `## 复杂 plan workflow` + `## 新项目工程地基` 两节
    - **行内引用调整**:user CLAUDE.md 原文内引用「user CLAUDE.md §决策对抗」等改成「同文件 §决策对抗」或保留 user CLAUDE.md reference(决策对抗节 user 没让挪,仍在 user 全局);引用「应用打包 CLAUDE.md」类自我引用形态删冗余 `应用打包` 前缀
    - **关注点分离**:挪过去的 ref/ 双轨节(`ref/changelogs/` `ref/reviews/`)若与已有 §核心流程 / 架构变更必走 plantUML 节文件位置约定有重叠 → 保留 plantUML 节为 SSOT,双轨节 cross-ref 到 plantUML 节
  - **挪源处理**:user CLAUDE.md 这两节**整体删**(让 user 全局保持精简 — 仅留 §通用约定 / §决策对抗 / §提示词资产维护 三节);**或**保留概要 + reference 到应用打包(本 plan 推荐**整体删**让 self-contained 原则彻底落地)
  - **D.13 commit 时机**:user CLAUDE.md 改动**不入 git**(它是 user 个人全局);应用打包 CLAUDE.md 改动跟随 Phase D 其他改动 commit(可与 D.5 等同 commit / 或独立 commit `feat(claude-md): 挪 user CLAUDE.md 复杂 plan + 新项目工程地基 节为 self-contained`)
  - **验证**:`grep -nE "^## 复杂 plan workflow|^## 新项目工程地基" resources/claude-config/CLAUDE.md` 应命中 2 行;`grep -nE "^## 复杂 plan|^## 新项目工程地基" ~/.claude/CLAUDE.md` 应 0 行(已挪走)

### Phase E: 全套验证

> **R3 HIGH-4 死锁修法**:本会话(.app 内 lead+reviewer)**不能** pkill .app 重启 dev,会终结本会话(in-memory state + reviewer mental model 全丢)。**实施会话由 user 自行决定** — 可在本会话(走 §Phase G 手工路径,跳过 dev 重启)或新 dev mode 会话(走 §Phase G tool 路径,可重启 dev)。E.0 重启 dev 仅当走 §Phase G tool 路径才需要;走 §Phase G 手工路径可跳过 E.0。

- [ ] **E.0(条件性 — 仅走 §Phase G tool 路径才必须)重启 dev 让 worktree 内 src/build 生效**(R2 HIGH-2 + R3 HIGH-4/HIGH-5 修订 — §不变量 10 enforce):
  - **前置警告**:pkill .app 会终结所有 lead + teammate session(详 §已知踩坑 pkill .app 风险);若本会话即将实施 → 跳过 E.0 走 §Phase G 手工路径;若 user 在 dev mode 新会话内实施 → 跑 E.0 重启 worktree 内 dev
  - `pkill -f "electron-vite dev" 2>/dev/null && pkill -f "Electron.app/Contents/MacOS/Electron" 2>/dev/null && pkill -f "/Applications/Agent Deck.app/Contents/MacOS/Agent Deck" 2>/dev/null`(R3 HIGH-4 — 加 pkill .app 覆盖已安装版)
  - `cd /Users/apple/Repository/personal/agent-deck/.claude/worktrees/ref-layout-full-migration-20260526 && pnpm dev`(在 worktree cwd 重启)
  - **验证 dev cwd**(R3 HIGH-5 修订 — macOS ps 不显示 cwd 列必须用 lsof):
    ```bash
    PID=$(pgrep -f "electron-vite dev" | head -1)
    lsof -p $PID -d cwd | tail -1
    # 应输出 .../worktrees/ref-layout-full-migration-20260526
    ```
- [ ] E.1 `pnpm typecheck`(必跑;在 worktree cwd 跑)
- [ ] E.2 `pnpm build`(大改动跑)
- [ ] E.3 `pnpm exec vitest run`(全 test pass;含 plan-path-helpers / archive-plan / hand-off-session / enter-worktree)
- [ ] E.4 ~~dev 模式启动 + invoke archive_plan tool 实测一次~~ **(R2 HIGH-1 已删 — archive_plan destructive 不能在 E 阶段 smoke test)**
- [ ] E.5 `git log --follow ref/changelogs/CHANGELOG_1.md` 验证 mv 后 history 保留(spot-check 1 个文件;R3 MED-5 fallback:若 follow 断 → `git log --all --diff-filter=R --raw -- ref/changelogs/CHANGELOG_1.md` 或显式 `--find-renames=20`)
- [ ] E.6 自检 0 残留(**R2 MED-4 升级正则**):
  - `grep -rnE "['\"]plans['\"]|<main-repo>/plans|/plans/|\.\./changelog/CHANGELOG_" src/ resources/ CLAUDE.md`(原正则)
  - `grep -rnE "\bplans/(INDEX|<id>|<plan|[A-Za-z0-9._-]+\.md)" src/ resources/ CLAUDE.md`(R2 MED-4 新增 — catch 文档纯相对路径)
  - 排除合法:`.claude/plans/` / `~/.claude/plans/` / `ref/plans/` 新位置 + A.1 白名单 `HISTORICAL:` marker

### Phase F: deep-review §Step 5 实施评审(D5 第二轮)

- [ ] F.1 invoke deep-review SKILL `kind='mixed'`,scope = Phase A+B+C+D 改动文件 + 本 plan 文件
- [ ] **F.2 处理 finding 按三态裁决纪律**(R1 INFO-1 修订;详 user CLAUDE.md §三态裁决):
  - ✅ 真问题(双方独立 OR 单方+现场验证)→ HIGH/MED 必修
  - ❌ 反驳(被对抗或现场核实证伪)→ 不修,记反驳依据
  - ❓ 未验证(纯文本推理 / 角度不同)→ 强制降非 HIGH,综合后定;**不**当必修无限 fix loop
  - **R4-M5 fix loop 后重跑验证**:F.2 fix 命中后若改了 impl / test 文件,**必须**重跑 E.1 typecheck + E.3 vitest(跳 E.0/E.2 dev 重启 / build,F 不影响这两项)防止 broken impl 进 G archive。改 plan / doc 文件可跳重跑
  - 收口:0 真 HIGH + 0 真 MED + E.1/E.3 pass(❓ 不阻断收口)

### Phase G: 收口(**R3 重新设计 — tool 路径 + 手工路径双选**)

> **死锁背景**(R3 HIGH-4):本会话 lead+reviewer 跑在 .app 内;走 tool 路径必须先 pkill .app 重启 dev,但 pkill .app 终结本会话。所以 §Phase G 拆**两条收口路径**,user 实施时择一:
> - **G-tool 路径**(推荐 dog-fooding 但需重启 dev): 走 archive_plan tool;前置 user 自己 cold-start dev mode 起新 lead session 接力 plan,不能在本(.app 内)会话跑
> - **G-manual 路径**(本会话 / 任何会话都可走): 走 user CLAUDE.md §Step 4 5 步手工归档;无 dog-fooding 价值但避开死锁

#### G.0(必须 — 两路径共用 clean gate)

- [ ] **G.0 worktree clean gate**(R3 HIGH-2 新增 — 双 reviewer 独立提出;archive_plan impl L488-495 内部 dirty precheck 必 reject):
  ```bash
  WT=/Users/apple/Repository/personal/agent-deck/.claude/worktrees/ref-layout-full-migration-20260526
  git -C "$WT" status --short
  ```
  必须 0 行(empty output)。否则 Phase A-F 还有 dirty 改动,先 commit:
  ```bash
  git -C "$WT" add -A && git -C "$WT" commit -m "chore: phase A-F migration changes"
  ```
  然后再 G.1。**不能** 跳过本 gate 走 G.4 — archive_plan 内部硬拒
- [ ] G.1 `ExitWorktree(action: "keep")`(把 cwd 切出 worktree;archive_plan tool / 手工归档都需先退 worktree)

#### G-tool 路径(推荐 dog-fooding,前置 user cold-start dev mode 新会话)

> **前置警告**:本路径**不能在本(.app 内)会话执行**。user 须 cold-start dev mode → 新 lead session(按 plan 接力 cold start prompt)→ 重 spawn reviewer pair(可选 — 仅 R4 时需要;实施时不需要)→ 然后跑 G-tool。详 §已知踩坑「pkill .app 风险 + 安全切 lead 决策树」。

- [ ] **G-tool.2.0 算下一个 changelog X — 从 worktree 内 ref/changelogs/ 算**(R3 HIGH-1 修法 — 双方独立提出 + R4-M_dual_2 占位符):
  ```bash
  WT=/Users/apple/Repository/personal/agent-deck/.claude/worktrees/ref-layout-full-migration-20260526
  test -d "$WT/ref/changelogs" || { echo "FATAL: $WT/ref/changelogs 不存在 — D.2 mv 没跑"; exit 1; }
  X=$(ls "$WT/ref/changelogs/CHANGELOG_"*.md 2>/dev/null \
    | sed 's|.*/CHANGELOG_\([0-9]*\)\.md|\1|' | sort -n | tail -1)
  test -z "$X" && { echo "FATAL: ls 0 行,X empty"; exit 1; }
  X=$((X+1))
  test $X -ge 152 || { echo "FATAL: X=$X < 152 silent fallback bug"; exit 1; }
  test ! -f "$WT/ref/changelogs/CHANGELOG_${X}.md" && echo "X=$X OK"
  ```
  当前最大 X=151(2026-05-26 实测),新 X 应为 **152**(若实施时新增 changelog 可能漂到 153/154);**关键**(R3 MED-4 + R4-M_dual_2 占位符):后续 G-tool.2 / G-tool.3 / G-tool.4 全部用 echo 出的实际 `<COMPUTED-X>` 替换,**不要 hardcode 152** — agent 看到 `X=153 OK` 时心里记 153 用在所有后续 step;若坚持记到临时文件:`echo $X > /tmp/ref-layout-changelog-x` 后每步 `X=$(cat /tmp/ref-layout-changelog-x)` 复用
- [ ] **G-tool.2 写 `<worktree>/ref/changelogs/CHANGELOG_<COMPUTED-X>.md`**(把 `<COMPUTED-X>` 替换为 G-tool.2.0 实际 echo 出的 X 数字)— 引用本 plan 归档 + 关键 commit;同步 append `<worktree>/ref/changelogs/INDEX.md` 一行
- [ ] **G-tool.3 git commit changelog**:
  ```bash
  WT=/Users/apple/Repository/personal/agent-deck/.claude/worktrees/ref-layout-full-migration-20260526
  X=<COMPUTED-X>   # 替换为 G-tool.2.0 echo 的实际数字
  git -C "$WT" add ref/changelogs/CHANGELOG_${X}.md ref/changelogs/INDEX.md
  git -C "$WT" commit -m "docs(changelog): CHANGELOG_${X} ref-layout-full-migration 归档"
  ```
- [ ] **G-tool.4 invoke `mcp__agent-deck__archive_plan({plan_id: "ref-layout-full-migration-20260526", worktree_path: "<worktree-abs>", changelog_id: "<COMPUTED-X>"})`**(把 `<COMPUTED-X>` 替换为 G-tool.2.0 echo 的实际 X 数字串如 `"152"` / `"153"`)— tool 自动 ff-merge worktree branch 到 base_branch / mv plan 到 ref/plans/ / commit / git worktree remove + branch -D / 默认归档 caller session
- [ ] **G-tool.5 验证 archive_plan return**:从 ok return 确认 `archivedPath: <main-repo>/ref/plans/ref-layout-full-migration-20260526.md` + `commitHash` + `plansIndexAction` + `spikeReportsArchived: null` + `archived: 'ok'`。**R2 MED-3**:return 字段是 impl resolve string 不是 fs.stat 真存在性;**R4-H1**:G-tool.4 后 caller 已 archived,本会话不能继续跑 Bash → user 必须起新 SDK 会话(cold-start prompt = `按 /Users/apple/Repository/personal/agent-deck/ref/plans/ref-layout-full-migration-20260526.md 接力跑 Phase H`)进 Phase H fs 真验证

#### G-manual 路径(本会话 / 任何会话都可走;无 dog-fooding 但避开死锁)

> 走 user CLAUDE.md §Step 4「完成」5 步手工归档(commit + ff-merge + mv plan + git mv + worktree remove + branch -D);本路径**不调** archive_plan tool,**不享受** dog-fooding 验证 impl 改动是否生效;实施 phase A-F 改完通过 vitest pass + typecheck pass 已经基本确信 impl 正确,手工归档接受这个降级。

- [ ] **G-manual.2.0 算 X 同 G-tool.2.0**(从 worktree 内 ref/changelogs/ 算,fail-fast;后续步骤用 `<COMPUTED-X>` 占位符替换为 echo 的实际值,不 hardcode 152)
- [ ] **G-manual.2 写 worktree 内 `ref/changelogs/CHANGELOG_<COMPUTED-X>.md`** + 同步 INDEX(`<COMPUTED-X>` 替换为实际值)
- [ ] **G-manual.3 commit changelog** 同 G-tool.3(用 `<COMPUTED-X>` 替换实际值)
- [ ] **G-manual.4 ff-merge worktree branch 到 base_branch**(plan frontmatter `base_branch: main`):
  ```bash
  WT=/Users/apple/Repository/personal/agent-deck/.claude/worktrees/ref-layout-full-migration-20260526
  MAIN=/Users/apple/Repository/personal/agent-deck
  git -C "$MAIN" checkout main
  git -C "$MAIN" merge --ff-only worktree-ref-layout-full-migration-20260526
  ```
- [ ] **G-manual.5 更新 plan frontmatter + mv plan 文件 + git mv 入归档位置**(R4-M_dual_1 — 双方独立提出 — 加可执行命令):
  ```bash
  MAIN=/Users/apple/Repository/personal/agent-deck
  PLAN_SRC="$MAIN/.claude/plans/ref-layout-full-migration-20260526.md"
  PLAN_DST="$MAIN/ref/plans/ref-layout-full-migration-20260526.md"
  FINAL_COMMIT=$(git -C "$MAIN" rev-parse HEAD)   # G-manual.4 ff-merge 后 HEAD 即归档基线 commit
  COMPLETED_AT=$(date -u +%FT%TZ)                  # ISO 8601 UTC,与 archive_plan impl(`date +%F`)保持兼容
  # 更新 frontmatter 三字段(用 Edit 工具或 BSD sed):
  #   status: in_progress → status: completed
  #   加 final_commit: <FINAL_COMMIT>
  #   加 completed_at: <COMPLETED_AT>
  # 推荐用 Edit 工具改 frontmatter(BSD sed 改 yaml 易踩 escape 坑):
  #   Edit(file_path: PLAN_SRC, old_string: "status: in_progress", new_string: "status: completed\nfinal_commit: <FINAL_COMMIT>\ncompleted_at: <COMPLETED_AT>")
  # 然后 mv:
  mv "$PLAN_SRC" "$PLAN_DST"
  # 同步 ref/plans/INDEX.md(append 一行,格式参考 ref/plans/INDEX.md 已有行):
  #   `| [ref-layout-full-migration-20260526.md](ref-layout-full-migration-20260526.md) | completed | [<COMPUTED-X>](../changelogs/CHANGELOG_<COMPUTED-X>.md) | <一句话概要> |`
  git -C "$MAIN" add ref/plans/ref-layout-full-migration-20260526.md ref/plans/INDEX.md
  git -C "$MAIN" commit -m "chore(plans): archive ref-layout-full-migration-20260526"
  ```
- [ ] **G-manual.6 删 worktree + branch**:
  ```bash
  git -C "$MAIN" worktree remove "$WT"
  git -C "$MAIN" branch -D worktree-ref-layout-full-migration-20260526
  ```
- [ ] **G-manual.7 baton-cleanup phase 1**(R4-M_dual_3 — 双方独立提出 — **默认必跑**):走 §escape hatch `mcp__agent-deck__shutdown_baton_teammates({plan_id: "ref-layout-full-migration-20260526"})` 关闭同 team 其他 active+dormant teammate(本 plan 走过 deep-review 的 reviewer-claude/codex pair 仍 active)。**默认必跑**:archive_plan tool 自动跑 baton-cleanup phase 1,G-manual 路径绕过 tool 后必须显式补跑保持 teammate 生命周期等价 — **跳过条件**:仅当 user 明示要保留 reviewer 继续讨论(典型:打算复用 reviewer mental model 做 follow-up plan review)才跳。详 应用打包 CLAUDE.md §escape hatch 节

### Phase H: post-archive fs 真验证(走完 G-tool 或 G-manual 任一路径都跑)

caller G-tool.5 / G-manual.6 跑完后(若走 G-tool 则 caller 已 archive,本会话无法继续 Bash → user 起新 SDK 会话或手工跑;若走 G-manual 则 caller 仍可跑 — H 全 step 在本会话完成):

- [ ] **H.1 fs.stat 验证 archive 文件真存在**:
  ```bash
  test -f /Users/apple/Repository/personal/agent-deck/ref/plans/ref-layout-full-migration-20260526.md \
    && echo "OK: archive file exists" \
    || echo "FAIL: archive missing — impl bug / fs write failed / 手工 mv 漏跑"
  ```
- [ ] **H.2 verify git commit 含 archive 文件**:
  ```bash
  git -C /Users/apple/Repository/personal/agent-deck log -1 --format="%H %s" \
    -- ref/plans/ref-layout-full-migration-20260526.md
  ```
- [ ] **H.3 verify INDEX append 本 plan 行**:
  ```bash
  grep -l "ref-layout-full-migration-20260526" \
    /Users/apple/Repository/personal/agent-deck/ref/plans/INDEX.md
  ```
- [ ] **H.3.5 verify plan frontmatter 已更新 status: completed + final_commit + completed_at**(R4-M_dual_1 fix 验证):
  ```bash
  grep -nE "status: completed|^final_commit:|^completed_at:" \
    /Users/apple/Repository/personal/agent-deck/ref/plans/ref-layout-full-migration-20260526.md
  # 应输出 3 行:status: completed / final_commit: <hash> / completed_at: <ISO>
  ```
- [ ] **H.4 verify git mv history 保留**(R3 MED-5 升级 — git rename detection 失败兜底):
  ```bash
  # Primary: --follow(默认 50% 阈值)
  git -C /Users/apple/Repository/personal/agent-deck log --follow \
    --format="%H %s" ref/changelogs/CHANGELOG_1.md | head -5
  # Fallback 1: 调高阈值
  git -C /Users/apple/Repository/personal/agent-deck log --follow --find-renames=20 \
    --format="%H %s" ref/changelogs/CHANGELOG_1.md | head -5
  # Fallback 2: 显式 rename 查询(找 R 状态 commit)
  git -C /Users/apple/Repository/personal/agent-deck log --all --diff-filter=R --raw \
    -- ref/changelogs/CHANGELOG_1.md
  ```
  应能 trace 回 mv 前的 changelog/CHANGELOG_1.md 历史
- [ ] **H.5 worktree + branch 真删**(R3 MED-2 修法 — git show-ref 替代 grep -v 始终 success):
  ```bash
  WT=/Users/apple/Repository/personal/agent-deck/.claude/worktrees/ref-layout-full-migration-20260526
  test ! -d "$WT" && echo "OK: worktree dir removed" || echo "FAIL: worktree dir 还在"
  ! git -C /Users/apple/Repository/personal/agent-deck show-ref --verify --quiet \
    refs/heads/worktree-ref-layout-full-migration-20260526 \
    && echo "OK: branch removed" || echo "FAIL: branch 还在"
  ```

## 当前进度

- ✅ §Step 0 RFC 完成(4 个 design 决策对齐:硬切 / 一口气全做 / 不兼容 / 两轮 deep-review)
- ✅ §Step 0.5 spike 完成(影响面 grep 实测:src 30+ / test 40+ / codex 对偶 4 / agent-deck 自身 314 文件 — **R1+R2 deep-review 精确化为 src 38+ / test 100 + ~14 link assertion / codex 对偶 7 occurrence / project root CLAUDE.md 17 处 / cross-ref link 63 处(62 单跳 + 1 双跳)**)
- ✅ §Step 1 plan v1 写完(2026-05-26 第一版,影响面数据为估计)
- ✅ §Step 1.5 deep-review **R1** 完成(2026-05-26 reviewer-claude 11 finding / reviewer-codex 5 finding;5 HIGH / 5 MED / 3 polish 全裁决 ✅)
- ✅ §Step 1.5 deep-review **R2** 完成(2026-05-26 reviewer-claude 11 finding / reviewer-codex 4 finding;6 HIGH / 5 MED / 3 polish 全裁决 ✅)
- ✅ §Step 1.5 deep-review **R3** 完成(2026-05-26 reviewer-claude 11 finding / reviewer-codex 3 finding;**5 HIGH(含 1 死锁级)** + 6 MED + 3 polish 全裁决 ✅。**R3 重大发现**:① R2 fix 文字推理引入 3 HIGH(L139 错误声明 / pkill 漏 .app / ps aux 不显示 cwd);② **双方独立提出 2 HIGH**(R3-H1 G.2.0 silent X=1 + R3-H2 G.4 前缺 clean gate);③ 揭示死锁级问题:本会话(.app 内)不能 pkill .app 重启 dev 走 dog-fooding;plan 已重新设计 §Phase G 为 **tool 路径 + 手工路径双选**)
- ✅ §Step 1.5 deep-review **R4** 完成(实施会话 cold-start 后直接 confirm 走 G-manual 路径,R4 skipped per user decision)
- ✅ §Step 2 EnterWorktree(2026-05-26 实施会话 cold-start cat + git worktree add + EnterWorktree(path:) 进入)
- ✅ §Phase Pre-A(SSOT dirty stash + worktree 内 commit 2 个:plantUML SSOT + deep-review SKILL docs 修订)
- ✅ §Phase A(impl 改造,commit `e14ab90`):archive-plan-impl.ts / plan-path-helpers.ts / enter-worktree-impl.ts / hand-off-session-impl.ts / tools/index.ts / schemas.ts 全 ref/plans/ + ../changelogs/ + HISTORICAL marker;A.7 0 残留
- ✅ §Phase B(test 同步,commit `9070419`):7 test 文件 100+ 处 + ~14 link assertion + 5 处 it() name;B.7 vitest 931 pass(skip 2 pre-existing test → follow-up task)
- ✅ §Phase C(codex 对偶,与 Phase B 同 commit `9070419`):CODEX_AGENTS.md 4 行 ≈ 7 occurrence sed
- ✅ §Phase D.1-D.4(git mv 4 子目录,各 1 commit:`7a6f5f5` / `44b6fe3` / `03c16e4` / `8841560`):plans/ / changelog/ / reviews/ / conventions/ → ref/<复数> 全成功 + git rename detection 100% work
- ✅ §Phase D rest(D.5-D.13,commit `e22f0f4`):项目根 CLAUDE.md (17 处) + cross-ref link 63 处 + .gitignore negation + ref/flows + ref/architecture INDEX 占位 + D.13 user CLAUDE.md §复杂 plan + §新项目工程地基 挪迁到应用打包 CLAUDE.md (397 行 mass move)
- ✅ §Phase E.1 typecheck pass + §Phase E.3 vitest 931 pass + §Phase E.5 git --follow CHANGELOG_1.md trace 回 mv 前 history ✓ + §Phase E.6 0 真残留 ✓
- ✅ §Phase F deep-review SKILL kind=mixed R1 完成(双 reviewer 4 HIGH + 7 MED + 2 INFO 全裁决 ✅;现场实测验证 stale path + INDEX 残留 + .gitignore 嵌套深度 + 应用打包 CLAUDE.md self-contained 文字 + plan §当前进度 stale + G-manual.5 INDEX row label;**全部修完进 §Phase G-manual 收口**)
- ⏳ §Phase G-manual(待 user confirm 后跑 G.0 → G.1 → G-manual.2.0 ~ G-manual.7)
- ⏳ §Phase H(post-archive fs 真验证)

## 下一会话第一步(cold-start 接力指令)

> ⚠️ **当前状态**:Phase Pre-A → F R1+R2 deep-review 全部 ✅,Phase G-manual 收口 + Phase H fs 真验证 待执行(详 §当前进度)。
> 
> **§Phase G 双路径选择**(本 plan 收口的关键决策):
> - **G-tool 路径** = 真实 dog-fooding archive_plan tool,但前置 user 必须在 dev mode 内(非已装 .app)起新 lead session 接力。**死锁规避**:不能在 .app 内 lead session(如本会话场景)走 G-tool — pkill .app 终结自己
> - **G-manual 路径** = 走 user CLAUDE.md §Step 4 5 步手工归档,任何会话都可执行;无 dog-fooding 验证但避开死锁。**Phase A-F 通过 vitest + typecheck 后已基本确信 impl 正确,接受 dog-fooding 降级**

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/ref-layout-full-migration-20260526.md`(全文)
2. **当前会话已 cold-start cat plan + EnterWorktree(path:) 进 worktree + commit Phase Pre-A/A/B/C/D 全 ✅;F R1+R2 已 ✅ 收口**(详 §当前进度);新会话接力直接进 §Phase G-manual 收口 + §Phase H
3. **G-manual 收口流程**(本 plan 已选定路径):
   - **G.0** worktree clean gate:`git -C <worktree-abs> status --short` 必 0 行(否则先 commit 剩余 dirty);本 commit 后会话即可直接跑
   - **G.1** `ExitWorktree(action: "keep")` 把 cwd 切出 worktree(archive_plan tool 与手工归档都需先退 worktree)
   - **G-manual.2.0** 算 X(从 worktree 内 `ref/changelogs/` 算 max+1,fail-fast `test -z` + `test -ge 152`)
   - **G-manual.2/3** 写 `<worktree>/ref/changelogs/CHANGELOG_<X>.md` + 同步 INDEX + commit
   - **G-manual.4** ff-merge worktree branch → base_branch(plan frontmatter `base_branch: main`)
   - **G-manual.5** 更新 plan frontmatter(status=completed + final_commit + completed_at)+ mv plan 到 `<main-repo>/ref/plans/` + 同步 `<main-repo>/ref/plans/INDEX.md`(canonical label `[<id>.md](<id>.md)` per R1 fix Cx-M5)+ commit
   - **G-manual.6** 删 worktree + branch:`git worktree remove + git branch -D`
   - **G-manual.7** baton-cleanup phase 1(`mcp__agent-deck__shutdown_baton_teammates({plan_id})` 关 R1+R2 reviewer pair;默认必跑,除非 user 明示保留)
4. **Phase H** fs 真验证(G-manual.6 后会话仍可跑):H.1 archive 文件存在 / H.2 git commit 含 archive / H.3 INDEX append / H.3.5 frontmatter completed + final_commit + completed_at / H.4 git --follow history / H.5 worktree + branch 真删
5. 每完成一个 step 在本 plan 文件 `- [ ]` 打勾 + commit 进度(plan 文件本身不入 git,改动在 main repo `.claude/plans/`)
6. 遇决策面变更,告诉用户征得 confirm 再继续

## 已知踩坑 / 风险

- **impl long string description**(`tools/index.ts` L219 / L251 archive_plan / hand_off_session)— 单引号 string 含多处 `\'`,改时小心 escape;建议用 sed/grep 提取 baseline 后逐个 Edit 验证
- **测试 fallback 链描述**(`__tests__/plan-path-helpers.test.ts` it() name 含「中间档」`<main-repo>/plans/<id>.md`)— 改成 `<main-repo>/ref/plans/<id>.md`,与 helper 实际新行为对齐(R2 MED-1 已加 Phase B.0 显式 step)
- **`git mv` 4 commit 单独提交**(D.1-D.4):**每个 git mv 独立 commit**(D.1-D.4 各 1 commit),共 4 commit。便于 cherry-pick / revert / `git log --follow` 单独 spot-check
- **plan-path-helpers fallback 链顺序**(不变量 D5):`.claude/plans/` 临时草稿(优先档,不变)> `ref/plans/`(项目归档版)> `~/.claude/plans/`(跨项目位置)— 中间档从 `plans/` 改 `ref/plans/`,前后两档不动
- **cross-ref markdown link batch sed 严格匹配 + BSD 形态**(R1 HIGH-3 + R2 HIGH-3 + R2 MED-3 + R3 MED-3 衍生):
  - sed pattern 严格匹配 `\.\./changelog/CHANGELOG_`(含 `CHANGELOG_` 前缀)避免误改其他相关字串
  - **单跳 sed 自动 cover 任意级数**(R3 MED-3 修正 — reviewer-codex /tmp fixture 实测铁证 sed substring match 不区分 `../changelog/` 与 `../../changelog/` 前段);plan v2 多余的双跳 sed 已 D.6 删
  - 全用 BSD sed 形态 `sed -i '' -e '<pattern>' <file>`(macOS 必须空字符串作 backup suffix);**严禁** `sed -i 's|...|...|g' <file>`(GNU 形态,macOS 报错或把 pattern 当 backup suffix)
  - sed 后必须跑 D.7 grep 兜底验证 0 残留(用 `(\.\./)+changelog/CHANGELOG_` 覆盖任意级数)
- **.gitignore exception 更新关键护栏**(R1 HIGH-1 衍生):D.8 修订 L7 后必须立即跑 `git check-ignore -v ref/plans/<any-plan>/spike-reports/test.log` 验证 negation 生效。若 negation 没生效 → 新归档 plan 所有 spike .log 被 `*.log` 全局过滤悄悄丢失
- **codex SKILL 镜像同步时机**(R1 MED-2 衍生):D.9 `pnpm exec node scripts/sync-codex-skills.mjs` 必须在 D.1-D.8 全部完成后跑(否则镜像旧路径与新路径混)
- **archive_plan 默认归档 caller 的不可逆性 + 失败回滚树**(R1 HIGH-4 + R2 HIGH-1 + R2 INFO-2 衍生):G-tool.4 调 archive_plan 后 caller session 自动归档(`archived: 'ok'`),本会话之后无法继续跑 shell;G-tool.5 验证仅靠 archive_plan return 字段,fs 真验证移到 Phase H(必须起新会话)。**archive_plan schema 没有 `archive_caller: false` 字段**(那是 hand_off_session 字段,本 plan v2 误标已删)。失败回滚决策树:
  - return `archived: 'ok'` 但 fs.stat 失败(H.1 检查不通过)→ impl bug;新会话起 hand_off_session → grep impl 写归档的 step → 手工 mv plan 文件补
  - return `archived: 'failed'` 或缺 archivedPath → 看 errorCode + hint(impl 内部有 7 phase phaseHint 覆盖典型场景)
  - caller 已 archived 但 git 没收口 → 新会话起 hand_off_session 后手工跑剩余 git 命令(`merge --ff-only worktree-<plan-id>` / `worktree remove` / `branch -D`)
  - 万一 plan 文件已 unlink 但 git commit 没成功 → 从 worktree dir 找 plan 文件 source restore
- **🔴 dog-fooding 死锁:lead+reviewer 跑在 .app 内不能 pkill .app**(R3 HIGH-4 + INFO-1 衍生 — §Phase G tool/manual 双路径根因):
  - **死锁机制**:走 G-tool 路径必须 pkill .app 重启 worktree dev → 新 impl 生效 → archive_plan tool 走新 impl 路径(ref/plans/)。但 pkill .app **终结所有 lead+teammate session**(本对话即在 .app 内 → 自己被 kill)→ context + reviewer mental model 全丢
  - **不能在 .app 内 lead session 走 G-tool**(典型本会话场景):必须先 user 自己 cold-start dev mode 起 dev → 新 lead session 接力 plan → 那个 dev mode 内会话才能走 G-tool(它不在 .app 内,pkill .app 不杀自己)
  - **本会话场景下走 G-manual 路径**:走 user CLAUDE.md §Step 4 5 步手工(commit + ff-merge + mv plan + git mv + worktree remove + branch -D);手工归档没 dog-fooding 但本会话 phase A-F 跑过 vitest + typecheck 已 high confidence,接受降级
  - **决策树**:① user 在已装 .app(普通用户场景)— 走 G-manual;② user 在 dev mode(开发者场景)— 任选 G-tool / G-manual(G-tool 提供 dog-fooding 验证 impl 真生效);③ user 已耗时长 + 不想换 session — 走 G-manual
- **dog-fooding 时机 — 必须在 worktree 内重启 dev**(R2 HIGH-2 衍生 — §不变量 10):仅 G-tool 路径必须;G-manual 跳过 E.0
- **A.1 历史 bug 复现 reference 白名单**(R2 MED-4 + R3 MED-1 衍生):archive-plan-impl.ts L128 / L129 / L296 等含 `' M plans/INDEX.md\0'.trim()` 字面值是历史 bug 解析 reference,改 ref/plans/ 破坏 bug 复现 → 保留 + 加 `// HISTORICAL:` marker 让 A.7/E.6 grep 排除;**R3 MED-1 纠正**:L72 是 impl jsdoc 行为描述不是 bug ref → 必改 `ref/plans/INDEX.md`;实施时 grep `H2 现场实测铁证|bug repro literal` 命中行才白名单
- **G.2.0 选号 fail-fast + hardcode 替换**(R3 HIGH-1 + R3 MED-4 衍生):G-tool.2.0 / G-manual.2.0 必须从 worktree 内 `ref/changelogs/` 算 X(D.2 mv 只在 worktree branch,主仓库 ref/changelogs/ 不存在 → ls 0 → silent X=1 覆盖历史);加 `test -z "$X" && exit 1` + `test $X -ge 152 || exit 1` fail-fast;agent 看到 echo `X=152 OK` 后,后续 G.2/G.3/G.4 用 hardcode `152` 替换 `${X}`(Bash tool 跨调用 shell var 不持久化)
- **未覆盖的硬编位置**(spike 漏检风险)— A.7 / E.6 grep 兜底验证 0 残留;若发现新硬编点,加进 Phase A 重新走
- **plantUML SSOT dirty 跨 worktree 迁移**(本会话新加 — §影响面 spike H + §不变量 13 衍生):本会话已在 main working tree 改 `resources/claude-config/CLAUDE.md` 加 plantUML 节 + 新建 `resources/claude-config/agent-deck-plugin/skills/flow-arch-plantuml/SKILL.md`(untracked)。**git worktree add 是从 base_commit 拉的独立 working tree,不带 dirty 改动**;实施会话进 worktree 前必须:① `git add -N` 让新 SKILL.md 被 git 追踪(否则 stash -u 才含;-u 已含直接跳此步)→ ② `git stash push -u -m "..."`(-u 含 untracked)→ ③ §Step 2 EnterWorktree 后 `git stash pop`(同一 repo 内 worktree 共享 stash storage)→ ④ Pre-A.3 worktree 内 commit。**踩坑预防**:`git stash -u` 不加 `-u` 会丢新 SKILL.md(untracked 默认不入 stash);worktree pop 后 dirty 应含 2 文件改动(M CLAUDE.md + ?? SKILL.md → A SKILL.md after add);commit message 区别于本 plan 主流改动(独立 commit 便于 history 追溯)
- **plantUML SKILL invoke 时机**(本 plan 实施期间不画图,仅建 INDEX 占位):本 plan 是数据迁移 plan **不改 src/main 核心流程**,不触发 plantUML skill auto-invoke;Phase D.11/D.12 仅建空 INDEX.md 占位让后续 plan(真改 src/main 时)skill auto-invoke 时有目标位置。后续真画 plantUML 时 invoke `agent-deck:flow-arch-plantuml` SKILL,append 行到 INDEX.md / 生成 .puml 文件

## 关联

- 触发:reviewer-codex HIGH-1(claude-config CLAUDE.md ↔ impl 当前事实矛盾)+ user 明示「不要任何旧标准 / 不要兼容提及 / 都用新标准」
- 上轮工作:已在 main 改了 ~30 处文档(user CLAUDE.md / templates / SOPs / claude-config CLAUDE.md 撤回错误回滚到 ref/plans/),本 plan 不重做已改部分,仅补 impl + agent-deck 自身 git mv + codex 对偶 + tests
- changelog 关联:本 plan 完成后写 `ref/changelogs/CHANGELOG_<X>.md`(X 待定;本 plan 收口阶段 G.3 步骤)
