# CHANGELOG_173 — 提示词资产 review R1+R2 收口 (17 处必修 fix)

## 概要

[REVIEW_62.md](../../reviews/history/REVIEW_62.md) 提示词资产 review R1+R2+R3 三轮异构对抗 + 反驳轮 + lead 现场验证后,**17 处必修 finding** 一次性收口 (R1 13 处 + R2 4 处)。9 份 prompt asset (`resources/claude-config/CLAUDE.md` + `CODEX_AGENTS.md` + `agents/reviewer-{claude,codex}.md` + `skills/{hello-from-deck,flow-arch-plantuml,deep-review}/SKILL.md` 含 codex 端 2 份 sync 镜像) 合计 1923 LOC,是 batch A/B/C (REVIEW_59/60/61) 之后第一次专门对 prompt 资产 self-review。

按 user CLAUDE.md §提示词资产维护 5 条硬约束 (信息密度 / 当前事实 / 可执行性 / 范围与失败兜底 / 示例克制) 评审,走 agent-deck:deep-review SKILL kind='mixed' (双 mode 并行) 多轮异构对抗 reviewer-claude `dace5ba1` Opus 4.7 + reviewer-codex `019e6e9e` gpt-5.5 xhigh 跨 adapter native pair。

## 修法 (按 Round 顺序)

### R1 13 处 fix (commit b41cdce)

#### 镜像 SSOT 漂移 4 处 (claude/codex 两端 baseline 手工双维护累积)

- **L-MED-3 = C-LOW-1** (双方独立提出) [`CODEX_AGENTS.md:122`]: NO MSG ANCHOR reply 顶部硬性 warn 文案「建议 lead 通过 send_message」→「请 lead 通过 send_message」改齐 claude 端母本 (line 630 用「请」)。这是 reviewer 端硬性输出文案,弱断言「建议」让 lead 看到以为可选 → 不重发 anchor → fallback 路径滥用
- **L-MED-2** [`CODEX_AGENTS.md:212`]: `'clear-team'` default 选项「(default,推荐)」+「保最大兼容性」→「(default)」+「适用面最广」改齐 claude 端母本 (line 714)。「推荐」违反 constraint 3 可执行性 + 「兼容性」违反 constraint 2 关键词
- **L-MED-4** [`CODEX_AGENTS.md:110`]: shared-team 前置约束 trade-off 写「选项 1 简单粗暴丢 mental model;选项 2/3 保留 mental model 推荐」→ claude 端母本 (line 618)「需要保留 reviewer 跨轮 mental model → 走选项 2/3;接受重跑 reviewer → 走选项 1」双向条件→动作隐含取舍格式 (删末尾「推荐」违反 constraint 3)
- **L-LOW-1** [`CODEX_AGENTS.md:216`]: `task_task_policy` 失败兜底连词 trivial 漂移 — codex 端多出「但」字,改齐 claude 端 (line 718) 无「但」字格式

#### 当前事实不写 FUTURE / 兼容 / 历史修法 3 处 (违反 constraint 2)

- **C-MED-1** [`CLAUDE.md:161/167`]: plantUML INDEX 状态枚举 `'deprecated'` → `'archived'` + AskUserQuestion 文本「新建 vs 修改 vs deprecated 已有」→「archived 已有」。`deprecated` 字面违反 user constraint 2 关键词 list (虽然语义是 plantUML INDEX 状态机标签而非「兼容旧版本」)。**注**: 本次 R1 fix Edit 工具返回 "updated successfully" 但 fs 未真 land (推断:首次 Read CLAUDE.md 33497 token oversized 走 system-reminder fallback 副本导致 Edit 基于 stale),R2 reviewer-codex 重抓后强制 grep verify 真 land
- **C-MED-4** [`CODEX_AGENTS.md:132/137/143/162/205/206/226` + `CLAUDE.md:664`]: 删 baseline 注入的历史修法引用 `P5 Round 1 reviewer-codex M1/M2/M4 修法` / `REVIEW_46/47` / `plan handoff-no-spawn-guards-20260526 §D1/§D4/§D6` / `原名 batonMode` / `followup 20260515` 等历史痕迹 — 作为注入所有未来 SDK session 的 baseline 占上下文 + 把旧名称带回推理链,历史引用应在 `ref/plans/` `ref/reviews/` `ref/changelogs/` 归档保留
- **C-MED-1 后续** [`CLAUDE.md:664`]: `- **followup UX 完善**:` → `- **UX 完善**:` (移除 `followup` 历史前缀)

#### 弱断言可执行性改进 1 处 (违反 constraint 3)

- **L-MED-1** [`reviewer-codex.md:3` frontmatter]: description「典型 gpt-5.5,user 端 codex CLI 实际可用 model id 自行确认」→「frontmatter `model: gpt-5.5` 透传到 codex SDK ThreadOptions;codex CLI 不支持该 model id 时 fallback 到 user `~/.codex/config.toml` 顶层 model 配置」。frontmatter description 注入到 SDK system prompt 的 plugin agent registry,lead 调 spawn_session 决策时直接读,「自行确认」是弱断言让 lead 不知 fallback 路径

#### 边界条件清晰化 1 处

- **C-MED-3** [`reviewer-claude.md:41-42`]: Fresh session 自检子项「CLI 隐式 fork / jsonl 缺失走 fallback createSession 不带 resume」同词「CLI 隐式 fork」在 line 41 (触发因子) + line 42 (SDK resume 范畴) 双义。**修法**: line 41 删「CLI 隐式 fork /」字样只留 jsonl 缺失 fallback + 加独立子项「CLI 隐式 fork 软 fork 也不算 fresh:sessionId 改了 + jsonl 在 + DB rename 子表迁完 → 属 SDK resume 范畴」与 dormant 子项并列,避免 reviewer 自己困惑

#### 改进 callout 3 处 (反驳轮 HIGH-1/HIGH-2 → MED + INFO-3 采纳)

- **HIGH-1 → MED UX 改进** [`deep-review/SKILL.md:65`]: 加 explicit confirm step「批处理 / 自动调度场景 (caller 看不到 warn 输出): caller 必须在 invoke SKILL 时显式传 `ack_cache_unignored: true` 跳过自检 + 接受 cache untracked 风险;否则 SKILL warn + abort 让 caller explicit consent」— 修反驳轮 reviewer-claude 提的真正改进点 (silent warn 在批处理场景看不到 → silent continue)
- **HIGH-2 → MED fallback 优先级链 callout** [`deep-review/SKILL.md:99 + §207`]: 加 explicit fallback 优先级链「① 等 SDK / OAuth 恢复 (短超时 retry ≤ 5min) → 失败转 ② / ② §195/196 合规兜底起外部 CLI (仍异构,典型 5-10min setup) → 用户拒绝 / setup 失败转 ③ / ③ 降级单方非 HIGH 走当前 §99 fast path (失去补对方视角,但 §三态裁决 §单方独有分流 保障 single-side HIGH 不被错升级)」+ §207 失败兜底表 kind='mixed' row callout「lead 必按 ①retry → ②合规兜底 → ③降级单方 顺序,不要直接走 ③ 跳过 ① ②」— 修反驳轮提的优先级表述漏洞 (lead 看 §99 fast path 可能跳过合规兜底)
- **L-INFO-3** [`CLAUDE.md` §核心流程架构变更必走 plantUML 节]: 加 codex 端走法说明 (flow-arch-plantuml SKILL 仅 claude-config 端打包,codex 端无对偶 — 需声明 fallback)。**注**: R1 写法用 `-tpng` 渲染 PNG 被 R2 reviewer-codex 抓出与 flow-arch SKILL §不渲染 SSOT 协议矛盾 → R2 重写

#### 设计意图说明 inline 注释 2 处 (advisory L-INFO-1 + C-MED-2)

- **L-INFO-1** [`CLAUDE.md:118`]: 弱断言关键词列表加 inline 注释「注:reviewer-{claude,codex}.md §核心纪律 inline 重复此列表是设计意图 — reviewer agent body 独立注入 SDK,不依赖本文件 baseline 加载顺序,维护时不要按「冗余必合并」规则去抽 SSOT」— 设计意图非冗余 (reviewer agent body 是 plugin 注入到 SDK system prompt 的独立 context,不读 CLAUDE.md baseline)
- **C-MED-2** [`CLAUDE.md:13` + `CODEX_AGENTS.md:13`]: baseline §优先级声明节 加 adapter 差异说明 — claude 端 settingSources auto-load user CLAUDE.md / codex 端 ~/.codex/AGENTS.md marker 注入无对等机制,两端措辞不同是 adapter 差异不是 SSOT drift,维护时不要强行对齐两端

### R2 4 处 fix (commit efd0702)

#### R2-MED-1 [`CLAUDE.md:164/170` + `flow-arch-plantuml/SKILL.md:36/46`] deprecated → archived (R1 fix 未真 land 重做 + 补 flow-arch SKILL 漏改)

R1 fix Edit 工具返回 "updated successfully" 但 fs 未真 land (R2 reviewer-codex 抓 `git show b41cdce` 验证 commit 没含改动 line + grep CLAUDE.md fs 现状仍是 deprecated)。推断: 首次 Read CLAUDE.md 33497 token oversized 走 system-reminder fallback 副本,后续 Edit 基于 stale 副本写但 fs 未同步。

R2 强制 grep verify 真 land + 同时改 R1 完全漏改的 flow-arch SKILL 内 line 36/46 同款 `deprecated` 引用:
- `CLAUDE.md:164` 状态枚举 `'deprecated'` → `'archived'` + `' DEPRECATED:'` → `' ARCHIVED:'`
- `CLAUDE.md:170` AskUserQuestion 文本 `deprecated 已有` → `archived 已有`
- `flow-arch-plantuml/SKILL.md:36` Step 0 AskUserQuestion 「标记 deprecated」→「标记 archived」
- `flow-arch-plantuml/SKILL.md:46` Step 4 INDEX 同步「标 deprecated」→「标 archived」

#### R2-MED-2 [`deep-review/SKILL.md` §Scope schema] 加 `ack_cache_unignored?: boolean` 字段定义

R1 fix 引入 explicit confirm step 让 caller 必须传 `ack_cache_unignored: true` 跳过 .gitignore 自检 (修反驳轮提的 HIGH-1 → MED 改进),但 SKILL §Scope schema 仍只列 `kind` / `paths` 两个字段 — caller 不知道这个 flag 属于 scope / spawn prompt / env var,**不可执行**。

修法: 扩 schema 为:
```ts
{
  kind: 'code' | 'plan' | 'mixed',
  paths: string[],
  ack_cache_unignored?: boolean   // optional;批处理 / 自动调度场景显式 ack 跳过 .gitignore 自检 + 接受 cache untracked 风险(详 §Sandbox 处理 step 6)。default false
}
```

#### R2-MED-3 [`CLAUDE.md:151`] codex 端 plantUML 走法重写 (修协议矛盾)

R1 fix 引入 codex 端 plantUML 走法「直接调 `shell: plantuml -tpng <file>.puml`」 — 与 flow-arch SKILL frontmatter「纯生成/修改 .puml SSOT 不渲染」+ §68「本 SKILL **不调** plantuml CLI 渲染」**直接协议矛盾**。

修法: 重写 codex 端走法 — 移除 -tpng + 改按 flow-arch SKILL §不渲染 SSOT 手工编辑 .puml + INDEX.md (与 claude 端 SKILL 编辑动作等价) + 可选跑 `plantuml -syntax` 做语法检查;加「**严禁** codex 端调 `plantuml -tpng / -tsvg` 渲染产 PNG/SVG (违反 flow-arch SKILL §不渲染 SSOT — user 想看渲染产物自跑 plantuml CLI)」防止再撞。

#### R2-LOW-1 [`CLAUDE.md:127`] 「环境若提供...可能」→ 事实句

reviewer-codex 失败兜底节末尾 callout 写「环境若提供多轮 review 编排能力 (teammate / SKILL 模式),**可能在该环境内 SKILL 定义**「合规兜底」分支 (...);通用决策对抗节不走那条」— 本文件就是 Agent Deck 应用环境 baseline,「可能」非事实表述。

修法: 改成事实句「Agent Deck 应用环境的合规兜底分支详 §应用环境特有能力 §reviewer-codex 失败 → SKILL 内合规兜底分支 节;§决策对抗 主路径 (双 Bash 单次决策对抗起外部 CLI) 不走 SKILL 编排路径」。

## codex SKILL 镜像同步

R1 fix 改 `deep-review/SKILL.md` 后跑 `scripts/sync-codex-skills.mjs` 同步本地 working tree codex 端 mirror (R2 fix 同款)。`.gitignore:18` 排除 `resources/codex-config/agent-deck-plugin/skills/` 整目录入 git (codex SKILL = sync 生成 mirror build artifact, SSOT = claude SKILL)。git tracked 5 文件 (claude CLAUDE.md / reviewer-claude.md / claude SKILL.md / codex CODEX_AGENTS.md / reviewer-codex.md);codex 端 SKILL 镜像应用打包时由 sync-codex-skills.mjs trigger 跑生成。

## 异构对抗价值实证

- **codex 抓「字面合规 / 协议矛盾 / 不可执行 flag」**: R1 deprecated 字面违反 constraint 2 关键词 / R2 ack_cache_unignored 不在 schema / R2 codex plantUML -tpng 与 §不渲染 SSOT 矛盾。reviewer-claude R2 时间点上判 deprecated「合法 plantUML INDEX 状态枚举非违反」错过 — 同源化双 Claude 会同时漏 R2-MED-1 (deprecated R1 fix 没真 land 因 Edit 工具 race)
- **claude 抓「mirror SSOT drift / 弱断言可执行性 / 设计意图说明缺失」**: R1 4 处 codex 端 mirror drift / reviewer-codex frontmatter「自行确认」/ 弱断言列表 inline 设计意图无注释 (reviewer-codex 未提)
- **Edit 工具 race 抓到独门武器**: reviewer-codex R2-MED-1 不仅指出 fs 现状,还 cross-verify R1 commit diff (`git show b41cdce`) 与 skip 字段三向不一致 — 这种「commit hash + skip 字段 + fs 现状三向验证」是 reviewer-codex 抓 bug 的独门武器,REVIEW_61 批 C 同款铁证

## SKILL 学习点

1. **prompt asset review 比 code review 严格**: prompt 是 LLM 直接 enforce 的规约不是给人看的设计稿,「建议 / 推荐 / 可能」等弱断言会让 reviewer/lead 决策时丢失硬规则;字面违反 constraint 2 关键词 list 即使语义不违反也应改名避免下次 reviewer 不停 catch 同款 finding
2. **Edit 工具 race**: Read 时 33497 token oversized 走 system-reminder fallback,后续 Edit 可能基于 stale 副本,**必须** grep verify Edit 真 land 才进 commit
3. **R1 fix 引入新内容必须再 review**: R1 fix 引入 ack_cache_unignored flag / codex 端 plantUML 走法 / fallback 优先级链 callout 都被 R2 抓出新问题或新疑虑 (前者 schema 不完整,中者协议矛盾,后者表述漏洞)
4. **lead 裁决冲突时走更严的那边**: deprecated 字面违反硬约束 vs reviewer-claude 判「合法状态语义」,lead 走 reviewer-codex 严格那边 (字面违反 + 修复成本低 + 避免重复抓)
5. **kind='mixed' 双 mode 并行价值**: 同一对 reviewer 拼合并 prompt 同时审 code 实施 + plan 设计,prompt asset 这种「规约代码 = 设计文档」双重身份的资产 mixed mode 是最适合的 (节省 reviewer × 2,prompt 体积翻倍换深度)

## 验证

- `grep -nE 'deprecated|DEPRECATED' 9-scope` → 0 命中 (reviewer-codex R3 实测)
- `grep -nE '兼容|FUTURE|TODO|未来|向后|deprecated|过渡期|后续会加|老版本|P5 Round|REVIEW_[0-9]+|原名|旧文档|修法|followup' 9-scope` → 1 命中 (`CLAUDE.md:338 ref/reviews/REVIEW_38.md` 上游 bug 追溯引用,非违反)
- `grep -nE '建议|应该考虑|最好|可以(用|走|考虑)|大概率?|通常|一般' 9-scope` → 0 命中 (R1 fix 完全消除弱断言关键词)
- claude/codex deep-review SKILL mirror `diff -q` → 0 输出 (byte-identical)
- claude/codex hello-from-deck SKILL mirror `diff -q` → 0 输出 (byte-identical)
- `ack_cache_unignored` 同时在 `deep-review/SKILL.md` §Scope schema (line 28) + §Sandbox 处理 step 6 (line 66) 出现
- codex 端 plantUML 走法 `plantuml -tpng / -tsvg` 仅出现在「严禁渲染」句里 (与 flow-arch SKILL §不渲染 SSOT 对齐)
- CLAUDE.md:127 旧短语「可能在该环境内」无命中 (改成事实句 cross-ref 有效)

`heterogeneous_dual_completed: true`
