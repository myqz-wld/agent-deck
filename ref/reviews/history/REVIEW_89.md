# REVIEW_89 — 全项目 deep review 批 G2：team-repo 持久层 + Follow-up #9 收口

- 日期: 2026-06-01
- 类型: Debug / 功能 BUG + 测试质量修复 + 代码优化（全项目 deep review 第十九批，Batch G 子批 G2）
- 触发: 用户「deep review 下项目，自主一路推进 + 自主 hand off」授权（plan deep-review-project-20260531）；含 Follow-up #9（team-repo.test 3 pre-existing 失败排查）
- 关联: plan deep-review-project-20260531 / REVIEW_83/84（Follow-up #9 记录 / event-formatter same-ms 先例）/ REVIEW_56（swapLead displayName clobber 防御）/ REVIEW_32（findSharedActiveTeams HIGH-2 / archive_reason MED-7）
- 方法: 多轮异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5，复用 F+G pair dr-project-f-20260531）+ 三态裁决 + lead 现场 sqlite3 模拟 + **SQLite binding rebuild 真测**（全 28 test + 2 fix temp-revert 非空）+ Electron binding 还原。
- 收口: R1 单轮 **强收敛**（双方 0 HIGH/0 MED，Follow-up #9 三失败诊断完全一致）。双方独立 2 条（list rowid tie-breaker / 三 test bug 诊断）；reviewer-claude 额外 1 LOW（rejoin displayName clobber）+ 2 INFO + **2 处关键 refine**（#1 restructure 防破坏覆盖 / #2 必须 rowid 非 id）。

## 范围（批 G2）

team-repo 持久层 5 源文件 ~1050 LOC + 1 test 文件（agent_deck_teams + agent_deck_team_members 两表）：

| 文件 | LOC | 职责 |
|---|---|---|
| `member-crud.ts` | 360 | addMember（rejoin / lead 上限 10）/leaveTeam/setRole/swapLead（atomic lead 转移）|
| `team-crud.ts` | 211 | create/ensureByName（active name 部分 unique）/get/list/archive/unarchive/hardDelete |
| `member-query.ts` | 189 | findActiveMembershipIn/findSharedActiveTeams/countActiveLeads/findActiveMembershipsBySessionIds |
| `index.ts` | 148 | facade |
| `types.ts` | 142 | teamRowToRecord/memberRowToRecord + metadata JSON 容错 |
| `__tests__/agent-deck-team-repo.test.ts` | — | Follow-up #9 三失败修复 |

## Follow-up #9 三失败诊断（双方独立确认 = test bug，源码正确）

ABI binding skip 长期未执行 → 3 个 assertion/setup bug 从未暴露。lead SQLite 真测 root-cause + 双 reviewer 独立确认：

### [#1 LOW ✅ 双方独立 + reviewer-claude restructure refine] findSharedActiveTeams test assertion 与 setup 自相矛盾

setup 把 sA(L216) + sC(L218) 都加进 t2 → sA∩sC = {t2} 非空，但 L223 断言 `[]`（与 L213 注释「sA + sC 共享无」矛盾）。代码返 `[t2.id]` **正确**，测试 assertion 错。

**reviewer-claude 关键 refine**：lead/codex 的两个 naive 修法（改 L223 为 `[t2.id]` / 挪 sC）**都破坏覆盖**——L216/217/218 三场景在原 setup 下数学互斥（L216 要 sA∈t2，L217 要 sC∈t2，L218 要 sA∩sC=∅ → 矛盾）。**采纳 claude restructure**：t1={sA,sB} / t2={sA,sB} / t3={sB,sC} → sA∩sB={t1,t2}（L221）/ sB∩sC={t3}（L222 改 [t3.id]）/ sA∩sC={}（L223 真空覆盖保全）/ leaveTeam(t1,sB) 后 sA∩sB={t2}（L230）。保全「双 session 无共享 team 返空」独立覆盖。lead 验证 restructure 集合数学 airtight。

### [#2 LOW ✅ 双方独立 code-fix + reviewer-claude rowid 陷阱] list ORDER BY created_at DESC 同毫秒无 tie-breaker

create 用 `Date.now()` 写 created_at，背靠背创建多 team 落同一毫秒 → 仅 `ORDER BY created_at DESC` 无 total order，分页/UI/test 跨查询非确定（test `[c,b,a]` 失败根因）。**双方独立判 code-fix**（生产也非确定，不只 test 问题，匹配 REVIEW_84 event-formatter 先例）。

**reviewer-claude 关键陷阱**：tie-breaker **必须 `rowid` 不能 `id`**——team.id 是 `crypto.randomUUID()` 随机值，`ORDER BY created_at DESC, id DESC` 的 id 随机 → tie 内仍乱序；`rowid` 随插入单调（agent_deck_teams 普通 rowid 表非 WITHOUT ROWID，v010 schema `id TEXT PRIMARY KEY` 保留隐式 rowid）→ `rowid DESC` 保「同毫秒后插入在前」语义 + 确定序。lead 验 v010 schema 无 WITHOUT ROWID + id=randomUUID 确认陷阱真实。

**修法**：`ORDER BY created_at DESC, rowid DESC`。SQLite 真测 `[c,b,a]` 通过（temp-revert 去 rowid → FAIL）。

### [#3 LOW ✅ 双方独立 root-cause] partial unique test 创建第 3 个 active 同名

test L56 `t2 = create('review-X')` 是 active（从未 archive），L61 `t3 = create('review-X')` 时 t2 仍 active → partial unique `WHERE archived_at IS NULL` 已有 active 'review-X' → INSERT 第二个 active 同名 → SQLITE_CONSTRAINT → create catch throw TeamInvariantError → L61 未包 expect-throw → test 挂。源码 partial unique **正确**，测试漏腾空 active 槽位。

**修法**：L61 前补 `repo.archive(t2.id)`（与 L55 archive t1 同款），让 t3 create 时无 active 同名。

## 源码本体 finding

### [LOW ✅ reviewer-claude 单方 + lead 验证] member-crud.ts:124 — addMember rejoin 无条件 SET display_name clobber 旧别名

rejoin 路径 `SET display_name = ?`，displayName 默认 `input.displayName ?? null`（L99）。曾叫 "reviewer-claude" 的 member 离队后被 rejoin 且 caller 没传 displayName → display_name 被覆盖为 NULL 丢别名（典型 spawn.ts 裸 re-spawn 无 displayName/agentName rejoin）。与 swapLead case 2/4 REVIEW_56 修法不对称（那里 newDisplayName===null 不动 display_name 列）。

**lead 验证（Read）**：member-crud.ts:99 `displayName ?? null` + :124-128 无条件 SET vs swapLead L312-341 REVIEW_56 防御。可达但窄。

**修法**：`SET display_name = COALESCE(?, display_name)`——caller 显式传非 null 才覆盖，否则保留旧别名（与 swapLead 对齐）。+1 SQLite 真测（rejoin 不传保留 'reviewer-claude' / 显式传 'renamed' 覆盖；temp-revert 去 COALESCE → FAIL）。

### [INFO ✅ reviewer-claude] team-crud.ts:23 — create() jsdoc 误描述 ON CONFLICT DO NOTHING + spawn_session 并发

create() interface jsdoc 写它用 「INSERT ON CONFLICT DO NOTHING + 同步 SELECT」服务 spawn_session ensure-by-name。实际 create() 是 plain INSERT + catch UNIQUE → **throw**（不 DO NOTHING），且 spawn_session 走 ensureByName 不是 create。jsdoc 像从 ensureByName 复制。**修法**：create jsdoc 改「active 同名 → throw TeamInvariantError」。

### [INFO ✅ reviewer-claude] team-crud.ts:167 — archive() if(changes===0)/else 双分支 return 相同冗余

changes===0（已 archived/不存在）与 changes>0 两分支都 `return get(teamId)`，if 无行为差异。WHERE archived_at IS NULL 保证「已 archived 不覆盖 reason」语义。**修法**：删 if/else 单 `return get(teamId)`（语义不变）。

### [INFO] 双方已核实无问题项（裁决参考）

reviewer-claude 穷举：findSharedActiveTeams SQL（双 JOIN a/b + team/sessions archived 过滤 + PK 保证无 dedup 问题）/ swapLead 4-case atomic（F3 已审）/ countActiveLeads·listActiveMembers INNER JOIN sessions.archived_at ghost 过滤一致 / ensureByName getByActiveName 先查 + INSERT catch re-SELECT 竞争兜底 / partial unique + unarchive 同名占位 throw（test L89-94 该用例正确）/ teamRowToRecord metadata JSON 容错 / hardDelete CASCADE / chunk 500 边界。reviewer-codex：member-query raw active membership helper 不统一过滤 archived team/session 但关键 caller（task/adopt/send）已 call site 二次过滤，不列生产 finding。

## 修复清单

| # | 文件:行 | 严重度 | 修法 | 验证 |
|---|---|---|---|---|
| 1 | test findSharedActiveTeams | LOW ✅ | restructure t3={sB,sC} 保全三场景覆盖 | 双方独立 + claude refine + lead 集合数学 + SQLite 真测 |
| 2 | team-crud.ts:147 | LOW ✅ | ORDER BY created_at DESC, **rowid** DESC | 双方独立 code-fix + claude rowid 陷阱 + SQLite 真测 temp-revert FAIL |
| 3 | test partial unique | LOW ✅ | L61 前补 archive(t2) | 双方独立 root-cause + SQLite 真测 |
| 4 | member-crud.ts:126 | LOW ✅ | display_name COALESCE 防 clobber | claude 单方 + lead Read + SQLite 真测 temp-revert FAIL |
| 5 | team-crud.ts:23 jsdoc | INFO ✅ | create jsdoc 改 throw 语义 | claude，doc-only |
| 6 | team-crud.ts:167 | INFO ✅ | archive 删冗余 if/else | claude，simplify |

## 验证

```
typecheck（双配置 tsconfig.node + tsconfig.web）：PASS
SQLite binding rebuild（Node 20.18.3 prebuild-install）→ 真测 → 还原 Electron ABI130 binding：
  - agent-deck-team-repo.test.ts：28 passed（修前 3 failed + 23 passed → 修后全过 + 2 新增）
  - temp-revert：去 rowid → list test FAIL；去 COALESCE → displayName test FAIL
  - Electron binding 已还原（size 1885024 == backup）
新增回归 test：rejoin displayName COALESCE 1（list rowid 由既有 [c,b,a] test 覆盖）
```

## 结论

**Batch G2 + Follow-up #9 收口**。team-repo 是经 REVIEW_32/35/56 多轮沉淀的成熟持久层，0 HIGH/0 MED 源 bug。本轮核心交付：**Follow-up #9 三 pre-existing test 失败全部 root-cause 为 test bug（源码正确）+ 修复**——这些 bug 因 ABI binding skip 长期未执行而隐藏，本批用 SQLite binding rebuild 真测暴露 + 修复 + temp-revert 验证。另挖 1 源码 LOW（rejoin displayName clobber）+ 2 INFO。

**异构对抗价值（强收敛 + claude 双 refine）**：双方对 Follow-up #9 三失败诊断完全一致（test bug），但 reviewer-claude 两处关键 refine 提升修法质量：① **#1 restructure** ——lead 和 codex 的 naive 修法（改断言/挪 sC）都会破坏其他覆盖（三场景单 setup 数学互斥），claude restructure t3={sB,sC} 保全全部覆盖；② **#2 rowid 陷阱**——codex 给 `rowid DESC` 正确但 claude 显式点出「不能用 id（randomUUID 随机）」这个易踩陷阱（若误用 id 修了等于没修）。这是异构对抗里「方向一致但 claude 抓住实现细节陷阱」的价值——防止一个看似正确的修法因实现细节失效。

**SQLite 真测复用 G1 流程**：G1 建立的 binding rebuild → 真测 → 还原闭环在 G2 直接复用，3 失败修复 + 2 新 fix 全部真 DB 验证（非纯逻辑推演），Follow-up #9 彻底闭环。

## Follow-up（留用户 / 后续批次）

1. **[已解决] Follow-up #9 team-repo 3 test 失败** —— 本批全部修复（test bug，源码正确）。
2. **[INFO 跨批] member-query raw active membership helper 不统一过滤 archived**（reviewer-codex）——findActiveMembershipsBySession 等 raw helper 不过滤 archived team/session，但关键 caller（task/adopt/send）已 call site 二次过滤；当前无 bug，未来若有新 caller 直接用 raw helper 需注意。非本批 action。
