# CHANGELOG_175 — plan deep-project-review-comprehensive-20260528 Phase 3+4+5+6 完整归档 (C/A/D 三维 + 经验沉淀)

## 概要

[plan `deep-project-review-comprehensive-20260528`](../../plans/history/deep-project-review-comprehensive-20260528.md) Phase 3+4+5+6 总收口归档（Phase 2 单独归档详 [CHANGELOG_174.md](./CHANGELOG_174.md)）。**C 维 plantUML 通俗化** 17 张图重写 + INDEX 概要列重写为 ≤ 80 字白话；**A 维 13 个 >500 行非测试源文件 facade pattern 拆分** 11 step 全过单文件 ≤ 500 LOC 护栏；**D 维架构合理性 review** ([REVIEW_63.md](../../reviews/history/REVIEW_63.md)) 报告 spike1 §A1 候选 7 HIGH + 1 MED 全部 100% Phase 4 已落地（Step 5.2 重构 = 0 work）；**Phase 6 经验沉淀** Phase 4 facade pattern 6 项经验 + Phase 5 facade 自身 LOC 监控 + R2 INFO 修法「fix 后表格 / 描述文字必同步」+ deep-review SKILL 双方共识收口路径写入 `resources/claude-config/CLAUDE.md` 新增 2 节 + §单文件大小护栏 节补 facade 自身 LOC 监控。

**净改动**：90 文件 +12223 / -9734 = +2489 LOC delta（基线 Phase 2 收口 commit `9d55c64` 到 Phase 6 Step 6.1+6.3 baseline `a022a26`，含 Phase 3 puml 17 张重写 + Phase 4 11 大文件拆 ~50 子模块 + Phase 5 REVIEW_63 317 LOC + Phase 6 经验沉淀 +33 LOC）。Phase 4 内部 LOC trade-off +27.8% 是 readability tax（11 大文件 9821 → 12552 LOC），0 runtime overhead（详 REVIEW_63 §E1）。

**不变量守约**：mcp tool description 注入 SDK system prompt 的文案 byte-identical（未触碰 `src/main/agent-deck-mcp/tools/schemas.ts`）/ 运行时行为不变（无 user-facing 行为变化）/ facade barrel re-export byte-identical 生产代码 caller import path 0 改动 / 测试 import path 0 改动 / 0 runtime circular dep ✓ / 0 ≥ 500 LOC 子模块 ✓。

## 变更内容

### Phase 3 C 维 plantUML 架构图通俗化（commit `8e01831` / `ec7e190` / `0a578a3` + R1-R4 4 commit `710b100` / `6649d4b` / `f6a88e6` / `9a03b46`）

#### Step 3.1: 17 张图 spike

- 实测 8 张 architecture + 9 张 flows 当前节点数 / 层数 / 术语密度 / 重复度
- 制定通俗化重写计划：按 D7 「宏观角度 ≤ 5 层 / ≤ 12 节点 / 节点名优先日常术语 / 不堆叠 LOC commit metadata」

#### Step 3.2: 8 张 architecture 通俗化重写（commit `8e01831`）

- `agent-deck-mcp-architecture.puml` / `archive-plan-architecture.puml` / `archive-plan-state-machine.puml` / `hand-off-session-architecture.puml` / `hand-off-session-state-machine.puml` / `sdk-bridge-architecture.puml` / `sdk-bridge-state-machine.puml` / `universal-message-status-state-machine.puml`
- 每张图限 ≤ 5 层 / ≤ 12 节点，细节进 cmt 描述不进图，节点名优先日常术语（「主进程模块」「数据库」「外部 CLI」）+ 括号注内部 codename（component diagram 才出现 `agent-deck-mcp` 等）

#### Step 3.3: 9 张 flows 通俗化重写（commit `ec7e190`）

- `agent-deck-mcp-tool-call-flow.puml` / `archive-plan-flow.puml` / `archive-plan-precheck-decision.puml` / `hand-off-session-decision.puml` / `hand-off-session-flow.puml` / `sdk-bridge-recovery-decision.puml` / `sdk-bridge-resume-recovery-flow.puml` / `universal-message-dispatch-decision.puml` / `universal-message-dispatch-flow.puml`
- 同款宏观重写 + 细节进 cmt

#### Step 3.4: 同步 INDEX 概要列重写（commit `0a578a3`）

- `ref/architecture/INDEX.md` + `ref/flows/INDEX.md` 第 4 列「概要」精简到 ≤ 80 字白话
- LOC + commit hash 进第 3 列「关联 plan / commit」（D7 关注点分离）

#### Step 3.5: flow-arch-plantuml SKILL kind='mixed' 4 轮异构对抗（R1-R4 commit `710b100` / `6649d4b` / `f6a88e6` / `9a03b46`）

- **R1** 6 finding（5 HIGH + 1 MED）→ commit `710b100`
- **R2** 3 finding（1 HIGH + 2 MED）→ commit `6649d4b`
- **R3** 1 MED 收口 → commit `f6a88e6`
- **R4** INFO-R4-1 优先级 note polish → commit `9a03b46`
- **R4 双方共识** 0 HIGH/MED ✅ 可合

### Phase 4 A 维 13 大文件 facade pattern 拆分（11 step 11 commit + Step 4.12 收口 fix commit）

#### Step 4.0: read-only architecture spike (前置必跑)

- 输出 `<plan-artifact-dir>/spike-reports/spike1-architecture-dep-graph.md` 14.8 KB（9 F-finding + 4 A-finding + Phase 5.1 D 维 review candidate list）
- read-only 不动代码（不破坏 D2 phase 串行）

#### Step 4.1-4.11: 11 大文件 facade pattern 实拆

| Step | 文件 | baseline LOC | facade LOC | 子模块数 | commit |
|---|---|---|---|---|---|
| 4.1 | hand-off-session.ts | 1306 | 40 | 5 (_deps + cwd-resolver + handler-main + task-reassign-coordinator + team-adopt-coordinator) | `f152289` |
| 4.2 | archive-plan-impl.ts | 1281 | 195 | 5 (_impl-shared + impl-precheck + impl-ff-merge + impl-archive-fs + impl-cleanup) | `8969654` |
| 4.3 | codex sdk-bridge index.ts + recoverer.ts | 874+597 | 499+159 | index 5 + recoverer 3 | `23cb39b` |
| 4.4 | claude sdk-bridge index.ts + recoverer.ts | 840+670 | 467+211 | index 3 + recoverer 3 | `a21f258` |
| 4.5 | task-repo.ts | 721 | 116 | 5 (_deps + task-repo-crud + task-repo-delete + task-repo-handoff + task-repo-list) | `8d3589a` |
| 4.6 | session/manager.ts | 686 | 443 | 3 (_deps + lifecycle + rename) | `7cbfbba` |
| 4.7 | window.ts | 623 | 100 | 5 (_deps + lifecycle + pin-visual + polish + sizing) | `223e59d` |
| 4.8 | main/index.ts | 594 | 74 | 4 (_deps + bootstrap-infra + bootstrap-wiring + lifecycle-hooks) | `4457a2d` |
| 4.9 | adapters/types.ts | 558 | 21 | 4 (adapter-context + create-session-opts + capabilities + agent-adapter) | `e18da65` |
| 4.10 | shared/types/settings.ts | 544 | 31 | 3 (app-settings + defaults + permission-scan) | `ee4cf3b` |
| 4.11 | agent-deck-message-repo.ts | 527 | 111 | 4 (_deps + crud + dispatch + state-machine) | `4a573a4` |

- **总 LOC**: 9821 → 12552 (+27.8% readability tax)，**全 11 facade ≤ 500 LOC** 满足 §D1 护栏，**~50 个 ≥ 50 子模块全 ≤ 500 LOC** ✓
- 每文件按 Step 4.x.0 mini-spike + user 1-min confirm 3 题模式拆（① 子模块名 ② 边界划法 ③ entity / 功能 / 行为域），不 confirm 实施细节
- caller import path **0 改动** 生产代码 ✓（200+ caller 全走 facade barrel re-export byte-identical）
- 测试 import path **0 改动** ✓（test 文件直接 import 子模块属 unit test 覆盖合理）

#### Step 4.12: Phase 4 整体收口 deep-review SKILL kind='code' 2 轮异构对抗（commit `14aee43`）

- **R1** reviewer-codex HIGH-1: archive-plan-impl.ts facade 漏 re-export `postFfMergeErr` value（只 re-export type，漏 value `export function postFfMergeErr`）— 属 silent re-export miss 违反 plan §不变量「facade pattern 原 import path 全保留」
- **R1 fix** commit `14aee43` facade L62 加 `export { postFfMergeErr } from './archive-plan/_impl-shared';` (+6 LOC)
- **R2 双方共识** 0 HIGH/0 MED/0 LOW ✅ + reviewer-claude 自我修正承认 R1 漏审 value export 维度 + 升级 mental model「facade refactor sanity 必须穷举 baseline named export 列表 1:1 diff」+ 13 facade value/function/const export 全量 95:95 baseline 对齐
- 3 build 全过：`pnpm typecheck` 0 error / `pnpm build` exit 0 / `pnpm dist` exit 0（P26 升级覆盖 electron-builder asar 化 + extraResources copy + native binary unpack 真打包步骤）

### Phase 5 D 维架构合理性 review + 必要重构（3 step + REVIEW_63.md）

#### Step 5.1: D 维架构合理性 review 报告（commit `156d2ed`）

- 写 [`ref/reviews/REVIEW_63.md`](../../reviews/history/REVIEW_63.md) 317 LOC + 同步 [`ref/reviews/INDEX.md`](../../reviews/INDEX.md) 加 REVIEW_63 行
- **A 节**: spike1 §A1 列出的 **7 HIGH + 1 MED candidate 全部 ✅ 100% Phase 4 已落地**（manager / hand-off-session / archive-plan / 双 sdk-bridge createSession + recoverer / main/index bootstrap god-function 8 处）→ **Step 5.2 重构 = 0 work**
- **B 节 Phase 5.1 新发现 finding**：HIGH = 0 / MED = 0 / LOW = 3 / INFO = 5 / 临界文件监控 7 (含 3 facade 自身 + 4 sub-module)，全留 follow-up plan
- **Phase 4 实施经验 E1-E6** inform Phase 6 经验沉淀

#### Step 5.2: HIGH 重构 = 0 work（spike1 §A1 候选已全 Phase 4 落地）

#### Step 5.3: Phase 5 收口 deep-review SKILL kind='mixed' 2 轮异构对抗（commit `8925fb5` + `31b29eb`）

- **R1 fix** commit `8925fb5` 3 处 fix（M1 REVIEW_63 漏审 facade 自身 LOC → §临界子模块监控 → §临界文件监控 7 行表 + LC1 handler-main.ts:50 删人为 runtime 依赖 + LC2 plan checklist [ ]→[x] markers / 5→6 步同步）
- **R2 INFO 修补** commit `31b29eb` 2 处微同步（REVIEW_63 准则节 + handler-main LOC 411→406 fix）
- **R2 双方共识** 0 HIGH/MED + 3 build 全过 → Phase 5 conclude

### Phase 6 经验沉淀（Step 6.1 + 6.3 改动文件 + Step 6.2/6.4/6.5 no-op or final step）

#### Step 6.1: 通用工程经验沉淀到 `resources/claude-config/CLAUDE.md`

- §单文件大小护栏 节补 **facade 自身 LOC 必计** 1 段
- 新增 **§大文件拆分实战经验（facade pattern）** 节：facade pattern 定义 / 4 种 ROI 排序表（D pure type +52 / A factory +176 / C free fn +305 / B class +339，按 LOC 增量低增量=高 ROI）/ LOC trade-off 接受现实 / facade barrel re-export byte-identical invariant / mini-spike + user 1-min confirm 3 题 / 不预先抽 _shared/ 大坨
- 新增 **§多轮 Deep-Review 收口经验** 节：双方共识收口判定 / 反驳轮自纠 mental model / fix 后表格 / 描述文字必同步
- 净 +33 LOC (CLAUDE.md 726 → 759)
- 强制按 user CLAUDE.md §提示词资产维护 5 条硬约束 + 5 步自检（约束 1-5 grep verify 全 0 命中违规）

#### Step 6.2: agent-deck 项目特定经验沉淀 = no-op (0 work)

- 候选清单评估结论：所有项已有 SSOT
  - **agent-deck mcp tool 编排经验** → 已在 `resources/claude-config/CLAUDE.md` §Agent Deck Universal Team Backend 节
  - **应用环境特有 reviewer-codex 失败兜底** → 已在 `resources/claude-config/CLAUDE.md` §reviewer-codex 失败 → SKILL 内合规兜底分支 节
  - **hand_off_session baton 语义实践** → 已在 `resources/claude-config/CLAUDE.md` §plan hand-off 自动化：hand_off_session 节
  - **Phase 4 拆分前后 facade 子模块组织模式选择** → Step 6.1 已加进 `resources/claude-config/CLAUDE.md` §大文件拆分实战经验
- `ref/conventions/tally.md` 评估：42 候选（41 count=1 + 1 count=2，**0 候选 count ≥ 3**）→ 0 升级到 `ref/conventions/<X>-<topic>.md`
- **结论**：Step 6.2 不动项目根 `CLAUDE.md` / 不新建 `ref/conventions/02-<topic>.md`

#### Step 6.3: 本 changelog 引用归档 + 同步 INDEX (本文件)

- 新建 `ref/changelogs/CHANGELOG_175.md` (plan §下一会话第一步原写 174 但实际已被 Phase 2 收口 commit `9d55c64` 占用，X 递增到 175)
- 同步 `ref/changelogs/INDEX.md` 加 CHANGELOG_175 行

#### Step 6.4: Phase 6 走 deep-review SKILL kind='mixed' 评审 (待跑)

- scope: Step 6.1 改动文件 (resources/claude-config/CLAUDE.md +33 LOC) + Step 6.3 本 changelog + INDEX
- 评审 focus: prompt asset 5 条硬约束 / 通用 vs 项目特定经验定位准确性 / CHANGELOG 内容完整性
- 双 reviewer 异构对抗 R1+R2 fix 直到 0 HIGH/MED 共识可合

#### Step 6.5: archive_plan mcp tool 5 步收口 (待跑)

- 调用 `mcp__agent-deck__archive_plan({plan_id, worktree_path, base_branch:"main", changelog_id:"174,175"})`
- caller 自动归档 (default `archived='ok'` baton 单向交接语义)
- 整 plan ✅ 完成

## 备注

### Phase 3 通俗化方法论 D7 落地结论

- **宏观角度** ≤ 5 层 / ≤ 12 节点 / 细节进 cmt 描述不进图 — 17 张图全过约束 ✓
- **通俗易懂** 节点名优先日常术语（「主进程模块」「数据库」「外部 CLI」）+ 括号注内部 codename — 全 17 张图 ✓
- **不堆叠** 图本身去 LOC / commit hash / version metadata，INDEX 第 3 列承载关联引用 / 第 4 列概要 ≤ 80 字白话 — 全 INDEX ≤ 80 字 ✓

### Phase 4 facade pattern 5 类 evidence

- **核心 invariant 守约**：facade barrel re-export byte-identical 生产代码 caller import path **0 改动** ✓ + 测试 import path **0 改动** ✓
- **0 runtime circular dep** ✓（本次实测 sub-module → facade 反向 import 0 命中）
- **facade pattern 4 种内部一致**：Pattern A factory / B class shell / C free fn entry / D pure type re-export — 跨 step 无 pattern drift ✓
- **临界文件监控 7 个 ≥ 400 LOC**（含 3 facade 自身 + 4 sub-module）：codex sdk-bridge facade 499 LOC margin 1 ⚠⚠⚠ + team-adopt-coordinator 474 + claude sdk-bridge facade 467 + manager 443 + impl-precheck 439 + app-settings 424 + handler-main 406
- **Phase 4 mini-spike + user 1-min confirm 3 题模式**：11 step 全过 0 pattern drift / 0 user 抱怨 / 0 实施细节争议 → inform §大文件拆分实战经验 节

### Phase 5 Step 5.3 R1+R2 异构对抗价值印证

- **R1 reviewer-claude M1**：REVIEW_63 §临界子模块监控漏审 facade 自身 LOC（典型 codex sdk-bridge facade 499 LOC margin 1）→ 升级为 7 行 §临界文件监控含 facade + sub-module
- **R1 reviewer-codex LC1**：handler-main.ts:50 人为 runtime 依赖（unused import sessionManager）→ 删 + void 占位
- **R2 双方共识** 0 HIGH/MED ✅ + R2 INFO 微同步（REVIEW_63 准则节 + handler-main LOC 411→406 fix-table-sync）→ inform §多轮 Deep-Review 收口经验 节「fix 后表格 / 描述文字必同步」

### 关联

- 父 plan: [`ref/plans/deep-project-review-comprehensive-20260528.md`](../../plans/history/deep-project-review-comprehensive-20260528.md) (Step 6.5 archive_plan 后才生效)
- Phase 2 单独归档: [CHANGELOG_174.md](./CHANGELOG_174.md) (B 维提示词资产精简 8 step)
- Phase 5 review 报告: [REVIEW_63.md](../../reviews/history/REVIEW_63.md)
- 引用历史: REVIEW_61 / REVIEW_62 (前序 deep-review 实证 + prompt asset 5 条硬约束 baseline) / CHANGELOG_172 / CHANGELOG_173 (前序 Deep-Review 修法历史)
- Phase 4.0 spike artifact: `<plan-artifact-dir>/spike-reports/spike1-architecture-dep-graph.md` (Step 6.5 archive_plan 后归档到 `ref/plans/deep-project-review-comprehensive-20260528/spike-reports/`)

### 后续 follow-up

- REVIEW_63 §B Phase 5.1 新发现 3 LOW + 5 INFO + 7 临界文件监控全留 follow-up plan（mcp handlers shotgun-import / manager 158 caller hub / 跨 store/_deps `getById` + `rowToRecord` 重复 helper 等）
- Phase 5 收口期间 user 反馈 task: id `26181f20` priority 6 — mcp tool 入参命名统一驼峰（snake_case → camelCase，breaking change，需独立 plan 2-3 hand off 量级）
