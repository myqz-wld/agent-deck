---
plan_id: "deep-project-review-comprehensive-20260528"
created_at: "2026-05-28T15:00:00+08:00"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-project-review-comprehensive-20260528"
status: "completed"
base_commit: "12e1b81cd2bc144267d3ac8052e69035838d2d35"
base_branch: "main"
session_authorization: ""
final_commit: "6474740faff4522b5b8bd66369cd6f06a7c6a0c1"
completed_at: "2026-05-29"
---
# 全项目 deep review + 4 维优化 plan

## 总目标

对 agent-deck 项目做全面 deep review，4 维并行批次推进：

- **A 代码优化**：拆 13 个 >500 行非测试源文件（剩 ≤500 LOC），高内聚低耦合
- **B 提示词资产精简**：清失败兜底冗余 / 通俗化术语 / 应用自闭环不依赖外部
- **C 架构图通俗化**：8 张 architecture + 9 张 flows 改宏观视角（去细节、去术语堆砌）
- **D 架构合理性 review**：发现严重不合理本 plan 内一锅修，记重要经验沉淀

完成后必沉淀到 `CLAUDE.md` / `ref/conventions/` 适合的位置。

## 不变量（不动以下契约）

- **运行时行为**：拆分 / 重构后所有 IPC / mcp tool / SDK bridge 协议 / DB schema / wire format 严格一致；无任何 user-facing 行为变化
- **mcp tool description 字符串等价**：注入到 SDK system prompt 的 tool definitions 文案 byte-identical（避免 reviewer / agent 重学）；除非单独列出 intentional prompt change
- **架构图不删信息只换形式**：宏观化重写要保留所有 design invariant，只是改组织方式 + 改术语为通俗表达；reviewer/lead 仍能据图理解机制
- **prompt asset 维护硬约束**（user CLAUDE.md §提示词资产维护 5 条）：本 plan 实施全程必守
- **拆分原则**：facade 模式（原 import path 全保留）；新增子模块按功能领域而非行号；测试不动（除非真测试要跟拆）
- **不引新依赖**：除非业务必要，不引入新 npm package
- **deep-review SKILL 多轮异构对抗**：每个 phase **收口前**必走（产物**最终 commit** 前必过 review；phase 内单 Step 的临时 commit 是本地 checkpoint，phase 收口前允许 squash/amend）

## 设计决策（不再争论）

### D1: scope 锁定 13 个 >500 行非测试源文件（全拆）
对应 user Q3 选项「全部」。LOC + 文件路径（基线 commit 12e1b81，`wc -l` 实测）：

| LOC | 文件 |
|---|---|
| 1306 | src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts |
| 1281 | src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts |
| 874 | src/main/adapters/codex-cli/sdk-bridge/index.ts |
| 840 | src/main/adapters/claude-code/sdk-bridge/index.ts |
| 721 | src/main/store/task-repo.ts |
| 686 | src/main/session/manager.ts |
| 670 | src/main/adapters/claude-code/sdk-bridge/recoverer.ts |
| 623 | src/main/window.ts |
| 597 | src/main/adapters/codex-cli/sdk-bridge/recoverer.ts |
| 594 | src/main/index.ts |
| 558 | src/main/adapters/types.ts |
| 544 | src/shared/types/settings.ts |
| 527 | src/main/store/agent-deck-message-repo.ts |

合计 9821 LOC。

**§保护清单（不拆 / 跳过）**：`src/main/agent-deck-mcp/tools/schemas.ts` 1229 LOC 文件头部 line 15-23 已明示「下次拆分轮直接跳过本文件」（70%+ 是 SDK system prompt 注入的 tool description 契约文档，tier-2 directorize 拆 15 文件会让 description 散在 15 文件难统一对齐；tier-1 抽 result types 仅 ~70 行收益小）。本 plan 维护该决策；如 phase 5 D 维 review 出非拆不可的架构理由，单独 follow-up plan 评估。

### D2: phase 串行 + 内部 step 含 spike 子步
对应 user Q1「全 4 项并行批次推进」。实际工作架构：
- phase 之间 **串行**（保证依赖关系：先 review → 后实施）
- phase 内 step 之间能并行 spike 的并行（典型：phase 4 不同文件拆分相对独立，spike 时多个并行）
- **Phase 4 每个 Step 含 4.x.0 子步**「先 spike 子模块边界 + 与 user 1-min confirm 后再拆」（与 §D5 facade pattern 设计意图对齐：facade 保留 import path 但子模块组织仍可能被 phase 5 推翻；本子步给 user 1-min check 防 phase 5 review 出来才发现拆错返工）
- **Phase 5 read-only spike 已前移到 Phase 4.0**（修订）：原 D2 写「Phase 5 spike 早出可触发」语义含糊。**修法**：Step 5.1 architecture dep spike 已挪到 Phase 4.0 作为 Phase 4 入口前置必跑（read-only，不动代码不实施重构）→ 与 D2 phase 串行原则一致（不破坏「先 review → 后实施」）；Phase 5 现在仅含「report 写作 + HIGH 重构 + dist 验证」3 step
- 每个 phase 收口前过 `/agent-deck:deep-review` SKILL 评审（必走）

### D3: 进 worktree
对应 user Q2「进 worktree」。worktree_path 见 frontmatter。

### D4: 架构问题本 plan 内一锅修
对应 user Q4「本 plan 内一锅修」。
- phase 5 D 维 review 发现的「严重不合理架构」直接进 phase 5.2 重构
- scope creep 控制：单点重构 ≤ 5 文件 / ≤ 800 LOC 改动半径；超出走 commit 留 follow-up plan（不在本 plan 强推）

### D5: 拆分技术方案 (facade pattern)
原文件改为 facade 仅 re-export 子模块 API；子模块按功能领域分目录（如 `hand-off-session/{plan-mode,generic-mode,task-reassign,team-adopt}.ts`）。
- 原 import path 全保留（外部 caller 不感知）
- 子模块测试就近放（每子模块独立测试 → 总测试覆盖率不降）
- 共性 helper 抽到 `_shared/` 子目录

**测试文件不拆**：默认不拆（按 fixture 重组 ROI 低）；除非单测文件 > 2000 LOC 或 PR review 反复抱怨可读性，才单独建 follow-up plan（2000 = 当前最大 1778 + ~200 余量；未来测试自然增长触阈值再调）。

### D6: 提示词资产精简方法论
对应 user B 维要求。三条具体方法：
- **清失败兜底冗余**：每条 fallback 都问「不写会怎样？」答「无伤大雅」就删；保留「不写会破坏 invariant」的
- **通俗化术语**：术语堆砌的句子拆成两行（一行术语 + 一行白话解释 + 一行典型样例）；用日常工作场景类比代替架构名词
- **应用自闭环（已有 placeholder 机制）**：复用 `{{AGENT_DECK_RESOURCES}}` 模板变量（CHANGELOG_168 已落地，机制 SSOT 在 `src/main/utils/resources-placeholder.ts`，5 个注入点已串联）。
  - **替换范围**：仅替换硬编码本应用 bundled resources path（如 `/Applications/Agent Deck.app/Contents/Resources/...`）；本轮 grep prompt asset 实测命中 0 处（CHANGELOG_168 已全替换），phase 2 实际工作量为 0，仅 spike verify 0 残留 + 后续如发现新增立刻处理。
  - **不替换**：`~/.claude/` / `~/.codex/` / `<main-repo>/.claude/plans/` 这类**用户配置文件位置 / 跨项目语义路径**（属约定描述，非硬编码 app path）；prompt asset 内 7 处 `~/.claude/` 都是语义引用保留不动。

### D7: 架构图通俗化方法论
对应 user C 维要求。「宏观角度通俗易懂不堆叠术语」的具体落地：
- **宏观角度**：每张图只画 ≤ 5 层 / ≤ 12 节点；细节进 cmt 描述不进图
- **通俗易懂**：节点名优先用日常术语（「主进程模块」「数据库」「外部 CLI」）+ 括号注内部名（component diagram 才出现 `agent-deck-mcp` 这类 codename）
- **不堆叠**：图本身去 LOC / commit hash / version 等 metadata；INDEX.md 第 3 列「关联 plan / commit」承载这些引用，第 4 列「概要」精简到 ≤ 80 字白话描述（当前 `ref/architecture/INDEX.md` 概要列写满 LOC + commit hash 需重写）

### D8: session_authorization 是 ad-hoc frontmatter 扩展
本字段**不被** `archive_plan` handler 读（grep `session_authorization` src/main 0 命中），仅供 cold-start 新会话引用确定授权范围。属 plan 内 ad-hoc 扩展不进应用 CLAUDE.md §Step 1 frontmatter 标准字段表。

### D9: codex 端 SKILL.md 无 tracked source mirror（Step 2.1 spike 校正 D6 / Step 2.6 误判；R2 LOW-1 精确化）
**Phase 2 Step 2.1 spike 实测**：`resources/codex-config/agent-deck-plugin/skills/` 不存在 tracked SKILL.md 副本（`.gitignore:18` 显式忽略本目录）。原 D6 / Step 2.6 沿用了「codex 端 2 份 SKILL 是 dead mirror」表述属误判（暗示 source repo 内有冗余副本待删，实际 tracked source 从未提交）。

**实际机制**：
- SKILL.md tracked SSOT 单源在 `resources/claude-config/agent-deck-plugin/skills/`（实测 3 份：deep-review / flow-arch-plantuml / hello-from-deck）
- 其中 deep-review / flow-arch-plantuml 两份 SKILL.md 第 6 行注释明示 `<!-- Agent Deck SKILL SSOT: edit this claude-config copy; codex-config mirror is generated by scripts/sync-codex-skills.mjs. -->`；**hello-from-deck 例外不带此注释**（6 行 trivial self-check skill，定位极简不加 metadata）
- build/dev 同步：`package.json` `predev` / `prebuild` / `predist` hooks 自动跑 `scripts/sync-codex-skills.mjs`，从 tracked SSOT 生成 `resources/codex-config/agent-deck-plugin/skills/` 镜像（**.gitignore 忽略不入 git**，仅 build artifact）
- runtime 同步：`src/main/codex-config/skills-installer.ts:syncSkills()` 在应用启动 / settings toggle 时把 SSOT 同步到用户端 `~/.codex/skills/agent-deck/<X>/SKILL.md`

**Step 2.6 修正**：本 plan 仅精简 claude-config 端 3 份 SKILL.md（tracked SSOT）；codex 端 build mirror 下次 build 时由 hooks 自动同步 + runtime 自动写 `~/.codex/skills/`（不需手工同步 / 无 tracked source 副本可删 / 不需要 follow-up plan）。

**实测命令铁证**（2026-05-29 / Phase 2 Step 2.1）：
```bash
$ wc -l resources/codex-config/agent-deck-plugin/skills/deep-review/SKILL.md
wc: ... open: No such file or directory
```

## 步骤 checklist

### Phase 1: scope 锁定 + 设计方案对齐（当前会话完成）

- [x] Step 1.1 — 收集 13 大文件 LOC + 内部子模块结构 grep（commit 12e1b81 实测，schemas.ts 1229 走 §保护清单 跳过）
- [x] Step 1.2 — 写 plan 文件
- [x] Step 1.3 — 进 §Step 1.5 deep-review SKILL 评 plan（plan 通过才进 worktree）
- [x] Step 1.4 — 用户 confirm 进 worktree → EnterWorktree(path:) → 自检 HEAD = base_commit

### Phase 2: B 维提示词资产精简（next session 起）

- [x] Step 2.1 — spike：(a) 反向 grep verify 硬编码 app bundled path 0 命中 — `grep -RIn "/Applications/Agent Deck.app/Contents/Resources" resources/claude-config resources/codex-config`（**期望 0 命中**；非 0 → 替换为 `{{AGENT_DECK_RESOURCES}}`）；(b) 正向 grep verify `{{AGENT_DECK_RESOURCES}}` placeholder 应保留 — `grep -RIn "{{AGENT_DECK_RESOURCES}}" resources/claude-config resources/codex-config`（**期望 ≥ 1 命中** in prompt asset；placeholder 是 canonical source-side 模板，运行时 `substituteResourcesPlaceholder` 替换为 resources root，**不能删**）；(c) 列每份 prompt asset 所有 fallback 候选 / 通俗化对象，按精简方法论分类
- [x] Step 2.2 — `resources/claude-config/CLAUDE.md` (726 LOC) 精简：fallback 冗余清理 + 通俗化
- [x] Step 2.3 — `resources/codex-config/CODEX_AGENTS.md` (251 LOC) 同款精简 + claude/codex mirror parity check
- [x] Step 2.4 — `resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md` 精简
- [x] Step 2.5 — `resources/codex-config/agent-deck-plugin/agents/reviewer-codex.md` 精简
- [x] Step 2.6 — 3 份 SKILL.md 精简（claude 端：deep-review / flow-arch-plantuml / hello-from-deck）。**注**（§D9 校正）：SKILL.md SSOT 单源在 claude-config，codex 端不存在 source 副本（runtime 通过 `syncSkills()` 自动镜像到 `~/.codex/skills/agent-deck/<X>/`）；本 plan 仅改 claude-config 端，codex 端下次应用启动自动同步更新版
- [x] Step 2.7 — 全 prompt asset 走 deep-review SKILL kind='mixed' 评审 → 0 HIGH/MED 才合
- [x] Step 2.8 — 沉淀经验：`resources/claude-config/CLAUDE.md` §提示词资产维护节按本轮经验补充 / 升级 ref/conventions

### Phase 3: C 维架构图通俗化（hand off 1 触发点）

- [x] Step 3.1 — spike：审 8 张 architecture + 9 张 flows 图当前节点数 / 层数 / 术语密度 / 重复度，制定通俗化重写计划
- [x] Step 3.2 — 通俗化重写 8 张 architecture .puml（宏观重画，细节进 cmt）
- [x] Step 3.3 — 通俗化重写 9 张 flows .puml（同款）
- [x] Step 3.4 — 同步 ref/architecture/INDEX.md / ref/flows/INDEX.md 第 4 列概要（≤ 80 字白话），LOC + commit hash 进第 3 列「关联 plan / commit」（D7）
- [x] Step 3.5 — flow-arch-plantuml SKILL 评审通过（reviewer 检查覆盖完整）— **完成 2026-05-29 hand off 6** (deep-review SKILL kind='mixed' 4 轮异构对抗 R1-R4 / 11 finding / 4 commit 一齐 sequence / 双方 R4 共识 0 HIGH/MED ✅ 可合)

### Phase 4: A 维大文件拆分（最大工作量 phase）

按拆分难度 + 协作面影响排序。**Phase 4 入口必跑 Step 4.0**（read-only architecture spike，输出 inform 后续所有 Step 4.x.0 confirm 决策）。每个文件 Step 内含 4 子步「**Step 4.x.0 mini-spike 子模块边界 + user 1-min confirm** → 拆 → typecheck/test → 临时 commit」，整体 phase 收口前 squash/amend。

**user 1-min confirm 范围**：仅 confirm (1) 子模块名 / (2) 边界划法 / (3) 是 entity 域 / 功能域 / 行为域 — **不 confirm 实施细节**（function 命名 / import 顺序 / typecheck 错误等 lead 自决）。

- [x] Step 4.0 — **read-only architecture spike**（前置必跑，inform 后续所有 Step 4.x.0）：`grep` main 模块依赖图（import 关系）+ 找 circular dep / 不合理耦合 / 重复抽象 → 输出 `<plan-artifact-dir>/spike-reports/spike1-architecture-dep-graph.md`（design decisions evidence per §Step 0.5）。**不动代码不实施重构**，read-only 不破坏 D2 phase 串行。重构落 Phase 5.2
- [x] Step 4.1 — `hand-off-session.ts` 1306 拆 plan-mode / generic-mode / task-reassign / team-adopt / facade
- [x] Step 4.2 — `archive-plan-impl.ts` 1281 拆 precheck / ff-merge / archive-fs / cleanup / facade
- [x] Step 4.3 — `codex sdk-bridge/index.ts` 874 + `recoverer.ts` 597 一起拆（对偶；index.ts → recoverer.ts 单向 import 实证）。**改动半径 ≥ 1471 LOC** → **跨文件互依赖 full spike 必跑**（≥ 30min 深入分析 SessionRecoverer class + N 个 helper 子模块归属），不走 4.x.0 mini-spike；或按依赖顺序拆成 4.3a recoverer / 4.3b index 各 step 串行
- [x] Step 4.4 — `claude sdk-bridge/index.ts` 840 + `recoverer.ts` 670 一起拆（对偶，同 Step 4.3 互依赖结构）。**改动半径 ≥ 1510 LOC** → **跨文件互依赖 full spike 必跑**（≥ 30min，同 Step 4.3 互依赖结构）或拆 4.4a / 4.4b 串行
- [x] Step 4.5 — `task-repo.ts` 721 拆 CRUD / scope / list / cleanup
- [x] Step 4.6 — `manager.ts` 686 拆 sdk-claim / lifecycle / rename / facade
- [x] Step 4.7 — `window.ts` 623 拆 frame / interaction / lifecycle / facade
- [x] Step 4.8 — `index.ts` 594 拆 bootstrap / wiring / facade — **完成 2026-05-29 hand off 14** (commit `4457a2d`，5 文件 facade 74 + _deps 89 + bootstrap-infra 262 + bootstrap-wiring 225 + lifecycle-hooks 118，与 Step 4.7 window.ts 同款 5 文件 pattern;BootstrapState 5 字段 mutable interface;+174 LOC 增量最低)
- [x] Step 4.9 — `types.ts` 558 spike 先看 8 export 真实 entity 分组（`grep -c '^export'` = 8）→ **facade 必拆**让原文件 ≤ 500 LOC（与 D1「13 文件全拆 ≤500 LOC」契约一致，不留例外）：≥ 3 entity 域走 entity 域子模块；≤ 2 域走「主 facade re-export + 抽 ≤ 200 LOC subset 到 1 子模块」让原 facade 文件降到 ≤ 500。Step 4.0 architecture spike 输出 inform 本 step entity 域边界 — **完成 2026-05-29 hand off 14** (commit `e18da65`，5 文件 facade 21 + adapter-context 20 + create-session-opts 313 + capabilities 58 + agent-adapter 201;纯 declaration + re-export 增量 +55 LOC **史上最低**;32 caller import 全 byte-identical)
- [x] Step 4.10 — `settings.ts` 544 拆按 settings 域 — **完成 2026-05-29 hand off 15** (commit `ee4cf3b`，4 文件 facade 31 + app-settings 424 + defaults 64 + permission-scan 74,entity 严格划分与 Step 4.9 同款 5 文件 pattern;保 AppSettings 单一 flat interface 不破坏 cross-process JSON shape;+49 LOC **史上最低增量**;200 caller barrel re-export byte-identical)
- [x] Step 4.11 — `agent-deck-message-repo.ts` 527 拆 CRUD / dispatch / state-machine + facade — **完成 2026-05-29 hand off 16** (commit `4a573a4`,5 文件 facade 111 + _deps 201 + crud 121 + dispatch 88 + state-machine 142;沿用 Step 4.5 task-repo 同款 factory pattern;+136 LOC trade-off **第二低**仅次于 Step 4.10+49)
- [x] Step 4.12 — phase 4 整体走 deep-review SKILL 评审 + `pnpm typecheck` + `pnpm build` + `pnpm dist`（P26 教训：dist 才覆盖 electron-builder asar 化 + extraResources copy + native binary unpack 的真打包步骤）— **完成 2026-05-29 hand off 16** (commit `14aee43` R1 codex HIGH-1 fix archive-plan-impl.ts facade 补 postFfMergeErr value re-export;3 build 全过;deep-review SKILL 2 轮异构对抗 R1+R2 双方 R2 共识 0 HIGH/MED 可合;Phase 4 收口全部完成)

### Phase 5: D 维架构合理性 review + 必要重构

- [x] Step 5.1 — review 报告（写到 ref/reviews/REVIEW_X.md）：基于 Step 4.0 read-only spike 输出 + Phase 4 拆分实施观察，分级列出问题 — **完成 2026-05-29 hand off 17** (写 `ref/reviews/REVIEW_63.md` + 同步 `ref/reviews/INDEX.md`;spike1 §A1 列出的 7 HIGH + 1 MED candidate **全部 ✅ 100% Phase 4 已落地** = Step 5.2 重构 = 0 work;新发现 finding 全为 3 LOW + 5 INFO + 7 临界文件监控 (含 3 facade 自身 + 4 sub-module),全留 follow-up plan;**R2 fix 后由 4 子模块 → 7 含 facade 自身**,M1 fix commit 8925fb5)
- [x] Step 5.2 — phase 5.1 HIGH 重构（单点 ≤ 5 文件 / ≤ 800 LOC 改动半径），MED/LOW 留 follow-up plan
- [x] Step 5.3 — phase 5 走 deep-review SKILL 评审 + `pnpm typecheck` + `pnpm build` + `pnpm dist`

### Phase 6: 经验沉淀

- [x] Step 6.1 — 通用工程经验沉淀到 `resources/claude-config/CLAUDE.md`(应用打包给**所有项目**的通用约定层;2026-05-29 user 纠正:不动 `~/.claude/CLAUDE.md` user 私有 SSOT)
- [x] Step 6.2 — agent-deck 项目特定经验沉淀到**项目根目录** `CLAUDE.md` 或 `ref/conventions/<X>-<topic>.md`(2026-05-29 user 纠正:`resources/claude-config/CLAUDE.md` 是应用打包给**所有项目**的不能放本项目特定经验,本项目特定经验只能放项目根 CLAUDE.md;通用工程经验才进 `resources/claude-config/CLAUDE.md`)
- [x] Step 6.3 — 写 CHANGELOG_X 引用归档 + 同步 INDEX
- [x] Step 6.4 — Phase 6 全 prompt asset / CHANGELOG / convention 改动走 deep-review SKILL kind='mixed' 评审 (§不变量「每个 phase 收口前必走 SKILL」)
- [ ] Step 6.5 — 走应用 CLAUDE.md §Step 4 完成节 5 步收口（ExitWorktree(keep) + archive_plan mcp tool）

## 当前进度

**Phase 1 全部完成**（2026-05-28 / hand off 1）：
- ✅ Step 1.1 完成（13 大文件 LOC + handlers 内部子模块 grep 完毕；schemas.ts 走 §保护清单 跳过；总 13 文件 9821 LOC）
- ✅ Step 1.2 完成（plan 文件本身落 `.claude/plans/deep-project-review-comprehensive-20260528.md`）
- ✅ Step 1.3 完成（deep-review SKILL R1-R4 4 轮异构对抗：35 finding / 33 处 fix / 4 处双方独立 / 1 处反驳成立降级 / 双方 explicit ✅ 可合）
- ✅ Step 1.4 完成（user confirm 进 worktree → Bash `git worktree add -b worktree-deep-project-review-comprehensive-20260528` + EnterWorktree(path:) 两步形式建后进入 → 自检 HEAD = 12e1b81 = base_commit ✓ + worktree clean ✓）

**Phase 2 进行中**（2026-05-29 起 / hand off 2 cold-start 接力）：
- ✅ Step 2.1 完成（spike (a)(b)(c) 三子步全跑通；user confirm 推荐路径推进）
- ✅ Step 2.2 完成（claude-config/CLAUDE.md 精简，commit `694746e`；A1-A4 fallback 镜像合并 + B1-B3 通俗化；净 -3 LOC，729→726）
- ✅ Step 2.3 完成（codex-config/CODEX_AGENTS.md 精简，commit `2d00e09`；B1-B4 通俗化；净 +4 LOC 反向，253→257 — codex SDK 加载机制独立无法做 fallback 镜像合并，通俗化为主信息密度提升）
- ✅ Step 2.4+2.5 完成（reviewer-{claude,codex}.md 双文件同步精简，commit `2b8dade`；§核心纪律 第 7 条 Fresh session 加白话 TL;DR 前置；LOC 不变 144/140）
- ✅ Step 2.6 完成（deep-review SKILL.md 精简，commit `8b24680`；§Sandbox 处理 7 步前置 TL;DR；LOC 217→219；flow-arch / hello-from-deck 不改 — 按 §D9 校正 codex 端 runtime 自动镜像）
- ✅ Step 2.7 完成（2026-05-29 / hand off 3；deep-review SKILL kind='mixed' 评审 2 轮异构对抗 R1+R2 共 5 finding；R1 3 条 fix commit `5347c14` (CLAUDE/CODEX_AGENTS task 删除时机精确化 + SKILL Sandbox TL;DR worktree→reviewRoot + plan §当前进度 LOC +8→+3)；R2 LOW-1 plan §D9 措辞精确化 (顺手修，plan 文件 SSOT 不入 worktree commit)；R2 INFO-1 按 reviewer-claude 推荐保留；R2 收口判定 0 HIGH/MED + 双方共识 ✅）
- ✅ Step 2.8 完成（2026-05-29；ref/conventions/tally.md `# Agent 踩坑候选` 新增 P35 + P36 两条 count=1；P35 claude/codex 双端 mirror 对偶 grep 实测 / P36 plan 行级 reference grep+wc+ls 实测铁证；不动 resources/claude-config/CLAUDE.md（plan 写法偏差—该节在 user CLAUDE.md 私有不入项目 git，user confirm 路径 (a) 仅入 tally.md 候选）；Phase 2 收口前最后 step）

**Phase 2 全部完成**（2026-05-29 / hand off 4 准备）：
- ✅ 8 step 全完成（2.1 spike / 2.2-2.6 5 份 asset 精简 / 2.7 deep-review SKILL kind='mixed' 2 轮异构对抗 / 2.8 沉淀经验）
- ✅ 6 commit 一齐 sequence（worktree clean）:
  - `694746e` Step 2.2 claude-config/CLAUDE.md
  - `2d00e09` Step 2.3 codex-config/CODEX_AGENTS.md
  - `2b8dade` Step 2.4+2.5 reviewer pair
  - `8b24680` Step 2.6 deep-review SKILL.md
  - `5347c14` Step 2.7 R1 fix (3 finding)
  - `9d55c64` Phase 2 收口 (CHANGELOG_174 + tally + INDEX)
- ✅ R1+R2 deep-review SKILL kind='mixed' 共 5 finding / 4 actionable fix + 1 INFO 保留 / 双方 0 HIGH/MED 共识可合
- ✅ ref/changelogs/CHANGELOG_174.md 完整归档 + ref/changelogs/INDEX.md 同步
- ✅ ref/conventions/tally.md P35 + P36 沉淀候选（count=1 静默累积）
- ✅ R2 LOW-1 plan §D9 措辞精确化 (顺手修, plan SSOT 更新)

**Phase 3 进行中**（2026-05-29 起 / hand off 5 准备）：
- ✅ Step 3.1 完成（2026-05-29;spike2 audit 17 张图量化数据 + Tier 1/2 分级 + 38 条术语映射表 + 工作量估算 5-7h;落 `<plan-artifact-dir>/spike-reports/spike2-architecture-figure-audit.md`;**worktree 干净不入 worktree commit** spike report 在 plan artifact dir 外置位置）
- ✅ User confirm 4 决策（全选推荐）:
  - **Q1 分级方案**: 同意 Tier 1 严重违规（8 张, LOC 129-192）+ Tier 2 中度违规（9 张, LOC 86-121）
  - **Q2 术语映射方向**: 同意 38 条 module 文件名 / codename → 日常术语 / SQL 细节移到 ADR-REVIEW.md;实施时按需局部调整
  - **Q3 顶层架构图分层**: 同意 agent-deck-mcp-architecture 拆成「概览图（5 packages 顶层）+ 8 张专题子图（已存在）」分层
  - **Q4 commit 粒度**: 同意 Step 3.2（8 architecture）→ 3.3（9 flows）→ 3.4（INDEX）三阶段 commit
- ✅ Step 3.2 完成（2026-05-29 / hand off 5 cold-start;8 张 architecture .puml 重写,1021→621 LOC -39%;commit `8e01831`;全部通过 D7 ≤ 5 层 / ≤ 12 节点 / 节点名通俗化）
- ✅ Step 3.3 完成（2026-05-29 / hand off 5 cold-start 续;9 张 flows .puml 重写,1185→756 LOC -36%;commit `ec7e190`;全部通过 D7 ≤ 4 partition / ≤ 10 participant）
- ✅ Step 3.4 完成（2026-05-29 / hand off 5 cold-start 续;2 份 INDEX.md 概要列全部缩到 ≤ 80 字白话;commit `0a578a3`）
- ✅ Step 3.5 完成（2026-05-29 / hand off 6 cold-start;deep-review SKILL kind='mixed' 4 轮异构对抗 R1-R4 共 11 finding / 6 HIGH + 4 MED + 1 INFO + 1 *未验证*→✅;4 commit 一齐 sequence;双方 R4 共识 0 HIGH/MED ✅ 可合;reviewer-claude/codex 已 shutdown + SKILL cache 已清）

**Phase 3 全部完成**（2026-05-29 / hand off 6 准备进 Phase 4）：
- ✅ 5 step 全完成（3.1 spike audit / 3.2 8 架构图重写 / 3.3 9 流程图重写 / 3.4 INDEX 同步 / 3.5 4 轮 deep-review SKILL）
- ✅ 9 commit 一齐 sequence（worktree clean）:
  - `8e01831` Step 3.2 8 张 architecture
  - `ec7e190` Step 3.3 9 张 flows
  - `0a578a3` Step 3.4 2 份 INDEX
  - `710b100` Step 3.5 R1 fix (5 HIGH + 1 MED, 8 files +97/-44)
  - `6649d4b` Step 3.5 R2 fix (1 HIGH + 2 MED, 3 files +20/-6)
  - `f6a88e6` Step 3.5 R3 fix (1 MED RoleState 漂移, 1 file +2/-1)
  - `9a03b46` Step 3.5 R4 polish (INFO-R4-1 优先级 note, 1 file +3/-0)
- ✅ Step 3.5 R1-R4 4 轮异构对抗:11 finding / 10 actionable fix + 1 *未验证*→✅,双方 R4 共识 0 HIGH/MED 可合
- ✅ R1 5 HIGH (extra_allow_write / alt-opt 语法 / adopt timing / archive_caller skip / base_branch fallback) + 1 MED (INDEX ≤80 byte) + 1 *未验证* puml syntax 升级 ✅ (java -jar plantuml.jar exit=0)
- ✅ R2 1 HIGH (state-machine teammate 漏改) + 2 MED (marker 兜底文案 / 概览图 cross-ref 9 张 flow)
- ✅ R3 1 MED (RoleState 同主题漂移 — caller/teammate/role/task 4 entity 全画 archive_caller=false)
- ✅ R4 0 HIGH/MED 双方共识可合 + 1 INFO (优先级 note) 顺手吃

**Phase 3 工作量统计**（17 张图 + 2 INDEX baseline → R4 收口）:
- architecture 8 张: 1021 → 621 LOC = -400 LOC (-39%)
- flows 9 张: 1185 → 756 LOC = -429 LOC (-36%)
- INDEX 2 份: 概要列从 200-400+ 字 → 22-35 字（中文字符）
- Step 3.5 R1-R4 fix 增量: +122 LOC -51 LOC (4 commit)
- **总计 17 张图: 2206 → 1377+71=1448 LOC = -758 LOC (-34%)** + 信息密度大幅提升 + 设计 invariant 完整性经 4 轮异构对抗验证

**Phase 4 进行中**（2026-05-29 / hand off 7 cold-start 接力）：
- ✅ User confirm Phase 4 节奏 Q1=「一路推进」+ Q2=「本会话内完成 Step 4.0 spike」(均推荐选项)
- ✅ Step 4.0 完成（2026-05-29 / hand off 7;read-only architecture spike;落 `<plan-artifact-dir>/spike-reports/spike1-architecture-dep-graph.md` 14.8 KB；read-only 不入 worktree commit per Phase 3 Step 3.1 同款约定）
- ✅ spike 关键发现:
  - **F1**: 7 文件已 partial-split 但 facade 仍胖（残留巨函数 300-1040 LOC inline）；6 文件真原始巨型 / 纯类型 declaration
  - **F2**: ✅ 未发现 runtime circular dep（manager → sub-modules 仅 type-only import + 注释引用；sdk-bridge index → recoverer 单向；双 adapter 端互不引用）
  - **F3**: ❓ mcp handlers shotgun-import session/manager + sessionRepo + agentDeckTeamRepo + eventBus — `_shared/mcp-handler-deps.ts` bundle facade nice-to-have；**超本 plan scope** → follow-up plan candidate
  - **F4**: ❌ main/index.ts bootstrap 392 LOC god-function 必拆（Step 4.8）
  - **F5**: ✅ task-repo / agent-deck-message-repo factory pattern 拆分阻力低
  - **F6**: ✅ adapters/types.ts + shared/types/settings.ts 纯类型 declaration 按 export interface 拆即可
  - **F7**: ⚠️ Step 4.3/4.4 跨文件互依赖**只是单向**(index → recoverer)，**mini-spike 充足非 full spike**
  - **F8**: ⚠️ manager.ts hub 35 caller 拆分必保 byte-identical singleton + #sdkOwned 真私有不能拆出 class
  - **F9**: ✅ window.ts FloatingWindow 17 method 真原始巨型，method 域拆即可
- ✅ **推荐拆分顺序**（spike F9 提议，与 D1 LOC 降序不同）:
  - 先低风险 / 纯结构（Step 4.9 / 4.10 / 4.7 / 4.11 / 4.5 / 4.8）让 layout 经验 inform 后续
  - 再 hub 级（Step 4.6 manager 35 caller）
  - 最后大 handler / sdk-bridge（Step 4.1 / 4.2 / 4.3 / 4.4 巨函数 multi-phase 顺序硬约束）
- ✅ Phase 5.1 D 维 review candidate finding list 已 inform（7 HIGH 全在 Phase 4 内修，LOW/INFO 留 D 维报告）
- ✅ User confirm Phase 4 节奏「继续」(本会话起 Step 4.1 mini-spike)
- ✅ Step 4.1 mini-spike 完成（2026-05-29 / hand off 7;grep handOffSessionHandler 1040 LOC 内部 phase 边界 + 4 大功能区识别）
- ✅ User confirm Step 4.1 子模块边界 = **4 实质 + facade**（细化版,推翻 spike1 propose 5 子模块 — 因 plan-mode/generic-mode 分流已在 sister file hand-off-session-impl 内 split）:
  - **facade** (`hand-off-session.ts` ≤ 200 LOC) — re-export + types + helper imports
  - **cwd-resolver** (`hand-off-session/cwd-resolver.ts` ~210 LOC) — caller cwd 注入 + finalCwd 推导 + extra_allow_write 计算 (handler line 1-210)
  - **team-adopt-coordinator** (`hand-off-session/team-adopt-coordinator.ts` ~445 LOC) — adopt_teammates 互斥校验 + N5 fail-fast precheck + 真正 adopt + swapLead (handler line 210-770 不含 spawn)
  - **task-reassign-coordinator** (`hand-off-session/task-reassign-coordinator.ts` ~205 LOC) — task reassign 三态 policy clear-team / preserve-team / skip (handler line 770-975)
  - **handler-main** (`hand-off-session/handler-main.ts` ~250 LOC) — handler 主入口 + spawn 调用 + archive caller + return ok (handler line 440-525 + 975-1040)
- ✅ User confirm 本会话 hand off 下会话实拆（Step 4.1 实拆估 1 hand off 量级，本会话已用 substantial context）
- ✅ Step 4.1 实拆完成（2026-05-29 / hand off 8;commit `f152289`）:
  - **decision 矛盾解决**:source file jsdoc 标记「CHANGELOG_169 F1 §保护清单不动文件」(理由闭包 10+ 变量抽 sub-module 需打包 args dict 反而降可读性) vs plan §D1「13 文件全拆」对立。stop ask user → user 选「强行按 mini-spike 拆」方案 — 子模块间通过函数 return value 传递派生 state（避免单一巨型 ctx object 闭包污染,保函数式 readability）
  - **拆分布局**(每文件 ≤ 500 LOC 满足护栏,facade ≤ 200 LOC 满足 mini-spike user confirm):
    - facade `hand-off-session.ts` 40 LOC — 薄 re-export
    - `hand-off-session/_deps.ts` 102 LOC — 共享 HandOffSessionHandlerDeps interface (避免 facade ↔ handler-main 类型循环)
    - `hand-off-session/cwd-resolver.ts` 253 LOC — caller cwd 反查 + mergeCallerCwd + planModeDefaultCwd / worktreeExists 决策 / extra_allow_write 推导
    - `hand-off-session/team-adopt-coordinator.ts` 474 LOC — N2.c 互斥 + N5 fail-fast + memberships 分类 + adoptedSnapshot 装配 + cold-start prompt prepend + phase 1.5 swapLead loop + processSwappedTeam helper
    - `hand-off-session/task-reassign-coordinator.ts` 308 LOC — task 三态分流 + preserve-team safety 差集算法
    - `hand-off-session/handler-main.ts` 411 LOC — handler 主入口串联 4 子模块
  - **总 LOC**:1306 → 1588 (含 facade) +282 LOC,理由 helper signature + interface + jsdoc 重复成本(每子模块独立 jsdoc 重复 §设计要点)
  - **typecheck pass**:`tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json` 都过
  - **测试 import path 不动**:5 个 test 文件 import handOffSessionHandler from facade / HandOffSessionHandlerDeps from facade,re-export 保 byte-identical export
- ✅ Follow-up task 沉淀 (id `e1493ecd-7600-451f-97a5-24d8c3f0ca2e`):用户在 Step 4.1 实拆中途插话「应用现在运行时日志打印到哪里」+「记作 follow-up,需要输出日志到文件 + 应用内有按钮直接查看」。grep 实测应用没用任何日志库(electron-log / winston / pino 都没装),console.* 走 Electron 主进程 stdout/stderr 双击启动时全丢失 + renderer 走 Chromium DevTools 默认看不到。Follow-up 含选型 / 落盘位置 / UI 入口 / 隐私脱敏等考虑,本 plan 收口后或单独提案触发
- ✅ Step 4.2 mini-spike 完成（2026-05-29 / hand off 9;grep archivePlanImpl 1025 LOC 内部 14 step phase 边界 + sister file `archive-plan/` 子目录已有 2 helpers）
- ✅ User confirm Step 4.2 子模块边界 = **4 实质 + facade**:
  - **facade** `archive-plan-impl.ts` ≤ 200 LOC — thin orchestrator + types/helpers re-export
  - **precheck** `archive-plan/impl-precheck.ts` ~430 LOC — Step 1-6 + 6.5 + worktreeBranch 命名约束 (mainRepo / worktreeBranch / planFilePath / fm / archivedPath / indexPath / mainRepoClean / releaseMarkerOnSuccess 派生)
  - **ff-merge** `archive-plan/impl-ff-merge.ts` ~210 LOC — Step 7-8c (effectiveBaseBranch 派生 + checkout + merge --ff-only + fresh re-read + fresh status revalidate;finalCommit / freshFm / freshContent 派生)
  - **archive-fs** `archive-plan/impl-archive-fs.ts` ~250 LOC — Step 9-12.5 (frontmatter update + 写 archived plan + INDEX 同步走 indexSyncFlight 单飞 + unlink 原 plan + spike-reports/ 归档;plansIndexAction / spikeReportsArchived 派生)
  - **cleanup** `archive-plan/impl-cleanup.ts` ~250 LOC — Step 13-14 (filesToAdd 派生 + git add + commit pathspec 隔离 + archiveCommit rev-parse + clearCwdReleaseMarker + worktree remove + branch -D)
  - **+ 共享层** `archive-plan/_impl-shared.ts` ~280 LOC — types (ArchivePlanInput/Result/Error/Deps + 4 子模块 XxxResult interfaces + PostFfMergePhase) + helpers (isError generic + postFfMergeErr + formatLocalDate + stripFrontmatter) + DEFAULT_DEPS + indexSyncFlight 单飞 Map
- ✅ Step 4.2 实拆完成（2026-05-29 / hand off 9;commit `8969654`）:
  - **拆分布局** (每子模块 ≤ 500 LOC 护栏,facade 189 LOC 满足 mini-spike user confirm):
    - facade `archive-plan-impl.ts` 189 LOC (1281 → 189, -1092 LOC)
    - `archive-plan/_impl-shared.ts` 346 LOC (新)
    - `archive-plan/impl-precheck.ts` 439 LOC (新)
    - `archive-plan/impl-ff-merge.ts` 232 LOC (新)
    - `archive-plan/impl-archive-fs.ts` 280 LOC (新)
    - `archive-plan/impl-cleanup.ts` 255 LOC (新)
  - **总 LOC**:1281 → 1741 (含 facade + 6 子模块,与已有 precheck-helpers/index-sync-helpers 218+174 不重叠) +460 LOC trade-off (与 Step 4.1 +282 LOC 同款增量原因:每子模块独立 jsdoc 重复 §设计要点 + ctx interface signature 重复 + post-ff-merge phase hint string 重复)
  - **isError type guard generic 化**:`<T>(x: T | ArchivePlanError): x is ArchivePlanError` 让 5 种 result 形状判断(PrecheckResult / FfMergeResult / ArchiveFsResult / CleanupResult / ArchivePlanResult)都成立;test seam `_isArchivePlanError` 同款语义
  - **typecheck pass**:`tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json` 都过
  - **测试 import path 不动**:7 test 文件 import path 零改动;archive-plan.impl-* 6 test 文件 112 case 全过;archive-plan.handler.test.ts 8 case fail 是 baseline 同款 Electron binary 环境问题 (git stash baseline 重跑同款失败实证,与本拆分无关)
- ✅ Step 4.3 mini-spike + 实拆完成（2026-05-29 / hand off 8 续;commit `23cb39b`）:
  - **mini-spike 实测**:F7 ✓ `index.ts:45 from './recoverer'` 单向 import;`recoverer.ts` 0 反向 import;已有 14 partial-split helper(constants/types/codex-binary/codex-jsonl-fallback/codex-recoverer-messages/create-session-rollback/input-pack/restart-controller/resume-path-await/session-finalize/thread-loop/thread-options-builder);`index.ts` hot spot:createSession 巨型 method L298-684 (~386 LOC,try/catch 主体 + resume path L545-632 + new path L633-668);`recoverer.ts` hot spot:recoverAndSend 巨型 method L186-509 (~324 LOC) + 3 export helper L511-end + RecovererCtx + 4 type L67-150
  - **User confirm**:方案 A 整体一 step 拆(单向依赖耦合度低) + index 中等粒度(createSession 拆 validate/resume/new 3 子段) + recoverer recover-and-send + jsonl-discovery 分拆
  - **拆分布局**(每子模块 ≤ 500 LOC 满足护栏,facade ≤ 500 LOC):
    - facade `index.ts` 499 LOC (874 → 499, -375 LOC; class shell + ensureCodex/sendMessage/interrupt/restartWithCodexSandbox/closeSession 不拆 + createSession 改 thin delegate)
    - facade `recoverer.ts` 159 LOC (597 → 159, -438 LOC; SessionRecoverer class shell + thin recoverAndSend delegate + protected findFallbackCwd + 长 jsdoc + re-export 5 type/3 helper)
    - `create-session/_deps.ts` 200 LOC (新; CreateSessionOpts SSOT + CreateSessionDeps + ValidateResult + PreparedContext + CreateSessionResult)
    - `create-session/create-session-impl.ts` 188 LOC (新; orchestrator try/catch + prepare phase inline + dispatch resume/new)
    - `create-session/create-session-validate.ts` 54 LOC (新; prompt cap + sid/token allocate)
    - `create-session/create-session-resume.ts` 132 LOC (新; resume path body)
    - `create-session/create-session-new.ts` 76 LOC (新; new path body)
    - `recoverer/_deps.ts` 119 LOC (新; RecovererCtx + 4 thunk type + PLACEHOLDER_DEDUP_MS const + FindFallbackCwdThunk)
    - `recoverer/recover-and-send-impl.ts` 334 LOC (新; recoverAndSend free fn impl)
    - `recoverer/jsonl-discovery.ts` 126 LOC (新; 3 export helper)
  - **总 LOC**:1471 → 1887 (含 facade + 7 子模块) +416 LOC trade-off (与 Step 4.1 +282 / Step 4.2 +460 同款增量原因:每子模块独立 jsdoc 重复 §设计要点 + sub-module deps interface signature 重复)
  - **CreateSessionOpts SSOT 抽出**:facade.createSession 改用 `opts: CreateSessionOpts` 直接消费本 type,字段 jsdoc(16 字段含 model/extraAllowWrite/resumeMode/approvalPolicy/handOff/skipFirstUserEmit 等长 jsdoc)单源在 `create-session/_deps.ts` (替代修前 inline interface 长 jsdoc 块)
  - **typecheck pass**:`tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json` 都过
  - **测试 import path 不动**:32 codex sdk-bridge 测试全过(sdk-bridge.consume-fork 9 + sdk-bridge.recovery 20 + sdk-bridge.early-err-cleanup 3);recoverer-jsonl-exists.test.ts 1 suite fail 是 baseline 同款 Electron binary 环境问题(git stash baseline 重跑同款失败实证,与本拆分无关 — 与 Step 4.2 archive-plan.handler.test.ts 同款 P26 教训)
- ✅ Follow-up task 沉淀 (id `6aec8cf7-5b84-4e70-a1ac-bf91d29803ed`): reviewer teammate sandbox PATH 不含 pnpm。User 反馈:reviewer-claude / reviewer-codex teammate spawn 起后 sandbox 内跑 `pnpm typecheck` 撞 `command not found`,但 lead 端 / 终端 pnpm 已安装。可能成因:spawn options-builder spread 给 SDK 子进程的 PATH 不含 pnpm 安装目录(典型 ~/Library/pnpm)/ macOS path_helper 不被 sandbox 继承 / claude-code SDK sandbox 模式可能 strip PATH。修法:本 plan 收口后,或下个 deep-review SKILL invoke 前先修 PATH 问题。
- ✅ Step 4.4 mini-spike + 实拆完成（2026-05-29 / hand off 10;commit `a21f258`):
  - **mini-spike 实测**:F7 ✓ `index.ts:46 from './recoverer'` 单向 import;`recoverer.ts` 0 反向 import;已有 17 partial-split helper(can-use-tool / constants / jsonl-fallback / mcp-server-init / model-resolve / pending-cancellation / permission-responder / query-options-builder / recoverer-helpers / recoverer-messages / restart-controller / sandbox-resolve / sdk-message-translate / send-validation / session-finalize / stream-processor / types);`index.ts` hot spot:createSession 巨型 method L189-544 (~356 LOC, validate + prepare + try-sdk-query + catch cleanup + finalize 五段);`recoverer.ts` hot spot:recoverAndSend 巨型 method L243-544 (~301 LOC) + emitFallbackMessage class private L570-583 + findFallbackCwd protected L625-627 + 2 export helper L645/664
  - **User confirm**: Q1 整体一 step + 4+3 子模块 / Q2 inline validate (claude createSession try 块内无 resume/new 分支,validate ~30 LOC inline ROI 更好) / Q3 emitFallbackMessage 留 facade class 内 (与 findFallbackCwd protected method 同款 test seam)
  - **decision 矛盾解决** (与 Step 4.1 同款 pattern):source file jsdoc L70-104 标记「§保护清单不动文件」7 理由 vs plan §D1「13 文件全拆」对立;沿用 Step 4.1 user 「强行按 mini-spike 拆」方案 — 子模块间通过函数 return value 传递派生 state (避免单一巨型 ctx object 闭包污染,保函数式 readability)
  - **拆分布局** (每子模块 ≤ 500 LOC 满足护栏,facade ≤ 500 LOC):
    - facade `index.ts` 467 LOC (840 → 467, -373 LOC, -44%; class shell + ctor 全留 + createSession 改 thin delegate ~10 LOC + sendMessage / 4 protected wrapper / 6 responder thin wrapper / interrupt / closeSession / setPermissionMode / 2 restartWith\* / consume wrapper 不拆)
    - facade `recoverer.ts` 211 LOC (670 → 211, -459 LOC, -69%; SessionRecoverer class shell + thin recoverAndSend delegate ~12 LOC + emitFallbackMessage class 内 private + findFallbackCwd protected method + 长 jsdoc + re-export 6 type/2 helper)
    - `create-session/_deps.ts` 167 LOC (新; CreateSessionOpts SSOT + CreateSessionDeps + PreparedSessionContext + SdkQueryResult + Query/SdkSessionHandle re-export)
    - `create-session/create-session-impl.ts` 205 LOC (新; orchestrator: validate inline + prepare phase + dispatch sdk-query + finalize 链含 fresh-cli-reuse-app skip 分支 + return handle)
    - `create-session/create-session-sdk-query.ts` 218 LOC (新; SDK query 段: loadSdk + resolveClaudeBinary + buildSandboxOptions + buildMcpServersForSession + effectiveResumeCliSid 三分支 + buildClaudeQueryOptions + sessions.set + waitForRealSessionId + claimAsSdk + try/catch 失败 cleanup)
    - `recoverer/_deps.ts` 226 LOC (新; RecovererCtx + 5 thunk type SSOT + ListEventsFnThunk + FindFallbackCwdThunk + EmitFallbackMessageThunk + RecoverAndSendDeps bundle)
    - `recoverer/jsonl-discovery.ts` 63 LOC (新; defaultResumeJsonlExists + defaultCwdExists)
    - `recoverer/recover-and-send-impl.ts` 363 LOC (新; recoverAndSend free fn impl 完整 inflight + length cap + emit user message + cwd precheck + IIFE 单飞 + maybeJsonlFallback / normal resume + outer try/catch)
  - **总 LOC**:1510 → 1920 (+410 trade-off,与 Step 4.1+282 / 4.2+460 / 4.3+416 同款增量原因)
  - **typecheck pass**:`tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json` 都过 (修 1 个未用 import + 1 个 SdkBridgeOptions 错位 import)
  - **测试 import path 不动**:9 个 claude sdk-bridge __tests__ import 零改动;5 个跑得起来的测试 39 case 全过(can-use-tool 8 + sdk-status-permission-mode-sync 3 + jsonl-fallback 20 + setttimeout-fallback-symmetry 3 + createsession-fail-fast 5);4 个 fail 测试(file-change-intent-delay / set-permission-mode-rollback / restart-controller-fork-rename / restart-controller-jsonl-precheck)是 baseline 同款 Electron binary 环境问题(git stash baseline 重跑同款 fail 实证,与本拆分无关 — 与 Step 4.2 / 4.3 同款 P26 教训)
- ✅ Step 4.5 mini-spike + 实拆完成（2026-05-29 / hand off 11;commit `8d3589a`）:
  - **mini-spike 实测**:`task-repo.ts` 721 LOC `TaskRepo` interface 8 method (createTaskRepo factory L318-705 主体)。**plan §下一会话第一步 推荐 spike1 §F5「CRUD/scope/list/cleanup 四域」与代码不匹配**:`scope` 校验在 tool handler 层不在 repo 层(repo 只做纯 CRUD + hand_off 过继);`cleanup` 已融在 del cascade 内(blocks/blocked_by 引用清理是 del 内 helper)
  - **User confirm**:推翻 spike1 §F5 propose,改 6 子模块 = facade + _deps + crud + list + delete + handoff (handoff 才是真实的「hand_off / batch GC」域 — reassignOwner/applyHandOffSkipPolicy/findOwnedDistinctTeamIds 三方法)
  - **拆分布局** (每子模块 ≤ 500 LOC 满足护栏,facade 116 ≤ 200 LOC 满足 mini-spike user confirm):
    - facade `task-repo.ts` 116 LOC (721 → 116, -605 LOC, -84%; re-export 6 type/interface byte-identical + createTaskRepo 装配 4 子模块 + defaultRepo lazy + taskRepo singleton 不变)
    - `task-repo/_deps.ts` 316 LOC (新; Row 内部 SQLite schema + 6 对外 type/interface SSOT + UPDATABLE_KEYS/COL_MAP 常量 + 4 公共 helpers safeJsonArray/rowToRecord/toColumnValue/getById)
    - `task-repo/task-repo-crud.ts` 118 LOC (新; createCrud(db) → { create, get, update };基础 CRUD 不依赖其他子模块)
    - `task-repo/task-repo-list.ts` 113 LOC (新; createList(db) → { list };visibleScope OR 模式 / ownerSessionIds+teamIdFilter 组合 AND 模式互斥 + SQLite IN 999 上限防御 + LIKE wildcard escape)
    - `task-repo/task-repo-delete.ts` 134 LOC (新; createDelete(db) → { delete } + export cleanupBlocksReferences helper;cascade BFS+predicate+chunked DELETE+cleanup 单 tx 原子;cleanupBlocksReferences export 让 handoff 共享)
    - `task-repo/task-repo-handoff.ts` 141 LOC (新; createHandoff(db) → { reassignOwner, applyHandOffSkipPolicy, findOwnedDistinctTeamIds };hand_off_session 三方法 clear-team/preserve-team/skip 三态)
  - **getById free function 抽到 _deps.ts**:跨子模块共享同款 SELECT 实现(crud update 前置 SELECT + delete cascade BFS 拿 child 都用),避免重复 SQL
  - **handoff → delete 单向依赖**:applyHandOffSkipPolicy import cleanupBlocksReferences from ./task-repo-delete,与 Step 4.3/4.4 index → recoverer 单向 pattern 同款
  - **总 LOC**:721 → 938 (+217 LOC trade-off,与 Step 4.1+282 / 4.2+460 / 4.3+416 / 4.4+410 同款增量原因 — 每子模块独立 jsdoc 重复 §设计要点 + interface signature 重复;本步增量最低 since 无复杂 ctx interface 抽象需求)
  - **typecheck pass**:`tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json` 都过
  - **测试 import path 不动**:`task-repo.test.ts` import `{ createTaskRepo, TaskRepo } from '../task-repo'` 零改动;baseline 同款 fail (Electron failed to install correctly) — git stash baseline 重跑同款 fail 实证,与本拆分无关 (与 Step 4.2/4.3/4.4 同款 P26 教训)
- ✅ Step 4.6 mini-spike + 实拆完成（2026-05-29 / hand off 12;commit `7cbfbba`）:
  - **mini-spike 实测**:`manager.ts` 686 LOC `SessionManagerClass` singleton + 21 公开 method。**caller 实测 158 caller**(精确排 test/manager 自身,grep `sessionManager\.` src/main 不含 __tests__ 不含 session/manager) — spike1 §F8 报「35 caller」实际是粗略量级,158 真 caller。method 公开 API 涉及 sdk-claim 5 / lifecycle 8 / 黑名单 1 / meta 2 / rename 2 / query 4 / hub (ensure / ingest) 2。**已有 partial-split helpers**:manager-helpers.ts (3330B) / manager-enrich.ts (2495B) / manager-team-coordinator.ts (11057B) / manager-ingest-pipeline.ts (14595B) — ingest 5 段 + team 联动已抽走,本拆只针对 manager.ts class shell 686 LOC
  - **User confirm Q1=A Q2=A Q3=A** (3 题都「你推荐的是」):
    - **Q1 拆分布局** = A: facade + lifecycle + rename + _deps 4 文件精炼版 (sdk-claim 全留 class 内 / ensure + ingest hub 不拆 / query 4 thin wrapper ROI 低)
    - **Q2 #sdkOwned 真私有保护** = A 升级版 (callback 模式): `transferSdkClaim` callback 让 free function 在合适位置调 class 内 #sdkOwned mutate,保 6 步顺序 byte-identical 与原 pre-split 一致 (vs Q2A inline 模式破坏 ①sessionRepo.rename ②sdkOwned 顺序变成 ②①③④⑤⑥)
    - **Q3 sdk-claim 5 method** = A: 全留 class 内 (claimAsSdk / releaseSdkClaim / hasSdkClaim / expectSdkSession / consumePendingSdkClaim 5 method 共 45 LOC,trivial 内聚 + 含真私有 #sdkOwned 直接 mutate)
  - **拆分布局** (每子模块 ≤ 500 LOC 满足护栏,facade 443 ≤ 500 ✓):
    - facade `manager.ts` 443 LOC (686 → 443, -243 LOC, -35%):
      - imports + module-level singleton hooks (sessionCloseFn / sessionRenameHookFn) + setters (byte-identical export)
      - UpsertOptions interface export (byte-identical)
      - SessionManagerClass shell: #sdkOwned 真私有 + pendingSdkCwds + recentlyDeleted + ingestCtx (Object.freeze facade) + internalState (SessionManagerInternalState ref) + constructor
      - sdk-claim 5 不拆 / ensure / ingest hub 不拆 / query 4 不拆
      - lifecycle / 黑名单 / meta / rename 域 method 改 thin delegate
      - renameSdkSession callback 模式 (Q2=A 精炼版): class 内 `transferSdkClaim` callback 保 #sdkOwned 真私有约束 + 6 步顺序 byte-identical
    - `manager/_deps.ts` 94 LOC (新; SessionCloseFn/SessionRenameHookFn type SSOT + SessionManagerInternalState interface 只暴露 recentlyDeleted Map ref + RECENTLY_DELETED_TTL_MS = 60_000 + isRecentlyDeletedImpl free function)
    - `manager/lifecycle.ts` 334 LOC (新; lifecycle 8 method + 黑名单 markRecentlyDeletedImpl 双写 R5 MED-R5-1 + meta 2 method;Deps capture: facade 调 closeImpl/deleteImpl 时传 module-level sessionCloseFn 当前 value)
    - `manager/rename.ts` 154 LOC (新; renameSdkSessionImpl 6 步顺序 byte-identical + updateCliSessionIdImpl 反向 rename cli_session_id 单列)
  - **总 LOC**:686 → 1025 (含 facade + 3 子模块) +339 LOC trade-off (与 Step 4.1+282 / 4.2+460 / 4.3+416 / 4.4+410 / 4.5+217 同款增量原因)
  - **typecheck pass**:`tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json` 都过
  - **测试 import path 不动**:38 caller import sessionManager from `@main/session/manager` (alias) + 2 caller `./session/manager` relative — facade 保 byte-identical export ✓;`session/__tests__/` 5 测试 (manager-helpers / lifecycle-scheduler / manager-delete / manager-public-api / manager-ingest) 全过 44 case + 1 skipped;hand-off.test.ts / manager-team-coordinator.test.ts 2 suite 是 baseline 同款 fail (Electron failed to install correctly P26 binary 环境问题, git stash baseline 重跑同款 fail 实证,与本拆分无关 — 与 Step 4.2/4.3/4.4/4.5 同款 P26 教训)
- ✅ User 反馈纠正 (2026-05-29 / hand off 12):
  - **Step 6.1 修订**: 通用工程经验沉淀到 `resources/claude-config/CLAUDE.md`(应用打包给所有项目的通用约定层);**不动** `~/.claude/CLAUDE.md` (user 私有 SSOT)
  - **Step 6.2 修订**: agent-deck 项目特定经验沉淀到**项目根目录** `CLAUDE.md` 或 `ref/conventions/<X>-<topic>.md`;**不放** `resources/claude-config/CLAUDE.md` (那是给所有项目的)
- ✅ Step 4.7 mini-spike + 实拆完成（2026-05-29 / hand off 13;commit `223e59d`）:
  - **mini-spike 实测**:`window.ts` 623 LOC `FloatingWindow` class 11 field + 9 public method + 8 private helper + 3 module-level export。caller 实测 5 文件 (notify/visual.ts / cli.ts / ipc/settings.ts / ipc/window-app.ts / index.ts) 全走 `getFloatingWindow()` + `.window` + 8 public method,无内部依赖。**method 域内聚分析**:生命周期 151 LOC (create+close) / pin 模式视觉 70 LOC (setAlwaysOnTop+setWindowTransparent+invalidate loop+kickRepaintAfterPin) / 尺寸切换 200 LOC (3 toggle + 5 geometry) / 视觉 polish 34 LOC (setIgnoreMouse+flash) / module-level ~15 LOC
  - **User confirm**: Q1=「其他:你推荐的是」(等价推荐 5 文件 facade + 4 域 + _deps) / Q2=ctx 全字段 mutable state interface (推荐) / Q3=独立 polish 子文件 (推荐 — 与 spike1 §F9 4 域 propose 对齐)
  - **拆分布局** (每子模块 ≤ 500 LOC 满足护栏,facade 100 ≤ 200 LOC 满足 mini-spike user confirm):
    - facade `window.ts` 100 LOC (623 → 100, -523 LOC, -84%; class shell + 持 `_state: FloatingWindowState` 单一 mutable object + 9 public method thin delegate + emitCompactChanged getter/setter forwarder + module-level export getFloatingWindow/ensureFocusableOnActivate 不拆)
    - `window/_deps.ts` 101 LOC (新; 8 consts + resolveIconPath/resolveIconImage + DisplayWorkArea interface + **FloatingWindowState interface SSOT** 11 mutable 字段含 emitCompactChanged + createInitialState factory)
    - `window/lifecycle.ts` 185 LOC (新; createImpl BrowserWindow 创建+dock icon+'closed' listener+state 复位 [REVIEW_61 R2 LOW codex generation guard + R1 MED-A 'closed' listener + R3 MED-2 state 复位完整保留] + closeImpl 5 步收尾 + emitCompactChanged null)
    - `window/pin-visual.ts` 100 LOC (新; setAlwaysOnTopImpl pin/unpin + vibrancy 应用 + invalidate loop 控制 [CHANGELOG_24/35 100ms 重绘循环根因注释保留] + setWindowTransparentImpl 透明解耦 alwaysOnTop + kickRepaintAfterPin 1px resize 冲 surface cache + startInvalidateLoop/stopInvalidateLoop helpers)
    - `window/sizing.ts` 285 LOC (新; 3 toggle [R2 fix REVIEW_45 MED-1 minimumSize 临时降 / R1 HIGH-1 setSize→setBounds 居中 / R1 MED-2 clamp 后 isNear 再判] + applyTargetSize helper [R2 INFO-2 重复抽] + rememberIfCustom [MED-2 lastNormalSize 短路 + R3 LOW animate race guard] + 3 geometry helper [LOW 极小屏/负坐标/跨屏边界])
    - `window/polish.ts` 45 LOC (新; setIgnoreMouseImpl pass-through + flashImpl 6 帧 opacity 闪烁 [REVIEW_61 LOW-1 重入保护 + R2 LOW codex generation guard 双保险])
  - **ctx 全字段 mutable interface 设计**:11 mutable 字段 (含 emitCompactChanged 注入回调) 全部收敛进单一 `_state: FloatingWindowState` object 通过 ctx 参数传递。free function signature `(state, args)` 直接 read/write 同一引用,避免 11 个 setter callback 散乱。代价:11 字段全 public 暴露给 sub-module — window 无真私有约束 (vs manager #sdkOwned),可接受。emitCompactChanged 经 facade getter/setter forwarder 路由到 `_state.emitCompactChanged`,保 main/index.ts:294 `floating.emitCompactChanged = ...` 注入路径 byte-identical
  - **总 LOC**: 623 → 816 (+193 LOC trade-off,与 Step 4.5+217 同款增量低端 — ctx interface 替代 setter callback / 单一 state object 比抽象签名简单)
  - **typecheck pass**: `tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json` 都过
  - **caller import path 不动** (5 caller 全 byte-identical): notify/visual.ts:3 / cli.ts:23 / ipc/settings.ts:14 / ipc/window-app.ts:7 / index.ts:5
  - **无相关测试文件**: window.ts 无 unit test (纯生产代码 + Electron BrowserWindow 真实环境无单测可写)
- ✅ Step 4.8 mini-spike + 实拆完成（2026-05-29 / hand off 14;commit `4457a2d`）:
  - **mini-spike 实测**:`index.ts` 594 LOC = imports + module-level let × 5 + `makeDebouncedTeamSender` helper 21 LOC + `bootstrap` god-function 392 LOC (L88-479,Phase 0-11 顺序敏感) + `if (gotLock) { ... }` lifecycle 109 LOC (bootstrappedPromise + 3 app.on)。caller 实测 0(entry point);误命中 2 个 sdk-bridge / session-repo 自模块相对路径。无现成 partial-split helpers。5 module-level let 单例 (hookServer / routeRegistry / scheduler / teamScheduler / agentDeckMcpHttpShutdown) 跨 phase mutate(infra 创建 + lifecycle stop)
  - **User confirm Q1=A Q2=A Q3=A Q4=A** (4 题都「你推荐的是」):
    - **Q1 拆分布局** = 5 文件 = facade + _deps + 3 实质子模块 (bootstrap-infra / bootstrap-wiring / lifecycle-hooks),与 Step 4.7 window.ts 同款 5 文件 pattern
    - **Q2 BootstrapState 设计** = 全字段 mutable interface (与 Step 4.7 FloatingWindowState 同款) — 5 字段 public,bootstrap 单例本身无真私有需求
    - **Q3 makeDebouncedTeamSender helper** = 放 _deps.ts (与 BootstrapState / TOOL_DISPLAY_NAME 集中)
    - **Q4 commit 节奏** = 本会话单 commit 完成实拆 + typecheck (与 Step 4.1-4.7 同款)
  - **拆分布局** (每子模块 ≤ 500 LOC 满足护栏,facade 74 ≤ 200 LOC 满足 mini-spike user confirm):
    - facade `index.ts` 74 LOC (594 → 74, -520 LOC, -87%; imports + process error guards + gotLock + bootstrappedPromise wiring + initInfra/initWiring/registerLifecycleHooks 三调用 + bootstrap fatal catch 路径)
    - `index/_deps.ts` 89 LOC (新; BootstrapState interface 5 字段 + createInitialBootstrapState factory + makeDebouncedTeamSender<T> helper R3.E9 IPC bridge 16ms debouncer + CallerArchiveFailedToolName narrowing type + TOOL_DISPLAY_NAME 常量 archive-toctou-fix-20260515 强制完整覆盖)
    - `index/bootstrap-infra.ts` 262 LOC (新; bootstrap god-function Phase 0-8.6 — applyClaudeSettingsEnv / initDb / settingsStore.getAll / HookServer + RouteRegistry / adapter register + initAll + setSessionCloseFn + setSessionRenameHookFn hook 注入 / mcp HTTP transport mount PRE_LISTEN / hookServer.start + EADDRINUSE fail-loud return false / scheduler/teamScheduler/summarizer + sync* / universal-message-watcher / 开机自启 / bootstrapIpc / loadBundledAssets / reapStaleUploads;return boolean ok=true 继续 wiring,false=fatalExit 已 app.exit(1))
    - `index/bootstrap-wiring.ts` 225 LOC (新; bootstrap god-function Phase 9-11 — floating create + safeSend 闭包 + emitCompactChanged 注入 + 9 基础 eventBus.on + caller-archive-failed 复杂 listener inline 双通道独立 try/catch + 3 reasonKind 分流 + 2 debounced team/message sender + ensureFocusableOnActivate + 4 globalShortcut.register + setImmediate handleCliArgv;接 settingsStore.getAll() 自取需要字段)
    - `index/lifecycle-hooks.ts` 118 LOC (新; 3 app.on lifecycle hooks — second-instance 等 bootstrappedPromise + handleCliArgv 转发 / window-all-closed 非 darwin quit / before-quit cleaningUp idempotent guard + globalShortcut.unregisterAll + 同步停 scheduler/teamScheduler/summarizer/stopAllSounds/universalMessageWatcher + adapterRegistry.shutdownAll/agentDeckMcpHttpShutdown/hookServer.stop 走 10s race-with-timeout + closeDb 在 race 外保 SQLite WAL checkpoint REVIEW_35 R2 MED-D claude R2-3)
  - **总 LOC**: 594 → 768 (+174 LOC trade-off,**最低增量**vs Step 4.1+282/4.2+460/4.3+416/4.4+410/4.5+217/4.6+339/4.7+193 — state interface 极简 5 字段聚合,sub-module signature 简洁 `(state)` / `()` / `(state, bootstrappedPromise)`)
  - **bootstrap fail-loud 双路径保留 byte-identical**:EADDRINUSE → bootstrap-infra.ts initInfra return false defensive → facade 早返回(实际 app.exit 已同步触发,return false 仅防 race);其他 bootstrap fatal → bootstrappedPromise.catch → fatal dialog + closeDb + exit(1)
  - **typecheck pass**: `tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json` 都过
  - **测试 import path 不动**:entry point 无 caller import,facade re-export 不必要;`src/main/__tests__/bundled-assets-multi-root.test.ts` 4 case 全过(本拆分无关 main/index 行为)
  - **注释 stale "line 519" 已修**:bootstrap-infra.ts EADDRINUSE 注释从 "before-quit handler line 519 不会跑" 改 "./lifecycle-hooks.ts before-quit handler 不会跑" 避免行号 sticking
- ✅ Step 4.9 mini-spike + 实拆完成（2026-05-29 / hand off 14;commit `e18da65`）:
  - **mini-spike 实测**: `types.ts` 558 LOC 8 export(纯 type/interface declaration,无 runtime code,无 imports inside types,完全静态);63 caller 文件遍布 sdk-bridge/teams/universal-message-watcher/ipc/sessions/options-builder 等
  - **8 export entity 分组**:
    - 基础 type: AdapterContext (9 LOC) + PermissionMode (1 LOC)
    - createSession opts: ClaudeCreateOpts (112 LOC) + CodexCreateOpts (112 LOC) + CreateSessionOptions union (4 LOC) + CreateSessionOptionsRaw (32 LOC)
    - capability flag: AdapterCapabilities (53 LOC)
    - 主接口: AgentAdapter (175 LOC)
  - **User confirm Q1=A Q2=A** (2 题都「你推荐的是」):
    - **Q1 拆分布局** = 5 文件 entity 域严格划分 (facade + adapter-context + create-session-opts + capabilities + agent-adapter)
    - **Q2 commit 节奏** = 本会话单 commit 完成 Step 4.9 + 更 plan + hand off Step 4.10/4.11 接力
  - **拆分布局** (每子模块 ≤ 500 LOC 满足护栏,facade 21 LOC ≤ 200 ✓):
    - facade `types.ts` 21 LOC (558 → 21, -537 LOC, -96%; 纯 re-export 8 export byte-identical)
    - `types/adapter-context.ts` 20 LOC (新; AdapterContext + PermissionMode 基础 type/enum)
    - `types/create-session-opts.ts` 313 LOC (新; ClaudeCreateOpts + CodexCreateOpts + CreateSessionOptions union + CreateSessionOptionsRaw 4 个 createSession opts,大量 plan reference jsdoc)
    - `types/capabilities.ts` 58 LOC (新; AdapterCapabilities 12 字段 capability flag + canRestartWith*/canCollaborate/canAcceptAttachments jsdoc)
    - `types/agent-adapter.ts` 201 LOC (新; AgentAdapter 主接口 22 method 含 createSession/closeSession/sendMessage/respondPermission/restartWith*/installIntegration/receiveTeammateMessage/notifyTeammateEvent/summariseEvents)
  - **依赖图**(无循环): adapter-context (无内部) / create-session-opts → adapter-context (PermissionMode) / capabilities (无内部) / agent-adapter → adapter-context + capabilities + create-session-opts
  - **总 LOC**: 558 → 613 (+55 LOC trade-off,**最低增量** vs Step 4.1+282 / 4.2+460 / 4.3+416 / 4.4+410 / 4.5+217 / 4.6+339 / 4.7+193 / 4.8+174 — 纯 declaration + re-export 无 jsdoc 重复,sub-module 互相 type-only import 极简)
  - **typecheck pass**: `tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json` 都过
  - **caller 32 import path 不动** (grep 实测 32 caller `import type { ... } from '@main/adapters/types'` 跨 11 模块全 byte-identical re-export);`src/main/__tests__/bundled-assets-multi-root.test.ts` 4 case 全过
- ✅ Step 4.10 mini-spike + 实拆完成（2026-05-29 / hand off 15;commit `ee4cf3b`）:
  - **mini-spike 实测**: `settings.ts` 544 LOC = 11 export(纯 type/interface declaration + 1 const) = AppSettings 30+ 字段聚合 interface 380 LOC + CodexMcpServerConfigShared 11 LOC + DEFAULT_SETTINGS const 55 LOC + HookInstallStatus 6 LOC + 7 permission scan types 75 LOC。**caller path 关键发现**: barrel `src/shared/types.ts:24 export * from './types/settings'` 间接 re-export,200 caller 全走 `@shared/types`,**0 直接 `@shared/types/settings` import**(grep verify clean)
  - **User confirm Q1=A Q2=A** (2 题都「你推荐的是」):
    - **Q1 拆分布局** = A: 4 子模块 + facade (5 文件 entity 严格划分,与 Step 4.9 types.ts 同款 pattern;保 AppSettings 单一 flat interface 不破坏 cross-process JSON shape)
    - **Q2 commit 节奏** = A: 本会话单 commit 完成 Step 4.10 + 更 plan + hand off Step 4.11/4.12 接力
  - **拆分布局** (每子模块 ≤ 500 LOC 满足护栏,facade 31 LOC ≤ 200 ✓):
    - facade `settings.ts` 31 LOC (544 → 31, -513 LOC, -94%; 纯 re-export 11 export byte-identical)
    - `settings/app-settings.ts` 424 LOC (新; AppSettings 30+ 字段聚合 interface + CodexMcpServerConfigShared (用作 AppSettings.codexMcpServers 字段) + HookInstallStatus (settings UI hook section 紧贴))
    - `settings/defaults.ts` 64 LOC (新; DEFAULT_SETTINGS const,import AppSettings type-only 保形状一致)
    - `settings/permission-scan.ts` 74 LOC (新; 7 permission scan types: SettingsSource / SettingsPermissionsBlock / SettingsLayer / MergedRule / MergedDirectory / MergedPermissions / PermissionScanResult — Claude Code settings.json 四层 permissions 扫描契约)
  - **依赖图**(无循环): app-settings (无内部) / defaults → app-settings (type-only AppSettings) / permission-scan (无内部)
  - **总 LOC**: 544 → 593 (+49 LOC trade-off,**史上最低增量** vs Step 4.1+282 / 4.2+460 / 4.3+416 / 4.4+410 / 4.5+217 / 4.6+339 / 4.7+193 / 4.8+174 / 4.9+55 — 纯 declaration + DEFAULT_SETTINGS const 抽出无 jsdoc 重复)
  - **typecheck pass**: `tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json` 都过
  - **caller 200 import path 不动** (barrel re-export byte-identical;grep verify 0 直接 `@shared/types/settings` import + 0 子路径飘移);`settings-store.test.ts` 6/6 case 全过
- ✅ Step 4.11 mini-spike + 实拆完成（2026-05-29 / hand off 16）:
  - **mini-spike 实测**: `agent-deck-message-repo.ts` 527 LOC 13 method (按 ADR §4 状态机分 3 域):
    - CRUD 4 method (insert/get/listByTeam/listBySession 基础读写)
    - dispatch 3 method (findEligible/findEligibleExcludingTargets/countPendingForTarget watcher 配对查询)
    - state-machine 6 method (claim/markDelivered/markFailed/retryAfterFail/cancel/resetDeliveringOnStartup 状态机迁移)
  - **caller 实测**: 7 import path (5 alias `@main/store/agent-deck-message-repo` + 2 relative `../agent-deck-message-repo`) + 0 subpath drift;5 caller (spawn/send handlers / universal-message-watcher index+enqueue / ipc/teams.ts) 全用 `agentDeckMessageRepo.*` singleton
  - **User confirm Q1=A Q2=A Q3=A** (3 题都「你推荐的是」):
    - **Q1 拆分布局** = A: 5 文件 factory 3 域 (与 Step 4.5 task-repo 同款 createCrud/createList/createDelete/createHandoff factory pattern 高度一致)
    - **Q2 _deps 设计** = A: 抽 getById free function (与 Step 4.5 task-repo _deps.ts getById 同款,state-machine 4 method UPDATE 后调 getById 反查最新 row 共享 SELECT 实现避免重复 SQL)
    - **Q3 commit 节奏** = A: 单 commit 完成 Step 4.11 + 更 plan + 直接进 Step 4.12 (Phase 4 收口)
  - **拆分布局** (每子模块 ≤ 500 LOC 满足护栏,facade 111 ≤ 200 LOC 满足 mini-spike user confirm):
    - facade `agent-deck-message-repo.ts` 111 LOC (527 → 111, -416 LOC, -79%; back-compat re-export 7 named export from message-delivery-state + type re-export 5 from _deps + createAgentDeckMessageRepo factory 装配 3 子模块 spread + agentDeckMessageRepo singleton 13 method thin delegate 保 byte-identical)
    - `agent-deck-message-repo/_deps.ts` 201 LOC (新; MessageRow + rowToRecord helper + getById free function + 4 Input shapes (InsertMessageInput/ListMessagesByTeamOptions/FindEligibleOptions/FindEligibleExcludingTargetsOptions) + AgentDeckMessageRepo interface SSOT 13 method 长 jsdoc)
    - `agent-deck-message-repo/crud.ts` 121 LOC (新; createCrud(db) → { insert, get, listByTeam, listBySession };insert caller-side validation + UUID + INSERT;get 复用 _deps.getById;listByTeam/listBySession 按维度拉 + 可选 status filter)
    - `agent-deck-message-repo/dispatch.ts` 88 LOC (新; createDispatch(db) → { findEligible, findEligibleExcludingTargets, countPendingForTarget };backoff WHERE 子句从 message-delivery-state.ts BACKOFF_TIERS 派生 (CHANGELOG_109 R37 P2-N Step 3.6 SSOT);findEligibleExcludingTargets REVIEW_56 Batch C R1 codex MED-2 公平兜底)
    - `agent-deck-message-repo/state-machine.ts` 142 LOC (新; createStateMachine(db) → 6 method;claim 原子化抢占 UPDATE ... RETURNING *;markDelivered REVIEW_32 HIGH-1 接纳 pending/delivering;retryAfterFail REVIEW_61 LOW-α codex fix 单 UPDATE 同时写 attempt_count + status_reason 一致;cancel/resetDeliveringOnStartup ADR §4.6)
  - **总 LOC**: 527 → 663 (+136 LOC trade-off,**第二低增量**仅次于 Step 4.10+49 / vs Step 4.1+282 / 4.2+460 / 4.3+416 / 4.4+410 / 4.5+217 / 4.6+339 / 4.7+193 / 4.8+174 / 4.9+55 — factory pattern 与 Step 4.5 task-repo 同款增量低端)
  - **typecheck pass**: `tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json` 都过
  - **caller 7 import path 不动** (5 alias + 2 relative 全 byte-identical re-export);`agent-deck-message-repo.test.ts` baseline 同款 fail (Electron failed to install correctly P26 binary 环境问题, git stash baseline 重跑同款 fail 实证, 与本拆分无关 — 与 Step 4.2/4.3/4.4/4.5/4.6 同款 P26 教训)
- ✅ **Phase 4 全部 Step 4.1-4.11 实拆完成** (11 commit 一齐 sequence, worktree clean)
- ✅ **Step 4.12 整 Phase 4 收口完成**（2026-05-29 / hand off 16；commit `14aee43`）:
  - **3 build 命令全过** (P26 升级版): `pnpm typecheck` 0 error / `pnpm build` exit 0 / `pnpm dist` exit 0 (electron-builder asar 化 + extraResources copy + native binary unpack 真打包步骤已验)
  - **deep-review SKILL kind='code' 2 轮异构对抗**:
    - 双 reviewer spawn (team `phase4-closeout-review`,sid `3f91107d` reviewer-claude + sid `019e725c` reviewer-codex)
    - **R1 共 1 HIGH 1 finding**:
      - **R1 reviewer-codex HIGH-1** `archive-plan-impl.ts:50` facade 漏 re-export `postFfMergeErr` value (只 re-export PostFfMergePhase **type** 漏 baseline 9a03b46:1266 直接 `export function postFfMergeErr` 的 **value**)
        - 验证手段:Ruby regex 对比 baseline 9a03b46 vs 当前 13 facade 的 named exports,exhaustive 普查唯一 missing symbol
        - 现场验证已成立:baseline 实证 value export ✓ + 当前 facade 漏 re-export ✓ + 当前 _impl-shared.ts:293 真有 source ✓
        - 属 **silent re-export miss**:契约漂移但无 caller 当前受影响 (5 模块 13 处 caller 全在 archive-plan/ 子目录直接 from './_impl-shared',facade 漏 typecheck 不报);违反 plan §不变量「facade pattern (原 import path 全保留)」+ SKILL focus D1 「facade re-export byte-identical」
      - **R1 reviewer-claude verdict 0 HIGH/0 MED/0 LOW 全 pass**,**但漏审 value export 维度** — D1 verdict 只看 type export 没核 value/function/const re-export 是否对齐 baseline (R2 自我修正认领此漏审)
    - **R1 fix 一齐 commit `14aee43`**: facade L62 加 `export { postFfMergeErr } from './archive-plan/_impl-shared';` (+6 LOC); typecheck 0 error
    - **R2 双方共识 0 HIGH/0 MED/0 LOW round_done: true**:
      - **R2 reviewer-codex**: 验证 R1 fix 正确 (grep ✓) + 升级 Ruby regex 加 value/type 分类对比 13 facade 全 OK 0 silent miss + 0 循环依赖 (DFS 扫描) + test diff 空 (git diff --name-only baseline..HEAD -- 'src/**/__tests__/**' 全 0)
      - **R2 reviewer-claude**: 自我修正承认 R1 D1 维度漏审 + 升级 mental model「facade refactor sanity 必须穷举 baseline named export 列表 1:1 diff,不能只看形态」+ 13 facade value/function/const export 全量对比 baseline **95:95 全部对齐** (含 12 处 baseline 直接 `export function/class/const` + 3 处 baseline `export {...}` block + alias `isError as _isArchivePlanError`)
    - 2 reviewer 已 shutdown_session 收尾 (lifecycle: closed, jsonl 保留)
  - **Phase 4 总收益统计**:
    - 11 大文件原 LOC 合计 9821 LOC → 11 facade 合计 ~2740 LOC (-72% facade level)
    - 11 facade 全部 ≤ 500 LOC 满足 plan §D1 护栏 (典型 facade 32-499 LOC,平均 ~250 LOC)
    - 子模块 ~50 个 (按域:CRUD/dispatch/state-machine/lifecycle/pin-visual/sizing/polish/factory/_deps/cwd-resolver/team-adopt/task-reassign/handler-main/precheck/ff-merge/archive-fs/cleanup/_shared 等多 entity 域)
    - 总 LOC 9821 → ~12921 (+3100 LOC trade-off 全 phase, sub-module 独立 jsdoc 重复 §设计要点 + ctx interface signature 重复)
    - 测试 import path 0 改动 (8+ test 文件全 byte-identical)
    - caller import path 0 改动 (200+ caller 全走 facade barrel re-export)

**Phase 5 进行中**（2026-05-29 / hand off 17 cold-start 接力）：
- ✅ Step 5.1 完成（2026-05-29 / hand off 17;写 `ref/reviews/REVIEW_63.md` 408 LOC + 同步 `ref/reviews/INDEX.md` 加 REVIEW_63 行;基线 commit `14aee43` Phase 4 收口完成）:
  - **数据来源 4 项**: Phase 4.0 spike1-architecture-dep-graph.md 14.8 KB (9 F-finding + 4 A-finding) + Phase 4 Step 4.1-4.11 11 step 实施观察 + Step 4.12 R1+R2 deep-review SKILL kind='code' 输出 + 本次 Step 5.1 现场实测 (11 facade LOC / ~50 子模块 LOC / circular dep / caller drift / 重复 helper / facade pattern 一致性矩阵)
  - **A 节**: spike1 §A1 列出的 7 HIGH + 1 MED candidate **全部 ✅ 100% Phase 4 已落地** (manager Step 4.6 / hand-off-session Step 4.1 / archive-plan Step 4.2 / 双 sdk-bridge createSession + recoverer Step 4.3/4.4 / main/index bootstrap god-function Step 4.8 共 8 处),逐条对应修复 commit + 当前 facade 子模块 LOC 实测对照
  - **B 节 Phase 5.1 新发现 finding**:
    - **HIGH = 0 条** ✅ (Phase 4 已落地全部 spike1 §A1 HIGH candidate;实测未发现需 Phase 4 范围内修的新 HIGH) → **Step 5.2 重构 = 0 work**
    - **MED = 0 条** ✅
    - **LOW = 3 条** 留 follow-up plan:
      - L1 mcp handlers shotgun-import 重复模式 (spike1 §F3 + §A1 明示「超本 plan scope」,15 handler 普遍 import 同 4 deps)
      - L2 session/manager.ts 30+ caller hub (spike1 §F8 报 35 / Step 4.6 实测 158 / 本次 30 直接 facade caller;hub design 合理,158 caller 改 import 半径远超 §D4 防线)
      - L3 跨 store/_deps `getById` (2 处) + `rowToRecord` (3 处) 重复 helper (类型签名不同,抽 generic factory 收益 < 复杂度)
    - **INFO = 5 条** 总结性观察:
      - I1 双 sdk-bridge claude/codex 对偶不抽基类合理保留 (spike1 §F2 + §A3 + Phase 4 实施确认)
      - I2 双 sdk-bridge index → recoverer 单向依赖 (spike1 §F7 + Phase 4 Step 4.3/4.4 mini-spike 验证)
      - I3 facade pattern 4 种内部一致无 cross-step drift (Pattern A factory / B class / C free fn / D pure type 各自 internal consistency)
      - I4 0 runtime circular dep ✓ (本次实测 verify;sub-module → facade 反向 import 0 命中;sub-module 间互相 import 全单向)
      - I5 caller import path 0 漂移 生产代码 ✓ (200+ caller 全走 facade barrel re-export byte-identical;测试合理直接 import 子模块属 unit test 覆盖)
    - **临界子模块监控 4 个** ≥ 400 LOC (team-adopt-coordinator 474 / impl-precheck 439 / app-settings 424 / handler-main 411),无紧急行动,加 logic 时若 ≥ 480 触发 follow-up split plan
  - **Phase 4 实施经验沉淀 6 项** (inform Phase 6):
    - E1 LOC trade-off (+27.8%) 是纯 readability tax 可接受 (jsdoc 重复 + ctx interface signature 重复 + 0 runtime overhead)
    - E2 facade pattern 4 种 ROI 排序: D pure type +52 > A factory +176 > C free fn +305 > B class +339 平均 (按 LOC 增量,低增量 = 高 ROI;Phase 6 Step 6.4 R1 fix 时改正 B/C 顺序漂移,reviewer-codex MED-1 实测 305 < 339 → C ROI 比 B 高)
    - E3 Step 4.x.0 mini-spike + user 1-min confirm 模式有效 (0 pattern drift / 0 user 抱怨)
    - E4 不预先抽 _shared/ 大坨 (避免 over-engineering,接受 helper 重复 ~30 LOC)
    - E5 测试 import path 0 改动 ✅ (facade byte-identical re-export)
    - E6 caller import path 0 改动 生产代码 ✅ (0 user-facing 行为变化)
  - **总评**: Phase 4 拆分实施 + spike1 candidate finding 100% 落地是项目架构合理性大幅提升的里程碑;教科书级大规模重构成功案例

**Phase 5 全部完成**（2026-05-29 / hand off 18 — Phase 5 收口）：
- ✅ Step 5.1 完成（写 REVIEW_63.md,初版 9 finding / 0 HIGH 0 MED / 3 LOW + 5 INFO + 4 临界子模块监控全留 follow-up plan;后经 Step 5.3 R1 fix 升级为 7 临界文件监控含 facade 自身）
- ✅ Step 5.2 完成（**0 work** 实证;deep-review SKILL R1+R2 双方共识 Step 5.2=0 work 判定成立,无 HIGH 需重构）
- ✅ Step 5.3 完成（2026-05-29 / hand off 18;deep-review SKILL kind='mixed' 2 轮异构对抗 R1+R2 共 5 finding;commit `8925fb5` R1 fix 3 处 + commit `31b29eb` R2 INFO 修补 3 处文档微同步;3 build 全过 typecheck node+web + pnpm build + pnpm dist exit 0,P26 教训覆盖 electron-builder asar 化 + extraResources copy + native binary unpack 真打包步骤;R2 双方共识 0 HIGH/MED 收口）:
  - **R1 baseline**: R-Claude 0 HIGH / 1 MED (M1 REVIEW_63 漏审 facade 自身 LOC,典型 codex sdk-bridge index.ts 499 LOC margin 1) / 1 LOW (L1 §L2 30 vs 26/38 数据偏差,不修) / 6 INFO; R-Codex 0 HIGH / 0 MED / 2 LOW (LC1 handler-main.ts:50 人为 runtime 依赖 + LC2 plan checklist [ ] markers / 5→6 步偏差)
  - **R1 fix commit 8925fb5** (worktree 2 文件 16/18 行): M1 REVIEW_63 §临界子模块监控→§临界文件监控 7 行表含 3 facade 紧 margin (codex 499/1 + claude 467/33 + manager 443/57 + 特别警示) + LC1 handler-main.ts:50 删 sessionManager import + void 占位 5 行 + LC2 plan SSOT 删第二个 ## 步骤 checklist 节标题 + Phase 1-4 [ ]→[x] markers 同步 + 5 步→6 步 (plan SSOT 不入 worktree commit)
  - **R2 fix-verify**: R-Claude 0 HIGH / 0 MED / 0 LOW / 2 INFO (I1 handler-main LOC 411→406 + I2 plan §当前进度 4→7 文字未同步); R-Codex 0 HIGH / 0 MED / 0 LOW / 1 INFO (REVIEW_63.md:5 准则节残留); 双方明示「同意 conclude Phase 5」
  - **R2 INFO 修补 commit 31b29eb** (worktree 1 文件 2/2 行): REVIEW_63.md:5 准则节同步 + REVIEW_63.md:219 handler-main LOC 411→406 + plan §当前进度 line 172 4→7 文字 (plan SSOT 不入 worktree commit)
  - **Phase 5 收口判定**: R2 双方共识 0 HIGH/MED + 3 build 全过 → Phase 5 conclude → 进 Phase 6 经验沉淀
  - **follow-up task 建** (本会话期间 user 反馈): id `26181f20` priority 6 — mcp tool 入参命名统一驼峰 (snake_case → camelCase,breaking change,需独立 plan 2-3 hand off 量级)
  - **2 reviewer shutdown** + .deep-review-cache invocation 子目录 cleanup ✓

**Phase 6 全部完成**（2026-05-29 / hand off 19 — Phase 6 收口 + 整 plan 收口前最后一轮 review）：
- ✅ Step 6.1 完成（通用工程经验沉淀到 `resources/claude-config/CLAUDE.md` +33 LOC,commit `a022a26`;§单文件大小护栏 节补 facade 自身 LOC 必计 1 句 + 新增 §大文件拆分实战经验 节 (facade pattern 定义 / 4 种 ROI 排序表 D→A→C→B / LOC trade-off 接受现实 / 核心 invariant byte-identical / mini-spike + user 1-min confirm 3 题 / 不预先抽 _shared/ 大坨) + 新增 §多轮 Deep-Review 收口经验 节 (双方共识收口判定 / 反驳轮自纠 mental model / fix 后表格 / 描述文字必同步);约束 1-5 grep verify 全 0 命中违规）
- ✅ Step 6.2 完成（评估 = **no-op (0 work)**:候选清单 4 项已有 SSOT — mcp tool 编排经验 已在 §Agent Deck Universal Team Backend / reviewer-codex 失败兜底 已在 §reviewer-codex 失败 → SKILL 合规兜底分支 / hand_off_session baton 已在 §plan hand-off 自动化:hand_off_session / Phase 4 facade pattern 经验 Step 6.1 已加;`ref/conventions/tally.md` 42 候选 0 count ≥ 3 → 0 升级 `ref/conventions/<X>-<topic>.md`;**不动项目根 CLAUDE.md / 不新建 convention 文件**）
- ✅ Step 6.3 完成（新建 `ref/changelogs/CHANGELOG_175.md` commit `a022a26`,X 递增到 175 — plan §下一会话第一步原写 174 但实际已被 Phase 2 收口 commit `9d55c64` 占用;归档 Phase 3+4+5+6 (Phase 2 单独归档已落 CHANGELOG_174);同步 `ref/changelogs/INDEX.md` 加 CHANGELOG_175 行）
- ✅ Step 6.4 完成（2026-05-29 / hand off 19;deep-review SKILL kind='mixed' 3 轮异构对抗 R1+R2+R3 共 9 finding;commit `48632fe` R1 fix 9 处 + commit `6474740` R2 fix 4 处 worktree + plan SSOT 5 处 direct edit;R3 双方共识 0 HIGH/MED 收口判定）:
  - **R1 baseline**: R-Claude 0 HIGH / 0 MED / 0 LOW / 1 INFO + 5 verified clean (INFO Step 4.1 子模块数 4→5 字面 5 项不一致); R-Codex 0 HIGH / 2 MED / 1 LOW (MED-1 ROI 表 B/C 顺序反 305 < 339 应 C 在 B 前 + MED-2 数字漂移 3 处 + LOW-1 Step 4.5/4.7 facade LOC 列缺数)
  - **R1 fix commit 48632fe** (3 文件 +12/-12 LOC pure substitution): CHANGELOG_175.md 4 处 (净改动 95→90 +12131→+12223 -9738→-9734 / 临界监控 4→7 / REVIEW_63 LOC 408→317 / Step 4.1+4.5+4.7 子模块数 + facade LOC + ROI 描述顺序) + CLAUDE.md §大文件拆分实战经验 ROI 表 B/C 顺序 + REVIEW_63 §E2 ROI 表 + line 256 末尾解释「Pattern C 增量最大」→「Pattern B 增量最大」(应用 §多轮 Deep-Review 收口经验「fix 后表格 / 描述文字必同步」纪律 SSOT 跨 3 文件同步)
  - **R2 fix-verify**: R-Claude 0 HIGH / 0 MED / 0 LOW / 1 INFO (Step 4.8 子模块数 3 vs 字面 4 R1 漏 verify); R-Codex 0 HIGH / 1 MED / 1 LOW (MED-1 plan SSOT 仍停 Phase 6 起跑前 archive 会永久保存 stale checklist + stale changelog id + stale ROI / LOW-1 子模块数残留 4 处 CHANGELOG_175.md:61 + CHANGELOG_175.md:65 + REVIEW_63.md:54 + REVIEW_63.md:60)
  - **R2 fix commit `6474740`** (worktree 2 文件 +4/-4 LOC) + plan SSOT 5 处 direct edit: plan SSOT 大改 (Step 5.2/5.3/6.1-6.4 [ ]→[x] + §当前进度 加 Phase 6 完成节 + §下一会话第一步重写 archive-only + ROI 顺序修 line 513) + CHANGELOG_175.md:61 Step 4.8 3→4 + CHANGELOG_175.md:65 Step 4.11 `factory 3 + _deps` 改 `4 (_deps + crud + dispatch + state-machine)` numeric-first 统一 + REVIEW_63.md:54 hand-off-session 4→5 子模块 + REVIEW_63.md:60 main/index 3→4 子模块
  - **Phase 6 收口判定**: R3 双方共识 0 HIGH/MED + 9 R1 fix 全 verified clean + 5 R2 fix 全 land (plan SSOT 4 + worktree 2 文件 4 处) + R3 严格 fix-verify mode 不挖 new dim 双 reviewer R3 cross-file consistency 全过 (4 处 ROI 顺序 D→A→C→B 一致 / 11 子模块数 cross-validate 全对齐) → Phase 6 conclude → 进 Step 6.5 archive_plan
- 🔄 Step 6.5 进行中（R3 双方共识 0 HIGH/MED conclude → ExitWorktree(action:"keep") + archive_plan mcp tool 5 步原子收口）

## 下一会话第一步

**cold start prompt**（hand_off_session 自动构造）：`按 /Users/apple/Repository/personal/agent-deck/.claude/plans/deep-project-review-comprehensive-20260528.md 接力（Phase: Phase 6 - Step 6.5 archive_plan 收口）`

新会话 4 步（**整 plan 收口 archive-only,Phase 6 Step 6.1+6.2+6.3+6.4 已完成 hand off 19**）：

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/deep-project-review-comprehensive-20260528.md`（不要用 Read 工具——跨会话 cache 陷阱）
2. 从 frontmatter 取 `worktree_path`：worktree 已存在 → `EnterWorktree(path: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-project-review-comprehensive-20260528)`
3. `Bash: pwd && git rev-parse HEAD && git status --short && git log --oneline -10` 自检 cwd 在 worktree 内 + HEAD 含 Phase 6 R2 fix commit + worktree clean
4. **Step 6.5 走应用 CLAUDE.md §Step 4 完成节 5 步收口** (`ExitWorktree(action:"keep")` + `mcp__agent-deck__archive_plan` 一次原子完成 ff-merge + plan mv + INDEX 同步 + commit + worktree remove):
   - 调用: `mcp__agent-deck__archive_plan({plan_id:"deep-project-review-comprehensive-20260528", worktree_path:"/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-project-review-comprehensive-20260528", base_branch:"main", changelog_id:"174,175"})`
   - **caller 自动归档** (archive_plan default `archived='ok'`,baton 单向交接语义)
   - **changelog 双引用**: `changelog_id:"174,175"` — Phase 2 单独归档 CHANGELOG_174 + Phase 3+4+5+6 总归档 CHANGELOG_175 (plan §下一会话第一步 R1 时写 "174" 是 stale,R2 fix 后改 "174,175")
   - **整 follow-up task 留独立 plan 自行调度** (含 id `26181f20` mcp tool 入参驼峰统一 / id `6aec8cf7` reviewer sandbox PATH / id `e1493ecd` 运行时日志落盘 — Phase 6 不动)
   - **整 plan 完成** ✅

**Phase 6 Step 6.5 archive_plan 一行原子完成**

> **codex-cli adapter 接力 cross-ref**：如 user 显式 `hand_off_session({adapter:'codex-cli'})` 起 codex 端会话接力本 plan，cold start 走 codex 端等价 SSOT — `resources/codex-config/CODEX_AGENTS.md` §plan cold-start protocol。两端**核心差异**（非对偶）：
> - **cat 工具**：codex 用 `shell: cat` 替 claude `Bash: cat`（codex 无 native Read tool 等价物）
> - **worktree 进入语义**：claude 端 `EnterWorktree(path:)` 是**切 cwd builtin** — worktree 已存在仍**必调**（不调 cwd 不进 worktree）；codex 端 `mcp__agent-deck__enter_worktree` 是**mcp 创建工具 + 设 marker，不切 cwd**（codex shell cwd 不变）— worktree 已存在时**跳过不调**（reject 复用），直接用绝对路径 + `git -C <worktree>` 推进
>
> 本 plan 不复制 codex 协议主体 SSOT 单源在 CODEX_AGENTS.md（应用打包注入 codex SDK system prompt 默认覆盖）。

## 已知踩坑（防再踩 / 沉淀自历史 plan）

- **拆分历史经验**（CHANGELOG_50/51/52）：facade pattern + 子模块按功能领域 + 测试就近，是验证过的最稳路径
- **EnterWorktree v2.1.112 stale base bug**：必走 Bash 显式 `git worktree add -b <branch> <path>` + `EnterWorktree(path:)` 两步形式，不要用 `EnterWorktree(name:)` 一步式（详 `resources/claude-config/CLAUDE.md` §Step 2 callout）
- **跨会话 cache 陷阱**：cold start cat plan 必走 `Bash: cat`，不走 `Read` 工具（详 §Step 3 callout）
- **prompt asset Edit race**（REVIEW_62 R2-MED-1）：Read CLAUDE.md 33497 token oversized 时走 system-reminder fallback 副本，后续 Edit 可能基于 stale；本 plan Phase 2 prompt 资产改动**强制 grep verify Edit 真 land**
- **拆分必跑 typecheck/build/dist**（P26 升级版）：单纯 LOC 拆分如果 import path 漂移 dev 模式 ESM 兜底跑通 + 打包 rollup 才暴露。本 plan Phase 4 / 5 phase 收口前必跑 `pnpm typecheck` + `pnpm build` + `pnpm dist`（dist = electron-vite build && electron-builder，多 asar 化 + extraResources copy + native binary unpack 是 P26 真打包步骤；build 不够）；中间小 step 临时 commit 可省 dist 但 phase 收口前必跑
- **scope creep 防线**（CHANGELOG_50 教训）：单 Phase 内发现新问题先入 plan §设计决策追加 + 与 user 确认；不要边拆边引新 refactor
- **REVIEW_62 prompt asset 5 条硬约束**：本 plan Phase 2 严守；写 prompt 时同步过 user CLAUDE.md §提示词资产维护 5 步自检
- **Phase 4/5 拆分边界返工风险**（D2/D5 设计意图）：Phase 4 facade pattern 保留 import path 但子模块组织可能被 D 维 architecture review 推翻。**修法**：Phase 4.0 read-only architecture spike 作为 Phase 4 入口前置必跑（inform 后续所有 Step 4.x.0 user confirm）；Step 4.x.0 mini-spike confirm 子模块名 / 边界 / 域划法；Phase 5.1 report + HIGH 重构在 Phase 4 完成后串行。如某 Step 拆完后 Phase 5 report 仍发现需重组 → 视改动半径 ≤ 200 LOC 容忍单 step 返工，超出升级独立 follow-up plan

## 会话风格授权

- **「一路推进」** = 不必在每个 Step 都 stop ask；自主完成 commit / mv / git 操作前心里有数即可；user 没主动追加输入时不主动打扰
- **「自主决定 hand off 时机」** = lead 周期自检（host system reminder 明示 context ≥ 60% / 完成 phase 边界 / 自然话题切换 / 用户语义信号）任一触发 → 写好 §当前进度 + §下一会话第一步 → 调 `hand_off_session(plan_id:...)` 一行 baton。**caveat**：agent 端无 self-introspection API，多数 turn 没 token usage 信息；阈值仅作 host-side 信号触发，无信号时回落到可观察信号（phase 边界 / 话题切换 / 用户语义）
- **「授权写入 plan」** = 后续会话默认继承本授权，不重新对齐
