# CHANGELOG_174 — plan deep-project-review-comprehensive-20260528 Phase 2 完整归档 (B 维提示词资产精简)

## 概要

[plan `deep-project-review-comprehensive-20260528`](../../plans/history/deep-project-review-comprehensive-20260528.md) Phase 2 (B 维提示词资产精简) 8 step 全部完成。5 份核心 prompt asset (claude/codex 双端 CLAUDE.md / CODEX_AGENTS.md + 双 reviewer body + deep-review SKILL) 按 user CLAUDE.md §提示词资产维护 5 条硬约束 + plan §设计决策 D6 三方法论 (清失败兜底冗余 / 通俗化术语 / 应用自闭环 placeholder) 精简,经 2 轮 deep-review SKILL kind='mixed' 异构对抗 (R1+R2 共 5 finding) 收口,4 actionable fix + 1 INFO 保留,0 HIGH/MED 双方共识可合。

**净改动**: 5 改动 asset baseline 1483 LOC → current 1486 LOC (+3 LOC 0.2% 增长)。LOC 不是核心目标 — claude/codex 两端 SDK 加载机制独立, codex 端镜像必须 inline 完整保留无法做 fallback 合并 → 整体只能通俗化, **信息密度提升 / 通俗化白话取代术语堆砌**是 §D6 原意。

**不变量守约**: mcp tool description 注入 SDK system prompt 的文案 byte-identical (未触碰 `src/main/agent-deck-mcp/tools/schemas.ts`) / 运行时行为不变 (无 user-facing 行为变化) / claude-codex mirror parity (§task §Why / §send_message field table / §核心纪律 #7 TL;DR 字面对偶, 单方有意 asymmetry 已明确标注)。

## 变更内容

### Phase 2 Step 2.1: spike 实测验证 (verify 应用自闭环 placeholder + 列精简对象)

- **(a) 反向 grep verify** 硬编码 `/Applications/Agent Deck.app/Contents/Resources` in `resources/claude-config` + `resources/codex-config` = **0 命中** (CHANGELOG_168 已全替换为 `{{AGENT_DECK_RESOURCES}}` placeholder)
- **(b) 正向 grep verify** `{{AGENT_DECK_RESOURCES}}` placeholder 命中 ≥ 1 处 (canonical source-side 模板, runtime `substituteResourcesPlaceholder` 替换为 resources root, 不能删)
- **(c) D9 校正**: `resources/codex-config/agent-deck-plugin/skills/` 不存在 tracked SKILL.md 副本 (`.gitignore:18` 显式忽略); 原 D6 / Step 2.6 沿用「codex 端 2 份 SKILL 是 dead mirror」表述属误判 → plan §D9 校正写实际机制 (SSOT 单源在 claude-config + build hooks 生成 .gitignore 忽略的 build mirror + runtime 写 `~/.codex/skills/`)
- **结论**: Phase 2 实际工作量为通俗化 + fallback 镜像合并, 无 placeholder 替换工作

### Phase 2 Step 2.2: `resources/claude-config/CLAUDE.md` 精简 (commit `694746e`)

- **A1-A4 fallback 镜像合并** (清失败兜底冗余 4 处): 删 「不写无伤大雅」的失败兜底重复; 保留「不写破坏 invariant」的边界
- **B1-B3 通俗化术语** 3 处: 术语堆砌的句子拆 一行术语 + 一行白话 + 典型样例
- **净 -3 LOC**, 729 → 726

### Phase 2 Step 2.3: `resources/codex-config/CODEX_AGENTS.md` 精简 (commit `2d00e09`)

- **B1-B4 通俗化术语** 4 处, 与 Step 2.2 claude 端镜像对偶处理
- **净 +4 LOC 反向**, 253 → 257 — codex SDK 加载机制独立无法做 fallback 镜像合并 (claude 端 §决策对抗等节通过 cross-ref 引用 user CLAUDE.md / SOPs, codex 端必须 inline 完整保留), 整体只能通俗化为主信息密度提升

### Phase 2 Step 2.4+2.5: `agents/reviewer-{claude,codex}.md` 双文件同步精简 (commit `2b8dade`)

- 双文件 mirror 同步精简, §核心纪律 第 7 条 Fresh session 加白话 TL;DR 前置 (「下次 spawn 我时 in-memory state 全空, 需重新加载 reviewer body 才能继续工作」简明覆盖判定 + 补救动作)
- **LOC 不变** 144/140 (claude/codex)

### Phase 2 Step 2.6: `skills/deep-review/SKILL.md` 精简 (commit `8b24680`)

- §Sandbox 处理节 7 步前置 TL;DR (把 7 步技术步骤的精髓压成 1 行: "把外部文件 cp 到 cache 目录让 reviewer 能读, review 完自动清")
- **LOC 217 → 219** (+2)
- flow-arch-plantuml / hello-from-deck 2 份 SKILL 不改 — 按 §D9 校正 codex 端 runtime 自动镜像更新版

### Phase 2 Step 2.7: deep-review SKILL kind='mixed' 评审 2 轮异构对抗 (R1+R2)

#### R1 fix 3 finding (commit `5347c14`)

- **R1 MED-1** (reviewer-claude 单方 + lead 现场验证): plan §当前进度 LOC 数字 +8 实测 +3 (step-level delta 累加 -3+4+0+0+2=+3 与实测一致, 大盘 +8 偏差) → plan SSOT 改为「baseline 1483 LOC → 当前 1486 LOC, +3 LOC」+ 加 2 行 accounting 注脚 (实测命令 + 累加公式)
- **R1 LOW-1** (reviewer-codex 单方 + lead 现场验证): `CLAUDE.md:29` + `CODEX_AGENTS.md:32` task 删除时机通俗化为「session 死了 task 跟着删 (ON DELETE CASCADE)」过宽 → 改为「session row 被 historyRetentionDays GC 或显式 sessionRepo.delete 物理删除时 CASCADE 删 (注意 closed/archived_at 仅打 lifecycle 标记不删 row 不触发 CASCADE)」claude/codex 两端字面对偶
- **R1 LOW-2** (reviewer-codex 单方 + lead 现场验证): `SKILL.md:46` Sandbox TL;DR「worktree 外/内 cache」与 line 42 reviewRoot 定义「可为 repo root / worktree root」不符 → 改为「reviewRoot 外/内 cache (reviewRoot 见上方定义)」与定义对齐

#### R2 fix 1 finding + 1 保留 (plan SSOT 更新, 不入 worktree commit)

- **R2 LOW-1** (reviewer-codex 单方 + lead 现场验证 ls + cat 实测): plan §D9 line 110「每份 SKILL.md 第 6 行注释明示...」过强措辞 — 实测 deep-review/flow-arch 两份有第 6 行注释, **hello-from-deck 例外没有** (6 行 trivial self-check skill); 同时 line 106「无 source-side mirror」措辞不精确 (实际 build hooks 生成 .gitignore 忽略的 build mirror) → 改为「无 tracked source mirror; build hooks 通过 `scripts/sync-codex-skills.mjs` 生成 .gitignore 忽略的 build mirror; deep-review / flow-arch 两份第 6 行有注释, hello-from-deck 例外」精确化
- **R2 INFO-1** (reviewer-claude 单方, reviewer 自荐保留): `SKILL.md:46` forward-ref `(可为 repo root / worktree root)` 4 字短语与 line 42 reviewRoot 定义重复 — trivial trade-off (TL;DR 自洽 vs 严格去重), 按 reviewer-claude 推荐**保留现状**不修

#### R2 收口判定

- 双方 0 HIGH / 0 MED + 双方 explicit「可合」共识 → 严格满足 SKILL §收口判定
- reviewer pair shutdown (`mcp__agent-deck__shutdown_session` × 2 lifecycle=closed events/messages 保留) + SKILL `.deep-review-cache/<invocationId>/` 子目录 cleanup

### Phase 2 Step 2.8: ref/conventions/tally.md 沉淀经验 2 条候选

- **P35** (count: 1): claude / codex 双端 prompt asset mirror 对偶漂移肉眼难发现的两类典型 — (1) 改一端忘了改另一端 / (2) 通俗化措辞与同文件后文已有精确描述前后矛盾。预防: (a) grep 字面对偶核查; (b) 修通俗化前 grep 同文件后文; (c) 单方有意 asymmetry 必须标注「non-mirror by intent」
- **P36** (count: 1): plan 文件 §设计决策 / §当前进度 / §下一会话第一步 节内行级 reference 必须 grep / wc / ls 实测铁证 — 典型出错形态: (1) 全称量词过强 / (2) LOC / count 数字偏差 / (3) 内部一致性矛盾。预防: 写前必跑 grep+wc+ls 实测 + 数字与 delta 累加交叉验证 + 全称量词必须 ls+cat 全列举确认无例外
- 触发样例都是本 Phase 2 Step 2.7 双 reviewer 实测发现, 价值 = 让未来同类工作不踩同款坑
- 不动 `resources/claude-config/CLAUDE.md` (plan Step 2.8 原写法偏差 — §提示词资产维护节在 user CLAUDE.md 私有, user confirm 走路径 (a) 仅入 tally.md 候选)

## 备注

### plan §设计决策 D6 三方法论 落地结论

- **(1) 清失败兜底冗余**: A1-A4 (4 处) Step 2.2 落地, 删冗余 fallback
- **(2) 通俗化术语**: B1-B4 (8 处) + 4 处 TL;DR 前置 (Step 2.4+2.5 reviewer body / Step 2.6 SKILL Sandbox / Step 2.2 CLAUDE.md / Step 2.3 CODEX_AGENTS.md) 落地
- **(3) 应用自闭环 placeholder**: phase 2 实际工作量为 0 (CHANGELOG_168 已全替换), 仅 spike verify 0 残留

### plan §设计决策 D9 校正成果

- 原 D6 / Step 2.6 沿用「codex 端 2 份 SKILL 是 dead mirror」表述误判被纠正
- 实际机制: SSOT 单源在 claude-config (3 份 SKILL), build hooks (`predev` / `prebuild` / `predist` 跑 `scripts/sync-codex-skills.mjs`) 生成 `resources/codex-config/agent-deck-plugin/skills/` 镜像 (.gitignore 忽略), runtime `syncSkills()` 写 `~/.codex/skills/agent-deck/<X>/`
- R2 LOW-1 进一步精确化 D9 措辞 (deep-review / flow-arch 第 6 行有 codex mirror 注释 / hello-from-deck 例外没有 6 行 trivial skill 极简定位)

### Phase 2 Step 2.7 异构对抗价值印证

- R1 即抓 3 finding (claude 1 MED 抓 LOC 数字偏差 / codex 2 LOW 抓 task 删除时机过宽 + SKILL Sandbox TL;DR 与定义不符)
- R2 双方 R1 fix 3 ✅ 复议 + 仍能挖出 R2 LOW-1 (plan §D9 过强措辞 hello-from-deck 例外) — 多轮挖深价值再次印证
- reviewer-codex 「grep + 代码 reference + .gitignore + package.json hooks 实测」是独门武器 (典型: D9 line 110 措辞过强 + `.gitignore:18` build mirror 实测)
- claude/codex 异构 native pair (Opus 4.7 vs gpt-5.5) 物理保证视角差异 — 同源化双 Claude 会同时漏掉同款 finding

### 关联

- 父 plan: [`ref/plans/deep-project-review-comprehensive-20260528.md`](../../plans/history/deep-project-review-comprehensive-20260528.md) (status: in_progress; Phase 2 收口, 进 Phase 3 C 维架构图通俗化)
- 引用历史: REVIEW_62 (Step 2.7 prompt asset 5 条硬约束 baseline) + CHANGELOG_173 (R2-MED-1 「Edit 工具 race 必须 grep verify 真 land」教训本 Phase 全程严守) + CHANGELOG_168 (`{{AGENT_DECK_RESOURCES}}` placeholder 机制)
- ref/conventions/tally.md 新增: P35 + P36 (count: 1, 未达 ≥ 3 升级阈值, 静默累积观察后续 trigger)

### Phase 3 衔接

- 下一 phase: Phase 3 C 维架构图通俗化 (8 张 architecture + 9 张 flows .puml 重写, INDEX 概要列重写 ≤ 80 字白话)
- hand_off 触发点: Phase 2 收口 = phase 边界, 首选 hand off 时机
- 新会话 cold-start prompt: `按 /Users/apple/Repository/personal/agent-deck/.claude/plans/deep-project-review-comprehensive-20260528.md 接力（Phase: Phase 3 - Step 3.1 起跑）`
