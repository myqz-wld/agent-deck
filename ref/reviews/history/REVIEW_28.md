---
review_id: 28
reviewed_at: 2026-05-12
expired: false
skipped_expired:
---

# REVIEW_28: 移除 spawn-guards §6.2 cwd cycle + list_sessions / get_session 修法

## 触发场景

用户实测 `deep-code-review` SKILL 调 `mcp__agent_deck__spawn_session` 起首个 reviewer-claude teammate 时被 `same-cwd same-adapter spawn cycle detected` 直接 deny —— SKILL 设计要求 lead (claude-code, REPO) 起两个 reviewer teammate 都用 `adapter:'claude-code', cwd:REPO`，与 spawn-guards.ts §6.2 cwd realpath 整链回溯规则**直接矛盾**。

同时用户反馈 list_sessions 在 SKILL 里两处用法（Step 0 自检 + 失败兜底查 receiver 状态）都很弱：Step 0 是仪式性 RTT 不带决策信息；失败兜底返回大量无关 session 难辨认「哪些是自己 spawn 的」。

合并这两处问题做一次完整修复。

## 方法

**双对抗配对**（见 `~/.claude/CLAUDE.md`「决策对抗」节 — 单次决策对抗，按 §主路径 subagent 跑 `Task(subagent_type:"agent-deck:reviewer-claude")` + `Task(subagent_type:"agent-deck:reviewer-codex")` 同 message 并发）：

- **Reviewer A**：reviewer-claude（Opus 4.7 xhigh / claude-code subagent 内嵌）—— focus TS / 业务正确性 / SKILL 文档 / 测试覆盖
- **Reviewer B**：reviewer-codex（gpt-5.5 xhigh / Bash 调外部 codex CLI 抓最终结论）—— focus 系统 / 安全 / 极端场景 / 资源消耗

**reviewer-codex 失败重试历史**：

| # | 结果 | 处理 |
|---|---|---|
| 1 | `402 Payment Required: Insufficient credits` (xaminim provider) 5 次重连失败 | 主 agent 按规则提示用户决策，不自动降级到同源双 Claude |
| 2 | 用户选「再重跑一下」→ 仍 402（同 provider 余额未充） | 主 agent 再次提示决策 |
| 3 | 用户切换 codex provider 后重跑 → ✅ exit 0 / token 48k / 耗时 479s | 拿到完整结论与 reviewer-claude 异构对抗 |

**范围**：6 文件 / 约 350 行（含新增 get_session tool + spawned_by_filter + 文档同步 + 单测 + ADR §6.2 / §3 / §10 / §13 改写）。

```text
src/main/agent-deck-mcp/spawn-guards.ts                          # A 段 删 §6.2 + 重排顺序
src/main/agent-deck-mcp/tools.ts                                 # A/E/F 段 description / list_sessions / get_session / projectSession
src/main/agent-deck-mcp/types.ts                                 # F 段 EXTERNAL_CALLER_ALLOWED 加 get_session
src/main/agent-deck-mcp/transport-stdio.ts                       # F 段 5→6 占位文案
src/main/agent-deck-mcp/__tests__/spawn-guards.test.ts           # B 段 删 §6.2 用例 + 加 fan-out deny 不消耗 rate token 用例
src/main/agent-deck-mcp/__tests__/tools.test.ts                  # B/E/F 段 删 cycle 用例 + 加 spawned_by_filter ×2 + get_session ×2
src/main/store/session-repo.ts                                   # A 段 listAncestors deprecated 注释
src/renderer/components/settings/sections/AgentDeckMcpSection.tsx # A/F 段 UI 文案删「整链 cwd cycle 检测」+ 5→6 tool
docs/agent-deck-mcp-protocol.md                                  # C 段 ADR §6.2/§6.3/§3.4/§3.5/§10/§13 + 5→6
docs/agent-deck-team-protocol.md                                 # 5→6 tool
README.md                                                        # 5→6 tool
resources/claude-config/CLAUDE.md                                # 5→6 tool
resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md  # D 段 Step 0 + 失败兜底 + 5→6
resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md         # 5→6
resources/claude-config/agent-deck-plugin/agents/reviewer-codex.md          # 5→6
```

**机器可读范围**（File-level Review Expiry 用；一行一个仓库相对路径，按字典序、去重；禁止目录 / glob / brace expansion）：

```review-scope
README.md
docs/agent-deck-mcp-protocol.md
docs/agent-deck-team-protocol.md
resources/claude-config/CLAUDE.md
resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md
resources/claude-config/agent-deck-plugin/agents/reviewer-codex.md
resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md
src/main/agent-deck-mcp/__tests__/spawn-guards.test.ts
src/main/agent-deck-mcp/__tests__/tools.test.ts
src/main/agent-deck-mcp/spawn-guards.ts
src/main/agent-deck-mcp/tools.ts
src/main/agent-deck-mcp/transport-stdio.ts
src/main/agent-deck-mcp/types.ts
src/main/store/session-repo.ts
src/renderer/components/settings/sections/AgentDeckMcpSection.tsx
```

**约束**：本轮不重审已被 CHANGELOG 1-70 / REVIEW 1-27 修过的问题，聚焦本次 plan 6 段（A-F）；输出格式按 HIGH / MED / LOW / INFO + 文件:行号 + 验证手段。

## 三态裁决结果

> 本节遵循全局「决策对抗」节的验证纪律：每条 ✅ 必须带**验证手段**（grep / 写小 test / 跑命令 / 读真实代码），未验证的 finding 强制降级 ❓ + 非 HIGH。弱断言关键词（"可能 / 也许 / 看起来"）只允许出现在 *未验证* 条目里。

### ✅ 真问题（双方独立提出 / 一方提出且现场实践验证成立）

| # | 严重度 | 文件:行号 / plan 段 | 问题 | 报告方 | 验证手段 |
|---|---|---|---|---|---|
| 1 | HIGH | tools.test.ts:358-370 / B 段 | 漏列 `'rejects same-cwd same-adapter (self-spawn cycle)'` 用例同步删，删 §6.2 后 vitest 必挂 | reviewer-claude HIGH-1 | 主 agent grep `spawn cycle detected` 命中 tools.test.ts:369 + spawn-guards.test.ts:192 两处 |
| 2 | HIGH | tools.ts:233 + tools.ts:257 / A 段 | spawn_session tool description 含 `cwd-cycle` 字面量、handler 注释含 `cwd cycle`，删 §6.2 后描述与行为不符误导 LLM 调用方 | reviewer-claude HIGH-2 + 主 agent 补 :257 | 主 agent grep `cwd-cycle\|cwd cycle` 命中 tools.ts 2 处 |
| 3 | HIGH | docs/agent-deck-mcp-protocol.md §10 V11/V20 / C 段 | ADR §10 V11 / V20 验证清单直接断言 §6.2 行为，未标 obsolete 会未来重审自相矛盾 | reviewer-claude HIGH-3 | 主 agent 读文件 :584/593 确认两条 acceptance gate 直接引用 §6.2 |
| 4 | MED | spawn-guards.ts:122-129 / 不变量 | rate token 在 fan-out check 前消耗 → 一个已达 fan-out=5 的 lead spam spawn_session 把 app-wide quota 拒掉给别的合法 lead → 饥饿 | reviewer-codex MED-1 | 主 agent 读 spawn-guards.ts 顺序确认 tryConsume 在 fan-out check 之前；ADR §6.3 「跨所有 caller 累计」 |
| 5 | MED | 不变量 / 极端规模 | plan 写「最多 5³=125 session」漏算几何级数；实际 depth=3 / fan-out=5 全开时 1 + 5 + 25 + 125 = 156 live session | reviewer-codex MED-2 | 主 agent 读 spawn-guards.ts:113 `parentDepth >= maxDepth` 才 deny + tools.ts:288 `parentDepth + 1` 写入；spawn-guards.ts:131-141 fan-out per-parent active children |
| 6 | MED | SKILL.md:200 / D 段 | plan D 段建议「lead 直接 wait_reply 探测 sessionId 状态」，但 wait_reply handler tools.ts:436-440 closed target 仍允许 wait → 阻塞到 timeout 才返；返回 schema 无 lifecycle，UX 比原 list_sessions 更差。修法：D 段失败兜底改用 list_sessions(spawned_by_filter) 或 get_session 联动 | reviewer-claude MED-1 | 主 agent 读 tools.ts:436-440 + return schema :511-518 确认无 lifecycle 字段 |
| 7 | MED | F 段 / 跨文档 ≥15 处 | 5→6 tool 影响 EXTERNAL_CALLER_ALLOWED Record（不补 key TS 编译报错）+ 跨 src / docs / resources / README 共 ≥15 处文案需同步 | reviewer-claude MED-2 | 主 agent grep `5 个 tool\|5 tool\|5 tools` 命中 src/docs/resources/README ≥15 处；EXTERNAL_CALLER_ALLOWED 是 `Record<AgentDeckToolName, boolean>` 缺 key TS 报错 |
| 8 | MED | AgentDeckMcpSection.tsx:121-122 / A 段 | UI 提示文字「调高需配合整链 cwd cycle 检测」与删 §6.2 后行为相反，误导用户 | reviewer-claude MED-3 | 主 agent 读 AgentDeckMcpSection.tsx:120-122 确认 |
| 9 | MED | spawn-guards.ts:78 / A 段 | sessionRepo.listAncestors 删 §6.2 后变孤儿 API，需标 deprecated 否则未来重构扫到当 dead code 误删 | reviewer-claude MED-4 | 主 agent grep `listAncestors` 命中生产代码仅 1 处（spawn-guards.ts:78），其余 2 处是 test mock |
| 10 | LOW | spawn-guards.test.ts:175-182 / B 段 | `cycle deny 路径自动 release in-flight` 用例依赖 §6.2 触发「inc 后 deny」对称性；删 §6.2 后所有 deny 在 inc 前，此用例失去触发场景应同步删 | reviewer-claude LOW-1 | 主 agent 读 applySpawnGuards 顺序确认所有非 §6.2 deny 都在 line 141 inc() 之前 |
| 11 | LOW | spawn-guards.ts:67 / A,C 段 | §6.2 删除后残留「同 cwd 同 adapter 语义自递归」（fan-out=1 + depth=3）由 depth 截断接受；ADR 「移除」段不应写「完全等价覆盖」误导 | reviewer-codex LOW-1 | 主 agent 读 depth/fan-out/rate 三段，未含 cwd/adapter 语义判断 |
| 12 | LOW | tools.ts get_session / F 段 | get_session 复用 list 同款 projection 无新增 metadata 暴露，但「按 ID 精确查询」是未来 multi-user 隔离下的存在性 oracle 入口 → 必须复用同一 projector 禁止 raw SessionRecord，future visibility predicate 加在一处 | reviewer-codex LOW-2 | 主 agent 实施时抽 `projectSession` 共享 helper |
| 13 | LOW | E 段单测 + ADR | spawned_by_filter 单测应 ≥ 2 例（单独 / 联合 status_filter）+ ADR 加「无 ownership 校验，与现状信任域一致」一句 | reviewer-claude LOW-2 | 主 agent 实施时加 2 例单测 + ADR §3.4 信任边界一句 |

### ❌ 反驳（被对抗或现场核实证伪）

| 报告方 | 报项 | 反驳依据 |
|---|---|---|
| —— | —— | 本轮无证伪 finding。reviewer-claude 9 条 grep 实证全部成立；reviewer-codex 4 条系统/安全角度全部成立；两路 focus 完全互补无重叠，**不需要交叉反驳**（按规则单方独有 HIGH 应起反驳轮，但 reviewer-claude 所有 HIGH 都属「工程清扫 + grep 不可反驳」级 → 主 agent 现场 grep 验证替代反驳轮） |

### ❓ 部分 / 未验证（双方角度不同 / 一方提出但未实践验证）

| 现场 | A 视角 | B 视角 | 是否已验证 | 结论 |
|---|---|---|---|---|
| RateLimiter 撞顶恢复语义 | —— | reviewer-codex *未验证*-1：滑动窗口最早 ts 过期即恢复（按 ADR 推演，未读 rate-limiter.ts） | ✅ 主 agent 现场读 rate-limiter.ts:24-39 验证：tryConsume 同步 prune 过期 + push 当前 ts；retryAfterMs 算最早 ts 距过期还多久。**升级 ✅ 已验证** | 推演正确，无需修改 |
| spawned_by_filter SQLi 面 | —— | reviewer-codex INFO-1：filter 走内存 equality 无 SQL 注入面，应在 slice(limit) 前执行 | ✅ 实施时 filter 放 slice 前 | 无新风险 |

## 修复（CHANGELOG_71 落地）

### A. spawn-guards.ts 删 §6.2 + 重排顺序

1. **`spawn-guards.ts`** — 删 `checkCwdCycleAlongChain` + `safeRealpath` import；`applySpawnGuards` 顺序改为 depth → fan-out → spawn-rate（rate token 最后扣）；头注释更新为「3 条规则」+ 注释 §6.2 移除原因
2. **`tools.ts:233`** — spawn_session description 删 `cwd-cycle` 字段
3. **`tools.ts:256-258`** — handler 注释「4 条规则」改「3 条规则」+ 移除 §6.2 提及
4. **`session-repo.ts:listAncestors`** — 标「2026-05 deprecated」注释，保留实现避免 R3 churn
5. **`AgentDeckMcpSection.tsx:121-122`** — UI 文案删「整链 cwd cycle 检测」，改写为 fan-out × spawn-rate 兜底说明

### B. 测试同步

6. **`spawn-guards.test.ts`** — 删 `applySpawnGuards — cwd cycle 整链回溯` describe 全段 + 删 fan-out 段内 `cycle deny 路径自动 release in-flight` 用例；新增 `fan-out deny 不消耗 spawn-rate token（防饥饿）` 用例验证 reviewer-codex MED-1 修法
7. **`tools.test.ts`** — 删 `rejects same-cwd same-adapter (self-spawn cycle)` 用例；改名 `allows different cwd same adapter` → 加新用例 `allows same cwd same adapter (deep-code-review SKILL 合法路径)`

### C. ADR (`docs/agent-deck-mcp-protocol.md`)

8. **§1.1** — 5 个 tool 改 6 个 tool（加 get_session 行）
9. **§3.4 list_sessions** — 加 `spawned_by_filter` schema 字段 + 信任边界说明 + handler 行为加「filter 在 slice 前执行」
10. **§3.5 get_session（新）** — 完整 schema + 行为 + 典型场景 + 信任边界（与 §3.4 一致）
11. **§3.6 shutdown_session** — 原 §3.5 顺次后移
12. **§6 标题** — 「4 条规则」改「3 条规则（B'5 + REVIEW_28 移除 §6.2）」
13. **§6.2** — 改写为「2026-05 移除」+ 残留语义自递归说明（**不**写「完全等价覆盖」）
14. **§6.3** — 加顺序约束段（rate token 在 depth + fan-out 都通过后才扣）
15. **§6.4** — 加极端规模段（1 + 5 + 25 + 125 = 156 live session）
16. **§9** — tools.ts 文件注释 5→6
17. **§10** — V7 5→6 个 tool；V11 / V20 标 ❌ obsolete (REVIEW_28)；V12 / V13 加 REVIEW_28 联动备注；新增 V22 (spawned_by_filter) / V23 (get_session) / V24 (fan-out deny 不消耗 rate token)
18. **§12** — 「R2 的 5 tool」/「R2 的 5 tool」改 6 tool
19. **§13** — 加 2026-05-12 REVIEW_28 完整变更条目

### D. SKILL (`resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md`)

20. **frontmatter description** — 5→6 tool + 加 list_sessions(spawned_by_filter) / get_session 提及
21. **第 10 行** — 5→6 tool
22. **Step 0** — 删 list_sessions 自检，改为 2 步（cwd + scope）+ 一段说明「不要预先 list_sessions 探活」
23. **§失败兜底「投递 failed」一条** — 改为「lead 已持有 sessionId，调 get_session 拿 lifecycle / lastEventAt；多 receiver 救火用 list_sessions(spawned_by_filter)」
24. **§失败兜底新增** — 「lead context 重置后捡起 stranded reviewer」用 list_sessions(spawned_by_filter:'<old_lead_sid>')

### E. list_sessions 加 spawned_by_filter

25. **`tools.ts LIST_SESSIONS_SCHEMA`** — 加 `spawned_by_filter: z.string().min(1).max(128).optional()` + describe 说明信任边界
26. **`tools.ts list_sessions handler`** — 加 filter（在 slice(limit) 前；reviewer-codex INFO-1 修法）
27. **`tools.test.ts`** — 加 2 例：`respects spawned_by_filter` / `combines spawned_by_filter + adapter_filter`

### F. get_session 新 tool

28. **`tools.ts`** — 抽 `projectSession` helper 共享 list/get；加 `GET_SESSION_SCHEMA` + `getSession` tool（read-only annotation）；`buildAgentDeckTools` return 数组加入
29. **`types.ts`** — `AGENT_DECK_TOOL_NAMES` 加 `getSession: 'get_session'`；`EXTERNAL_CALLER_ALLOWED` 加 `'get_session': true`（read-only 类比 list_sessions / wait_reply）
30. **`transport-stdio.ts`** — 21/62 行注释 5→6 tool
31. **`AgentDeckMcpSection.tsx`** — UI 文案 5→6 tool 全部加 `<code>get_session</code>`
32. **`README.md:226`** — 5→6 tool
33. **`resources/claude-config/CLAUDE.md:157`** — 5→6 tool
34. **`docs/agent-deck-team-protocol.md`** — 4 处 5→6 tool
35. **`reviewer-claude.md:21` / `reviewer-codex.md:21`** — 5→6 tool + 加 list_sessions(spawned_by_filter) / get_session 提及
36. **`tools.test.ts`** — 加 2 例 get_session：`returns same projection as list_sessions` / `returns isError when session does not exist`

## 验证

```bash
pnpm typecheck       # ✅ pass（无新增 TS 错误）
pnpm exec vitest run # ✅ 21 files / 325 passed | 55 skipped；无回归
pnpm exec vitest run src/main/agent-deck-mcp/__tests__/spawn-guards.test.ts src/main/agent-deck-mcp/__tests__/tools.test.ts  # ✅ 36/36 (8 spawn-guards + 28 tools)
```

build 与 dev 启动验证 plan 完成后用户在 e2e SKILL 调用时进行（spawn 真 reviewer teammate 验 §6.2 移除生效）。

## 关联 changelog

- [CHANGELOG_71.md](../../changelogs/history/CHANGELOG_71.md)：本次修复落地

## Agent 踩坑沉淀（如有）

本次 review 提炼出 1 条 agent-pitfall 候选（待写入 `.claude/conventions-tally.md`「Agent 踩坑候选」section）：

- **防御规则不要拦合法 SKILL 用例**：spawn-guards §6.2 设计时是「双重保险」性质（depth + fan-out + rate 三条已 cover），但加规则没考虑实际 SKILL 设计的「lead 在 repo 起 reviewer teammate 同 cwd 同 adapter」合法路径，把功能直接锁死。同主题再撞 2 次会触发升级到 CLAUDE.md 项目约定。

- **rate token 扣除时机要在所有「不消耗资源 deny」之后**：rate-limit 是全局共享资源，扣早了会让某 caller 把别的 caller 的 quota「白白消耗」掉 → 饥饿。同款问题以前 task-manager / hook-server 类限流也容易踩，pattern 化后可升级为约定。
