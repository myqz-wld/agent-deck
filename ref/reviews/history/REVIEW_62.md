# REVIEW_62 — 提示词资产 review (9 份 prompt asset 全检) R1+R2+R3 收口

> 触发：用户请求提示词资产 review（9 份长生命周期 prompt asset 注入到 SDK system prompt 末尾的 baseline,影响所有未来 SDK session 的行为基线）。
>
> 工具链：agent-deck:deep-review SKILL kind='mixed' (双 mode 并行 code 实施 + plan 设计) 多轮异构对抗 reviewer-claude (claude-code adapter Opus 4.7) + reviewer-codex (codex-cli adapter gpt-5.5 xhigh) 跨 adapter native pair + 三态裁决 + 反驳轮 + 现场验证。
>
> 准则：user CLAUDE.md §提示词资产维护 5 条硬约束 + 5 步自检。
>
> 关联 fix：[CHANGELOG_173.md](../../changelogs/history/CHANGELOG_173.md)。

## Scope

| 文件 | LOC | 角色 |
|---|---|---|
| `resources/claude-config/CLAUDE.md` | 726 | claude 端应用打包注入 SDK system prompt 末尾的 baseline (优先级声明 / 应用环境特有能力 / 决策对抗 / 核心流程架构变更必走 plantUML / 复杂 plan workflow / 新项目工程地基 / Agent Deck Universal Team Backend) |
| `resources/codex-config/CODEX_AGENTS.md` | 251 | codex 端等价物 (注入 `~/.codex/AGENTS.md` marker 段) |
| `resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md` | 143 | reviewer-claude teammate body (claude-code adapter native, Opus 4.7) |
| `resources/codex-config/agent-deck-plugin/agents/reviewer-codex.md` | 140 | reviewer-codex teammate body (codex-cli adapter native, gpt-5.5) |
| `resources/claude-config/agent-deck-plugin/skills/hello-from-deck/SKILL.md` | 26 | trivial 自检 SKILL |
| `resources/claude-config/agent-deck-plugin/skills/flow-arch-plantuml/SKILL.md` | 155 | 核心流程 / 架构变更画 plantUML SKILL (仅 claude 端) |
| `resources/claude-config/agent-deck-plugin/skills/deep-review/SKILL.md` | 209 | 深度 code/plan/mixed review SKILL (claude SSOT) |
| `resources/codex-config/agent-deck-plugin/skills/hello-from-deck/SKILL.md` | 26 | claude 端镜像 (sync-codex-skills.mjs 同步) |
| `resources/codex-config/agent-deck-plugin/skills/deep-review/SKILL.md` | 209 | claude 端镜像 (sync-codex-skills.mjs 同步) |

合计 **1923 LOC**。本批 prompt asset review 是 batch A/B/C (REVIEW_59/60/61) 之后第一次专门对 prompt 资产 self-review (历次 review 都是对 src code,prompt asset 是注入到 SDK 自身的"规约代码"维度需要独立评审)。

## 流程

- **Step 0** dual self-check: `.gitignore` 含 `.deep-review-cache/` + orphan sweep 通过
- **Step 1** 并发 spawn reviewer pair `dcr-prompt-assets-review-20260528` (team_id `8a435f64-62cc-498d-98d7-d407c4e82c96`, reviewer-claude `dace5ba1` claude-code adapter Opus 4.7 + reviewer-codex `019e6e9e` codex-cli adapter gpt-5.5 xhigh, 物理保证异构)
- **R1** kind='mixed' (双 mode 并行) 全量审 9 文件 / 5 条硬约束 grep + 镜像 SSOT 漂移 + 双 mode focus → 双方 reply 自动注入 lead conversation
- **反驳轮** R1 reviewer-codex 单方 2 HIGH 都走反驳轮 → reviewer-claude 都 ❌ 反驳成功降级 MED + 提 MED 改进
- **R1 fix loop** 13 处实施 → commit b41cdce → sync codex SKILL 镜像本地 → R2
- **R2** 复用同一对 reviewer mental model 全量重审 + R1 fix verify (skip 字段告知 R1 ✅ fix 摘要)
- **R2 fix loop** 4 处实施 → commit efd0702 → R3
- **R3** reviewer-codex quick verify R2 fix 真 land (reviewer-claude R2 已 explicit 「建议直接 conclude」无需 R3 review)
- **收口** 双方共识可合 → shutdown × 2 + 写本份 REVIEW + CHANGELOG → task completed

## 三态裁决总览

### R1 finding

| Finding | reviewer | 原 severity | 验证结果 | 裁决 |
|---|---|---|---|---|
| C-HIGH-1 deep-review SKILL §65 .gitignore 缺 entry 只 warn 不 abort | codex | HIGH | 反驳轮 reviewer-claude 3 条实证推翻(措辞已 informed consent + §66 cleanup + §70 .gitignore 兜底 + 本项目实测 .gitignore:14 命中) | ❌ 反驳成功降级 MED + 采纳 UX 改进 (explicit confirm step) |
| C-HIGH-2 deep-review SKILL §99 mixed reviewer fail 不阻塞继续破坏异构 | codex | HIGH | 反驳轮 reviewer-claude 4 条实证推翻(§99 末尾「降级单方非 HIGH」对接 §三态裁决 异构保障核心保留 + §195/196 是多选项矩阵不是矛盾) | ❌ 反驳成功降级 MED + 采纳 fallback 优先级链 callout |
| C-MED-1 CLAUDE.md:161 plantUML deprecated 状态违反「禁 deprecated」硬约束 | codex | MED | lead 自验证 ✅ 字面违反 user constraint 2 关键词 list | ✅ 改 archived (但 R1 fix Edit 工具 race 导致未真 land → R2-MED-1 重提) |
| C-MED-2 CLAUDE.md:11 baseline priority 两端漂移 | codex | MED | lead 自验证 ❓ adapter 差异 (claude SDK settingSources auto-load user / codex SDK ~/.codex marker 注入无对等) — 不是 SSOT drift | ✅ 部分采纳 — 加 inline 注释说明 adapter 差异 |
| C-MED-3 reviewer-claude.md §41-42 Fresh session 「CLI 隐式 fork」双义 | codex | MED | lead 自验证 ✅ line 41 触发因子 + line 42 SDK resume 范畴矛盾 | ✅ 删 line 41「CLI 隐式 fork /」+ 加独立子项说明软 fork 不算 fresh |
| C-MED-4 CODEX_AGENTS.md baseline 注入历史修法痕迹 | codex | MED | lead 自验证 ✅ 132/137/143/162/205/206/226 + claude CLAUDE.md:664 含 P5 Round / followup / 原名 batonMode 等违反 constraint 2 | ✅ 删全部历史修法痕迹 |
| C-LOW-1 = L-MED-3 CODEX_AGENTS.md:122 NO MSG ANCHOR「建议」→「请」 | codex+claude | LOW (codex) / MED (claude with mirror evidence) | **双方独立提出** = ✅ 真问题 (强冗余即算验证) | ✅ 改齐 claude 端 SSOT |
| L-MED-1 reviewer-codex.md frontmatter 含弱断言「自行确认」 | claude | MED | lead 自验证 ✅ 违反 constraint 3 | ✅ 改可执行 fallback 引用 |
| L-MED-2 CODEX_AGENTS.md:212 「(default,推荐)」+「保最大兼容性」双违反 | claude | MED | lead 自验证 ✅ 「推荐」违反 constraint 3 + 「兼容性」违反 constraint 2 关键词 | ✅ 改齐 claude 端 SSOT |
| L-MED-4 CODEX_AGENTS.md:110 shared-team trade-off 漂移 + 「推荐」 | claude | MED | lead 自验证 ✅ codex 端措辞结构与母本不同 + 末尾「推荐」违反 constraint 3 | ✅ 改齐 claude 端 SSOT (双向条件→动作) |
| L-LOW-1 CODEX_AGENTS.md:216 trivial「但」字漂移 | claude | LOW | lead 自验证 ✅ trivial mirror drift | ✅ 删「但」字 |
| L-INFO-1 弱断言列表 3 处 inline 设计意图 | claude | INFO | 设计意图非冗余 (reviewer body 独立注入 SDK 不依赖 baseline 加载顺序) | ✅ 加 inline 注释说明 |
| L-INFO-2 sync lint advisory (CLAUDE.md/CODEX_AGENTS.md 手工双维护) | claude | INFO | positive observation + advisory | 留作 future advisory (本次手工 fix 已收口,future 评估加 sync lint script) |
| L-INFO-3 flow-arch-plantuml codex 端无对偶 | claude | INFO | lead 验证 ✅ claude 端 3 SKILL / codex 端 2 SKILL (缺 flow-arch-plantuml) | ✅ CLAUDE.md §核心流程架构变更必走 plantUML 节加 codex 端走法说明 (R2 reviewer-codex 抓出 R1 fix 引入 -tpng 渲染矛盾 → R2 重写) |

### R2 finding (R1 fix 后第二轮挖深)

| Finding | reviewer | 原 severity | 验证结果 | 裁决 |
|---|---|---|---|---|
| R2-MED-1 CLAUDE.md:164/170 + flow-arch-plantuml SKILL:36/46 deprecated 残留 | codex | MED | lead 自验证 ✅ R1 fix Edit 工具返回 "updated successfully" 但 fs 未真 land (推断:首次 Read CLAUDE.md 33497 token oversized 走 system-reminder fallback 副本导致 Edit 基于 stale) + flow-arch SKILL R1 完全漏改 | ✅ R2 强制 grep verify 真 land + 补 flow-arch SKILL deprecated → archived |
| R2-MED-2 deep-review SKILL §Scope schema 缺 `ack_cache_unignored` 字段 | codex | MED | lead 自验证 ✅ R1 引入 explicit confirm flag 但 schema 仍只列 `kind`/`paths`,caller 不知怎么传 — 不可执行 | ✅ 扩 schema 加 `ack_cache_unignored?: boolean` 字段定义 |
| R2-MED-3 CLAUDE.md:151 codex 端 plantUML 走法 -tpng 渲染 vs flow-arch SKILL §不渲染 SSOT 协议矛盾 | codex | MED | lead 自验证 ✅ R1 fix 引入新协议矛盾 — flow-arch SKILL frontmatter + §68 都说「不渲染」 | ✅ 重写 codex 端走法:移除 -tpng + 加「严禁 -tpng/-tsvg 渲染」+ 改按 SSOT 手工编辑 .puml + 可选 -syntax 检查 |
| R2-LOW-1 CLAUDE.md:127「环境若提供...可能在该环境内 SKILL 定义」弱断言 | codex | LOW | lead 自验证 ✅ 本文件就是 Agent Deck 应用环境 baseline,「可能」不必要 | ✅ 改事实句「Agent Deck 应用环境的合规兜底分支详 §...节」 |
| reviewer-claude R2 0 新 HIGH/MED + 4 INFO (advisory) | claude | INFO | lead 自验证 4 条都 advisory 不阻断 | 直接 conclude 不进 R3 |

### R3 finding (R2 fix 验证)

| Finding | reviewer | 验证结果 | 裁决 |
|---|---|---|---|
| R3 verify | codex | quick verify 通过 (deprecated 0 命中 / ack_cache_unignored 同时在 schema+sandbox / mirror cmp=0 / codex 端 plantUML 对齐不渲染 SSOT / R2-LOW-1 cross-ref 有效) | ✅ **可合** |

## 必修 finding 详细

### ✅ C-MED-1 + R2-MED-1: deprecated → archived (CLAUDE.md + flow-arch SKILL)

R1 reviewer-codex 抓 CLAUDE.md plantUML INDEX 状态枚举用 `deprecated` 字面违反 user constraint 2 关键词 list 含 `deprecated`。R1 fix 改成 `archived` 但 Edit 工具返回 success 实际未真 land (R2 reviewer-codex 重抓)。R2 强制 grep verify 真 land + 补 flow-arch SKILL 内 R1 完全漏改的 line 36/46 同款引用。

**修法**:
- `CLAUDE.md:164` 状态枚举 `deprecated` → `archived` + `' DEPRECATED:'` → `' ARCHIVED:'`
- `CLAUDE.md:170` AskUserQuestion 文本「新建 vs 修改 vs deprecated 已有」→「archived 已有」
- `flow-arch-plantuml/SKILL.md:36` Step 0 AskUserQuestion 「标记 deprecated」→「标记 archived」
- `flow-arch-plantuml/SKILL.md:46` Step 4 INDEX 同步「标 deprecated」→「标 archived」

### ✅ C-MED-2: baseline priority adapter 差异说明 (CLAUDE.md + CODEX_AGENTS.md)

R1 reviewer-codex 抓 claude 端 baseline priority 写「user CLAUDE.md 优先于本文件」,codex 端写「developer/per-turn user 优先 + user marker 外段同级 baseline」是 SSOT drift。lead 自验证 ❓ 这是 adapter 差异 (claude SDK `settingSources: ['user',...]` 自动加载 user CLAUDE.md 作 baseline / codex SDK `~/.codex/AGENTS.md` marker 注入无对等机制)。**修法**:两端 §优先级声明节加 inline 注释「adapter 差异不是 SSOT drift,维护时不要强行对齐两端」让维护者识别。

### ✅ C-MED-3: reviewer-claude.md Fresh session 边界条件清晰化

R1 reviewer-codex 抓 reviewer-claude.md §41 把「CLI 隐式 fork」放在 fresh session 触发因子 + §42 又说「软 fork」属 SDK resume 不触发 — 同词双义会让 reviewer 自己困惑。**修法**:line 41 删「CLI 隐式 fork /」字样 (只留 jsonl 缺失 fallback) + 加独立子项「CLI 隐式 fork 软 fork 也不算 fresh:sessionId 改了 + jsonl 在 + DB rename 子表迁完 → 属 SDK resume 范畴」与 dormant 子项并列。

### ✅ C-MED-4: 删 baseline 历史修法痕迹 (CODEX_AGENTS.md + CLAUDE.md)

R1 reviewer-codex 抓 CODEX_AGENTS.md 多处保留 `P5 Round 1 reviewer-codex M1 修法` / `REVIEW_46/47` / `原名 batonMode` / `followup 20260515` 等历史修法引用,作为注入所有未来 SDK session 的 baseline 占上下文 + 把旧名称带回推理链,违反 constraint 2「禁 deprecated / 老版本」原则。

**修法**:
- `CODEX_AGENTS.md:132/137/143/162/205/206/226` 全删 P5 Round / REVIEW_xx / 原名 batonMode / followup 20260515 等历史引用,只保留当前事实 contract
- `CLAUDE.md:664` 同款「followup UX 完善」→「UX 完善」

历史修法引用应在 `ref/plans/` `ref/reviews/` `ref/changelogs/` 归档保留,不应进 baseline。

### ✅ C-LOW-1 + L-MED-3 (双方独立提出): NO MSG ANCHOR「建议 lead」→「请 lead」

reviewer-codex + reviewer-claude 都独立抓 CODEX_AGENTS.md:122 (NO MSG ANCHOR reply 顶部硬性 warn 文案) 用「建议」削弱可执行性 (claude 端母本 line 630 用「请」)。**双方独立 = ✅ 真问题** (强冗余即算验证)。

**修法**: CODEX_AGENTS.md:122 「建议 lead 通过 send_message」→「请 lead 通过 send_message」改齐 claude 端 SSOT。

### ✅ L-MED-1: reviewer-codex frontmatter 弱断言改可执行

R1 reviewer-claude 抓 reviewer-codex.md frontmatter description 含「user 端 codex CLI 实际可用 model id 自行确认」(注入到 SDK system prompt 的 plugin agent registry, lead 调 spawn_session 决策时直接读) — 「自行确认」是弱断言违反 constraint 3。

**修法**: 改成可执行 fallback 引用「frontmatter `model: gpt-5.5` 透传到 codex SDK ThreadOptions;codex CLI 不支持该 model id 时 fallback 到 user `~/.codex/config.toml` 顶层 model 配置」让 lead 知道 fallback 路径。

### ✅ L-MED-2: CODEX_AGENTS.md `'clear-team'` 双违反 (镜像漂移)

R1 reviewer-claude 抓 CODEX_AGENTS.md:212 `'clear-team'` default 选项含「(default,推荐)」+「保最大兼容性」,claude 端母本 line 714 写「(default)」+「适用面最广」。「推荐」违反 constraint 3,「兼容性」违反 constraint 2 关键词。

**修法**: codex 端改齐 claude 端母本删「,推荐」+ 「保最大兼容性」→「适用面最广」。

### ✅ L-MED-4: CODEX_AGENTS.md shared-team trade-off 漂移

R1 reviewer-claude 抓 CODEX_AGENTS.md:110 shared-team trade-off 写「选项 1 简单粗暴丢 mental model;选项 2/3 保留 mental model 推荐」(末尾「推荐」违反 constraint 3 + 表述结构与 claude 母本不同)。claude 母本 line 618 写「需要保留 reviewer 跨轮 mental model → 走选项 2/3;接受重跑 reviewer → 走选项 1」(双向条件→动作隐含取舍)。

**修法**: codex 端改齐 claude 端 SSOT (双向条件→动作)。

### ✅ L-LOW-1: CODEX_AGENTS.md trivial「但」字漂移

claude `task 过继是 nice-to-have,baton 本质是 session 接力;caller 通过 ok return` vs codex 同款多个「但」字。**修法**: codex 端删「但」字。

### ✅ R2-MED-2: deep-review SKILL §Scope schema 加 `ack_cache_unignored`

R1 fix 引入 explicit confirm step 让 caller 必须传 `ack_cache_unignored: true` 跳过 .gitignore 自检 (修反驳轮提的 HIGH-1 → MED 改进),但 SKILL §Scope schema 仍只列 `kind`/`paths` 两个字段 — caller 不知道这个 flag 属于 scope / spawn prompt / env var,不可执行。

**修法**: 扩 schema 加 `ack_cache_unignored?: boolean` 字段定义 + comment 说明 default false + 引用 §Sandbox 处理 step 6。

### ✅ R2-MED-3: codex 端 plantUML 走法移除 -tpng 渲染 (修协议矛盾)

R1 fix 引入 codex 端 plantUML 走法 (L-INFO3 修),但用了 `shell: plantuml -tpng <file>.puml` 渲染 PNG。这与 flow-arch SKILL frontmatter「纯生成/修改 .puml SSOT 不渲染」+ §68「本 SKILL **不调** plantuml CLI 渲染」直接协议矛盾。

**修法**: 重写 codex 端走法:移除 -tpng + 加「**严禁** codex 端调 `plantuml -tpng / -tsvg` 渲染产 PNG/SVG (违反 flow-arch SKILL §不渲染 SSOT — user 想看渲染产物自跑 plantuml CLI)」+ 改按 flow-arch SKILL §不渲染 SSOT 手工编辑 .puml + INDEX.md + 可选跑 `plantuml -syntax` 做语法检查。

### ✅ R2-LOW-1: CLAUDE.md:127「可能」改事实句

R1 reviewer-codex 抓 CLAUDE.md:127「环境若提供多轮 review 编排能力,可能在该环境内 SKILL 定义合规兜底分支...通用决策对抗节不走那条」— 本文件就是 Agent Deck 应用环境 baseline,「环境若提供...可能在该环境内 SKILL 定义」非事实表述。

**修法**: 改成事实句「Agent Deck 应用环境的合规兜底分支详 §应用环境特有能力 §reviewer-codex 失败 → SKILL 内合规兜底分支 节;§决策对抗 主路径(双 Bash 单次决策对抗起外部 CLI)不走 SKILL 编排路径」。

## ❌ 反驳 finding (HIGH 降级为 MED 改进)

### ❌ C-HIGH-1 → MED + UX 改进: SKILL §65 .gitignore 缺 entry 不 abort

reviewer-codex R1 提 HIGH「外部 scope cache 在 .gitignore 缺失时继续执行,中断 + cleanup 失败后 cache 残留 untracked 后续 commit 误收」。

反驳轮 reviewer-claude 3 条实证推翻:
1. **§65 措辞已显式 informed consent**:「请加 entry 或接受风险继续」+ 末尾 callout「本项目 `.gitignore` 已加,自检失败常发于跨项目用 SKILL 时」符合 constraint 4 范围与失败兜底显式
2. **§66 cleanup try/finally + 重试 + §70 应用层 .gitignore 兜底**:破坏链需 multi-failure 三条件同时撞 (.gitignore 缺 + cleanup 重试都失败 + caller 用 git add . / -A 而非显式路径)
3. **本项目 `.gitignore:14` 实测命中**:本项目用 SKILL 此风险 100% 不触发,reviewer-codex 担心仅在「caller 调 SKILL on 别人 repo 且没权改 .gitignore」罕见跨项目场景
4. reviewer-codex 提的 strict abort 修复 trade-off 差: 跨项目场景 caller 没权改外部 repo .gitignore (典型:跨 repo plan review),strict abort 100% 阻断合理 use case

**降级 MED + 采纳 reviewer-claude 提的 UX 改进**: SKILL §65 改为「批处理 / 自动调度场景 (caller 看不到 warn 输出): caller 必须在 invoke SKILL 时显式传 `ack_cache_unignored: true` 跳过自检 + 接受 cache untracked 风险;否则 SKILL warn + abort 让 caller explicit consent」。

R2 reviewer-codex 抓出 schema 没列此 flag → R2-MED-2 扩 schema 字段定义补完整。

### ❌ C-HIGH-2 → MED + 优先级链 callout: SKILL §99 mixed 失败不阻塞继续

reviewer-codex R1 提 HIGH「mixed reviewer fail 不阻塞继续 + 降级单方破坏异构机制」。

反驳轮 reviewer-claude 4 条实证推翻:
1. **§99 末尾「降级单方非 HIGH」直接对接 §三态裁决**:✅ HIGH 必双方独立 + 现场验证;mixed fallback 路径下 single-side reviewer 提出的 finding 必须过 §单方独有分流 (HIGH → 反驳轮 / MED → lead Grep+Read 验证) 才能成 HIGH,**异构保障核心 invariant 保留**
2. **§195/196 是「通知用户决策」多选项矩阵,与 §99 不是矛盾**:「单方 reviewer-claude 出结论」选项与 §99 fast path 等价;两者是 fallback 层次
3. **§200 显式 cross-ref §kind='mixed' 节**:节间引用做到位
4. reviewer-codex 提的「一律 abort 等合规兜底」trade-off 差: 浪费 activeReviewer 已产出工作 + 阻塞 review 推进 5-10min + 强迫用户必走兜底失去灵活性

**降级 MED + 采纳 fallback 优先级链 callout**:
- §99 + §207 加 explicit fallback 优先级链 callout:① 等 SDK / OAuth 恢复 (短超时 retry ≤ 5min) → 失败转 ②;② §195/196 合规兜底起外部 CLI (仍异构,典型 5-10min setup) → 用户拒绝 / setup 失败转 ③;③ 降级单方非 HIGH 走当前 §99 fast path (失去补对方视角,但 §三态裁决 §单方独有分流 保障 single-side HIGH 不被错升级)
- §207 失败兜底表 kind='mixed' row 也加 callout: lead 必按 ①retry → ②合规兜底 → ③降级单方 顺序,不要直接走 ③ 跳过 ① ②

## INFO 建议 (advisory 不阻断)

### L-INFO-1 ✅ 加 inline 注释: 弱断言列表 3 处 inline 设计意图

reviewer-claude 指出弱断言关键词列表「可能 / 也许 / 看起来 / 应该 / 大概」在 CLAUDE.md:118 + reviewer-claude.md:37 + reviewer-codex.md:34 三处 inline 重复,但 reviewer agent body 是 plugin 注入到 SDK system prompt 的独立 context — reviewer 不读 CLAUDE.md baseline (reviewer agent settingSources 受 SDK options 控制),inline 列出避免依赖跨文件加载顺序。**设计意图非冗余**。

**采纳**: CLAUDE.md:118 加 inline 注释「注:reviewer-{claude,codex}.md §核心纪律 inline 重复此列表是设计意图 — reviewer agent body 独立注入 SDK,不依赖本文件 baseline 加载顺序,维护时不要按「冗余必合并」规则去抽 SSOT」。

### L-INFO-2 留作 future advisory: sync lint script for CLAUDE.md/CODEX_AGENTS.md

reviewer-claude positive observation: `deep-review/SKILL.md` + `hello-from-deck/SKILL.md` byte-identical (diff 0 输出) 反衬 CLAUDE.md/CODEX_AGENTS.md 因当前手工双维护累积出 4 处 MED-level drift (R1 抓到的 NO MSG ANCHOR / clear-team / shared-team / 但字)。**建议**: 给 CLAUDE.md ↔ CODEX_AGENTS.md 加 sync lint 脚本,把共享章节抽到一份 source 自动派生;adapter-specific 章节保留独立。

**当前处理**: 本次 R1+R2 手工 fix 已收口 4 处 drift。future 评估加 sync lint script (本次 review 不实施 — scope creep)。

### L-INFO-3 ✅ CLAUDE.md §核心流程架构变更必走 plantUML 节加 codex 端走法说明

reviewer-claude 指出 flow-arch-plantuml SKILL 仅 claude-config 端打包,codex 端无对偶,CLAUDE.md §核心流程架构变更必走 plantUML 节内 grep `codex` 0 命中未声明 codex 端 fallback。

**采纳**: CLAUDE.md 加 codex 端走法说明 (R1 实施但 R2 reviewer-codex 抓出引入 -tpng 渲染矛盾 → R2 重写为按 SSOT 手工编辑 .puml + 严禁 -tpng/-tsvg 渲染)。

### reviewer-claude R2 4 INFO 全 advisory

- **R2-INFO-1** ack_cache_unignored 缺 typed invocation schema — R2-MED-2 已扩 schema 补完整
- **R2-INFO-2** claude vs codex cold-start asymmetric (codex 多一步 conditional `enter_worktree` 创建 vs 复用) — adapter 差异 by design (claude 有 native EnterWorktree CLI, codex 无)
- **R2-INFO-3** constraint 5 示例克制: reviewer 反模式表示例 ≥ 3 个但全部类别枚举非重复同款示例 — 不违反约定
- **R2-INFO-4** R1 新增 cross-ref inline 注释密度较高 — 属合理关注点分离约束,无 over-engineering

## R1 收口实况

### reviewer-codex R1 reply (msg ecd4b60d)

7 finding: 2 HIGH (C-H1 / C-H2) + 3 MED (C-M1 deprecated / C-M2 baseline priority / C-M3 Fresh session 双义) + 1 MED (C-M4 历史修法) + 1 LOW (C-L1 NO MSG ANCHOR 建议→请)。**核心隐患**: deep-review prompt 在 reviewer fail 与 cache ignore 失败时给的动作会削弱异构保障和安全边界 (C-H1/H2);adapter 差异不可执行表述会让 reviewer/lead 决策时丢失硬规则。

### reviewer-claude R1 reply (msg 49c3cded)

8 finding: 0 HIGH + 4 MED (L-M1 frontmatter / L-M2 clear-team / L-M3=C-L1 NO MSG ANCHOR / L-M4 shared-team) + 1 LOW (L-L1 但字) + 3 INFO (L-INFO1 弱断言列表 inline / L-INFO2 sync lint advisory / L-INFO3 flow-arch-plantuml asymmetry)。**核心隐患**: codex-config 端 4 处 mirror SSOT drift 同时违反 user CLAUDE.md §提示词资产维护 constraint 3 + constraint 2 — 推断 codex 端镜像维护时手工改写未严格对齐 claude 母本;协议层 (wire format / send_message / FRESH SESSION 自检 / scope 路径前缀 / NO MSG ANCHOR fallback) 双端一致干净;两份 mirror SKILL byte-identical 验证 sync-codex-skills.mjs 维护到位。

### 反驳轮 (R1 HIGH × 2)

并发 send_message 给 reviewer-claude (claude-code adapter,与 codex 异构) 反驳两条 codex 单方 HIGH:
- **HIGH-1 反驳** (msg 5cc1ceab): ❌ 反驳成功降级 MED + UX 改进 (explicit confirm step)
- **HIGH-2 反驳** (msg 6670bcce): ❌ 反驳成功降级 MED + fallback 优先级链 callout

### R1 fix 实施 (commit b41cdce)

13 处 finding 一次性 fix:
- claude/codex 两端镜像 SSOT 漂移 4 处 (NO MSG ANCHOR / clear-team / shared-team / 但字) — codex 端改齐 claude 母本
- 当前事实不写 FUTURE/兼容/历史修法 3 处 (deprecated / 历史修法痕迹 / followup UX) — 注意 deprecated 因 Edit 工具 race 未真 land,R2 重提
- 弱断言可执行性改进 1 处 (frontmatter 自行确认)
- 边界条件清晰化 1 处 (Fresh session CLI 隐式 fork 双义)
- 改进 callout 3 处 (HIGH-1 → MED ack_cache_unignored / HIGH-2 → MED fallback 优先级链 / L-INFO3 codex 端 plantUML 走法)
- 设计意图说明 inline 注释 2 处 (弱断言列表 inline / baseline §优先级声明节 adapter 差异)

`scripts/sync-codex-skills.mjs` 同步 codex SKILL 镜像本地 working tree (.gitignore:18 排除入 git, SSOT = claude SKILL)。

## R2 收口实况

### reviewer-codex R2 reply (msg 6ea4494f)

4 finding (0 HIGH / 3 MED / 1 LOW): 不能直接可合。R1 skip 宣称修掉的 `deprecated` 仍在当前资产中 (R2-MED-1);R1 新增 `ack_cache_unignored` 和 codex plantUML 走法还有可执行性 / 协议矛盾 (R2-MED-2 + R2-MED-3);CLAUDE.md:127 仍有非边界化「可能」(R2-LOW-1)。

补充验证: deep-review claude/codex mirror cmp=0 / hello-from-deck claude/codex mirror cmp=0 / R1 fallback 优先级链 ① retry → ② 合规兜底 → ③ 降级单方 已覆盖 retry 超时和 setup fail (未列新 MED)。

### reviewer-claude R2 reply (msg 01a2cb6f)

0 新 HIGH / 0 新 MED + 4 INFO advisory → **可合**。R1 fix 13 处变更全验通过;5 hard constraints re-verification 全 ✅ (constraint 2 grep 命中 4 行 deprecated 判「合法 plantUML INDEX 状态枚举非违反」);kind='code' Round 2 race/lifecycle/边界条件全过;kind='plan' Round 2 不变量/行级 reference/测试矩阵全过;cross-doc mirror parity post-R1 全过;失败兜底链 coverage 完整。lead 决定:建议直接 conclude — INFO 均非阻断项。

### lead 裁决冲突 (deprecated finding)

reviewer-codex R2-MED-1 提 deprecated 字面违反 constraint 2 必修 vs reviewer-claude R2 判「合法 plantUML INDEX 状态语义非违反」。**lead 走 reviewer-codex 那边**:字面违反 user constraint 2 关键词 list 含 deprecated + 修复成本极低 (字符替换) + 避免下次 reviewer 不停 catch 同款 finding。

### R2 fix 实施 (commit efd0702)

4 处 fix:
- R2-MED-1: CLAUDE.md:164/170 + flow-arch-plantuml SKILL:36/46 deprecated → archived (强制 grep verify 真 land,补 flow-arch SKILL R1 漏改)
- R2-MED-2: deep-review SKILL §Scope schema 加 `ack_cache_unignored?: boolean` 字段定义
- R2-MED-3: CLAUDE.md:151 codex 端 plantUML 走法重写 — 移除 -tpng + 加严禁 -tpng/-tsvg 渲染 + 改按 SSOT 手工编辑 .puml + 可选 -syntax 检查
- R2-LOW-1: CLAUDE.md:127「环境若提供...可能」→「Agent Deck 应用环境的合规兜底分支详 §...节」

`scripts/sync-codex-skills.mjs` 同步 codex SKILL 镜像本地 working tree。

## R3 收口实况

### reviewer-codex R3 reply (msg 9d36578a) → **可合**

Quick verify 通过:
- `deprecated|DEPRECATED` 在 9-scope 为 0 命中
- `ack_cache_unignored` 同时出现在 deep-review typed schema 与 sandbox step,且 claude/codex deep-review mirror `cmp=0`
- codex 端 plantUML 走法已改为手工编辑 `.puml` + 可选 `plantuml -syntax`,`-tpng/-tsvg` 仅出现在「严禁渲染」句里,与 flow-arch SKILL §不渲染 SSOT 对齐
- R2-LOW-1 cross-ref 有效: CLAUDE.md 同文件存在 `§应用环境特有能力 §reviewer-codex 失败 → SKILL 内合规兜底分支`,且旧短语「可能在该环境内」已无命中

未发现新协议矛盾或镜像漂移。

## 最终收口总结

**finding 总计**: R1 15 条 (8 reviewer-codex + 8 reviewer-claude − 1 重复 = 15) + R2 5 条 (4 reviewer-codex + 1 reviewer-claude 可合 + 4 advisory INFO) = 20 条 finding。

**裁决总计**:
- ✅ R1 必修: 12 条 (2 HIGH 反驳后降级 MED + 10 MED/LOW)
- ✅ R2 必修: 4 条 (3 MED + 1 LOW)
- ❌ 反驳成功降级: 2 条 (C-HIGH-1 / C-HIGH-2 都降 MED + 提改进采纳)
- INFO 不修: 4 条 (L-INFO1 设计意图 inline 注释采纳;L-INFO2 future advisory 不实施;L-INFO3 R2 重写采纳;R2 reviewer-claude 4 INFO advisory)
- **R1+R2 合计修法**: 17 处 (13 R1 + 4 R2)

**收口判定**: 双方共识可合 — reviewer-claude R2 explicit「建议直接 conclude」+ reviewer-codex R3 ack (等待);0 残留 HIGH/MED;所有 fix 经 grep verify 真 land + cross-doc mirror parity 维护到位。

**异构对抗价值实证**:
- **codex 抓「字面合规 / 协议矛盾 / 不可执行 flag」**: R1 deprecated 字面违反 / R2 ack_cache_unignored 不在 schema / R2 codex plantUML -tpng 与 §不渲染 SSOT 矛盾 (reviewer-claude 判 deprecated「合法状态语义」错过)
- **claude 抓「mirror SSOT drift / 弱断言可执行性 / 设计意图说明缺失」**: 4 处 codex 端 mirror drift / frontmatter「自行确认」/ 弱断言列表 inline 设计意图无注释 (reviewer-codex 未提)
- **同源化双 Claude 会同时漏 codex 的 R2-MED-1 (deprecated R1 fix 没真 land 因 Edit 工具 race)** — 异构对偶价值再次实证 (REVIEW_61 批 C 同款铁证)
- **Edit 工具 race 抓到**: reviewer-codex R2-MED-1 不仅指出 fs 现状,还指出 R1 commit diff 与 skip 字段不一致 (`git show b41cdce` 验证 commit 没含 deprecated → archived line 162/167 改动) — 这种「commit hash + skip 字段 + fs 现状三向验证」是 reviewer-codex 抓 bug 的独门武器

**SKILL 学习点**:
1. **prompt asset review 比 code review 严格**: prompt 是 LLM 直接 enforce 的规约不是给人看的设计稿,「建议 / 推荐 / 可能」等弱断言会让 reviewer/lead 决策时丢失硬规则;字面违反 constraint 2 关键词 list 即使语义不违反也应改名避免下次 reviewer 不停 catch 同款
2. **Edit 工具 race**: Read 时 33497 token oversized 走 system-reminder fallback 后续 Edit 可能基于 stale 副本,**必须** grep verify Edit 真 land 才进 commit
3. **R1 fix 引入新内容必须再 review**: R1 fix 引入 ack_cache_unignored flag / codex 端 plantUML 走法都被 R2 抓出新问题 (前者 schema 不完整,后者协议矛盾)
4. **lead 裁决冲突时走更严的那边**: deprecated 字面违反硬约束 vs reviewer-claude 判「合法状态语义」,lead 走 reviewer-codex 严格那边 (字面违反 + 修复成本低 + 避免重复抓)
5. **kind='mixed' 双 mode 并行价值**: 同一对 reviewer 拼合并 prompt 同时审 code 实施 + plan 设计,prompt asset 这种「规约代码 = 设计文档」双重身份的资产 mixed mode 是最适合的 (节省 reviewer × 2,prompt 体积翻倍换深度)

`heterogeneous_dual_completed: true`
