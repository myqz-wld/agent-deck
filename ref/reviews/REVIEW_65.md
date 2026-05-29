---
review_id: 65
reviewed_at: 2026-05-29
expired: false
---

# REVIEW_65: SessionList 3+ 层 spawn-link 树形渲染 bug 修法 R1 单次决策对抗

## 触发场景

User 反馈:lead spawn 一个会话 A,A 又 spawn 一个会话 B(3 层 spawn 链),SessionList UI **不按 3 层来渲染**。复现:实际 mcp list_sessions 数据中 L1=c315c7a4 "agent-deck"(T1/T2 lead)spawn L2=45982d7f "mcp-tool-camelCase plan"(T3 lead),L2 又 spawn L3=019e7331/6e8aeeba reviewer(T3 teammate),UI 上 L2 与 L3 形成一棵树独立挂出,与 L1 视觉脱节,3 层关系断裂。

修法走单次决策对抗(diff ≤ 5 文件 / ≤ 200 行 → §决策对抗 主路径,不走多轮 deep-review SKILL)。

## 方法

**双对抗配对**(`resources/claude-config/CLAUDE.md`「决策对抗」节):
- reviewer-claude:Opus 4.7,Bash oneshot 外部 CLI(`/Applications/Agent Deck.app/Contents/Resources/templates/reviewer-claude.sh.tmpl`),`--permission-mode default` + 只读 allowedTools + `--disallowedTools ExitPlanMode`
- reviewer-codex:Codex SDK gpt-5.5 xhigh,`codex exec --sandbox read-only --skip-git-repo-check`

**范围**:2 文件 / 103 行 diff

```text
src/renderer/components/session-list-tree.ts            (Phase 1 严格化条件 + jsdoc 加段)
src/renderer/components/__tests__/session-list-tree.test.ts  (加 corner 6/7/8 测试)
```

```review-scope
src/renderer/components/__tests__/session-list-tree.test.ts
src/renderer/components/session-list-tree.ts
```

**约束**:focus 修法正确性 / corner 不破坏既有 5 corner / HIGH-A 安全性保留 / 测试完备性 / 注释一致性。

## 三态裁决结果

### ✅ 真问题

| # | 严重度 | 文件:行号 | 问题 | claude | codex | 验证手段 |
|---|---|---|---|---|---|---|
| 1 | **HIGH** | `session-list-tree.ts:89-96` | v1 修法 `ownerLeadsSomeTeamOfS` 对 mixed child 仍有 **HIGH-A escape**:child 同时是 stale owner 某 team 的 lead + 别 team 的 teammate 时(A.teams=[T2 lead], D.teams=[T1 lead], B.teams=[T1 teammate, T2 lead], B.spawnedBy=A),strict check `T2 重合` 让 B 锁回 stale A,Phase 2 不再 reparent T1 teammate 侧到 D | — | ✅ | (1) codex 推 + 我现场实证:`member-crud.ts:136-143` 同 team 允许 ≤10 lead(`MAX_LEADS_PER_TEAM=10`)→ B 自己 spawn(team=T2) 可成 T2 第 2 个 lead;(2) `swapLead` L84-89 签名只动 `oldLeadSid + newLeadSid`,third-party teammate role 在 swap 中不变(也清掉 claude UNVERIFIED-1);(3) 反例 mental run 确认 v1 修法锁错 → v2 改 `ownerLeadsSomeTeammateTeamOfS`(只看 child 的 teammate teams)→ corner 8 新测验证 v2 reparent 正确 |
| 2 | LOW | `session-list-tree.test.ts:9-13` | 测试文件顶部 jsdoc 仍写 "5 corner",实际新增到 7 / 8 corner,文档计数漂移 | ✅ | ✅ | 双方独立提出,直接 grep `it.*corner` 命中 corner 1-8 |
| 3 | LOW | `session-list-tree.ts:52-59` | jsdoc 新加段缺 plan / review ref,与同段其他 `(plan §D2)` / `(R2 codex MED-1)` 风格不一致;且「HIGH-A 严格化」原 plan 讲的是「严格化的本意」与本次「严格化的 regression」语义同名混用 | ✅ | — | grep `ref/plans/session-list-handoff-role-badge-20260526.md` 无「3-layer」字样,plan v4 已 `completed_at: 2026-05-26`,本修法属 plan-after patch;修法:章节标题改 `lead-only regression + mixed-child escape 修法` + 加 `(REVIEW_65)` anchor |
| 4 | INFO | `session-list-tree.test.ts:191` | corner 6 `expect(result.roots).toEqual([L1])` 直接 array toEqual,与 corner 2/5/7 用 `.map(s=>s.id).sort()` 风格不一致 | ✅ | — | grep `result.roots\.map.*sort` 命中 corner 2/5/7;corner 6 改成 sort 风格统一 |
| 5 | INFO | `session-list-tree.test.ts:200,213` | corner 7 `T4Lead` 是 root 的原因 reader 得反推(无 spawnedBy + Phase 2 不收 lead role) | ✅ | — | grep + 加注释「T4Lead 是 root 因(a)无 spawnedBy → Phase 1 跳过 + (b)Phase 2 不收 lead role」 |

### ❌ 反驳

无。

### ❓ 部分 / 未验证

| 现场 | claude 视角 | codex 视角 | 验证 | 结论 |
|---|---|---|---|---|
| UNVERIFIED-1: 「lead-only child + stale spawn caller」反向反例是否可达 | claude 推「swap_lead 只动 caller+newSid 两 sid,third-party teammate role 不变 → 反向反例不可达」自标 *未验证* | — | lead 现场 grep `swapLead` 实证 `member-crud.ts:84-89` 签名只 `oldLeadSid + newLeadSid` 两参 + `member-crud.ts:252` impl 内三 case 都仅 touch 这两 sid → ✅ 验证成立 → 反向反例不可达 | INFO,无修 |

## 修复(diff 直接合,无配套 CHANGELOG_X)

### HIGH

1. **`session-list-tree.ts:89-96`** — Phase 1 严格化 `ownerLeadsSomeTeamOfS` → `ownerLeadsSomeTeammateTeamOfS`,匹配只看 child 的 `teammate` teams(child 自己当 lead 的 team 与 owner 重合不算「合法 spawn-link 父」);新增 corner 8 测试覆盖 mixed-child HIGH-A escape 反例。

### LOW

2. **`session-list-tree.test.ts:1-15`** — 顶部 jsdoc "5 corner" 改 "8 corner" + 补 corner 6/7/8 简介(REVIEW_65 anchor)。
3. **`session-list-tree.ts:52-66`** — jsdoc 章节标题改 `HIGH-A 严格化的 lead-only regression + mixed-child escape 修法 (REVIEW_65)` + 双 regression 各自一段(a)+(b),含 `(REVIEW_65 codex HIGH)` anchor。

### INFO

4. **`session-list-tree.test.ts:191`** — corner 6 roots assert 改 `.map(s=>s.id).sort()` 风格统一。
5. **`session-list-tree.test.ts:200,213`** — corner 7 注释补「T4Lead 是 root 因(a)无 spawnedBy → Phase 1 跳过 + (b)Phase 2 不收 lead role」。

## 关联 changelog

无(本次属 bug 修复 + 行为收窄,不引功能变更;按 CLAUDE.md §改动后必做,bug review 走 `ref/reviews/` 而非 `ref/changelogs/`)。

## Agent 踩坑沉淀

候选(走 `ref/conventions/tally.md` `# Agent 踩坑候选` section):

- **「树形分组算法 over-strict 把合法节点踢成 root」候选**:HIGH-A 类严格化(为治反例)容易 over-strict 把另一类合法 case 也踢飞;两类反例形态不同时(本案 a = lead-only mid-tier,b = mixed-child HIGH-A escape),strict 条件得**分别对症**(本案 `sHasTeammateRole` guard + `ownerLeadsSomeTeammateTeamOfS`),不能一刀切。下次再撞类似 case 走 tally count+1。
