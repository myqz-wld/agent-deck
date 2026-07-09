# REVIEW_88 — 全项目 deep review 批 G1：session-repo 持久层（Batch G 开篇）

- 日期: 2026-06-01
- 类型: Debug / 功能 BUG + 代码优化 + 文字措辞（全项目 deep review 第十八批，Batch G 子批 G1）
- 触发: 用户「deep review 下项目，自主一路推进 + 自主 hand off」授权（plan deep-review-project-20260531）
- 关联: plan deep-review-project-20260531 / REVIEW_83（E1 rename tasks/issues 迁移）/ REVIEW_56（rename spawn_depth 无条件覆盖）/ REVIEW_61（task-repo LIKE escape）/ REVIEW_84（event-formatter same-ms ordering，同类）
- 方法: 多轮异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5，复用 F pair dr-project-f-20260531）+ **反驳轮**（cli_session_id MED）+ 三态裁决 + lead 现场 Grep/Read/sqlite3 模拟验证 + **SQLite binding rebuild 真测**（spawn_depth MED 回归 test temp-revert 非空）+ Electron binding 还原。
- 收口: R1 单轮 **异构 divergence**（双方各 1 MED，都在 rename.ts 但不同点）+ 1 反驳轮。codex MED（spawn_depth 不对称）→ lead 真测确认 ✅；claude MED（cli_session_id UNIQUE）→ 反驳轮 codex 降 LOW/INFO（不可达 + 修法有害）→ INFO 记录。

## 范围（批 G1）

session-repo 持久层 7 文件 ~1077 LOC（sessions 表 better-sqlite3 同步 API）：

| 文件 | LOC | 职责 |
|---|---|---|
| `core-crud.ts` | 332 | upsert/get/listActiveAndDormant/listHistory/_delete + 9 setter（21 列 per-session resilience）|
| `rename.ts` | 294 | 跨表事务迁移（10 表 + toExists 双分支字段覆盖）—— SDK fork / tempKey→realId |
| `lifecycle.ts` | 131 | setLifecycle/batchSetLifecycle/findHistoryOlderThan/batchDelete（scheduler 消费）|
| `types.ts` | 105 | Row + rowToRecord + parseExtraAllowWriteJson |
| `spawn-chain.ts` | 106→74 | getSpawnDepth/setSpawnLink/listChildren（listAncestors 本批删 dead code）|
| `archive.ts` | 63 | setArchived + SessionRowMissingError TOCTOU |
| `index.ts` | 46 | facade |

## 三态裁决结果

### [MED ✅ reviewer-codex 单方 + lead SQLite 真测] rename.ts:221 — toExists=true 分支 spawned_by/spawn_depth 覆盖规则不一致致脏 spawn-chain

reviewer-codex 单方（reviewer-claude 未覆盖此点）。toExists=true 分支 `spawned_by` 用 truthy guard（`if (toExists && fromRow.spawned_by)` — OLD null 跳过保留 NEW 旧值）但 `spawn_depth` 无条件覆盖（REVIEW_56 修法）→ 二者规则不一致。OLD 是 root（spawned_by=NULL, spawn_depth=0）+ NEW 预存为 child（spawned_by='parent', spawn_depth=1）时，rename 后变 `spawned_by='parent', spawn_depth=0` 脏 spawn-chain——`listChildren(parent,'all')` 算它是 child 但带 root depth，fan-out/depth 展示/清理读到不一致身份。

**lead 验证（node 模拟 + SQLite 真测）**：node 模拟确认 `{spawned_by:'parent', spawn_depth:0}` 不一致；SQLite binding rebuild 后真测 toExists=true 路径（OLD root → NEW child）→ 修前 `expected 'parent' to be null` 复现脏 spawn-chain。

**修法**：spawned_by 与 spawn_depth 同款**无条件**按 OLD 覆盖（单条 UPDATE，spawned_by 去 truthy guard）。二者都是「会话身份相关字段」，rename = OLD 整迁 NEW，spawn-chain 身份必须以 OLD 为准（OLD null 就该清掉 NEW 旧 parent 指针），与 toExists=false INSERT 分支同款。+1 SQLite 真测（temp-revert 非空 `expected 'parent' to be null`）。

### [INFO ✅ reviewer-claude 提 MED → 反驳轮 reviewer-codex 降级] rename.ts:114 — INSERT cli_session_id=toId 撞 UNIQUE 索引（构造性可达，正常流程不可达）

reviewer-claude 提 MED（请求反驳轮）：v021 给 cli_session_id 建 `CREATE UNIQUE INDEX`（允许多 NULL 非空必唯一），toExists=false INSERT hardcode `cli_session_id=toId`，若存量某 row.cli_session_id===toId → INSERT 撞 SQLITE_CONSTRAINT 回滚整个 rename。

**反驳轮（reviewer-codex 立场：反对 MED，同意构造性存在但可达性只够 LOW/INFO）**：
1. **正常流程不可达**——toId 是 SDK fresh spawn/fork 刚返回的 realId（CLI 生成 UUID），要撞需 CLI/SDK 返回一个已被别 row 持有为 cli_session_id 的 id（UUID 碰撞天文级不可能）；反向 rename updateCliSessionId 写的也是 SDK realId 同理。仅外部 DB 污染 / import 脏数据可构造。
2. **当前行为已安全**——INSERT 撞 UNIQUE → 事务回滚（无半残 / 无脏数据）。
3. **建议的修法有害**——「命中冲突清那行 cli_session_id」破坏另一 session 的 resume/jsonl 反查（把身份冲突转嫁成旧 session 失联）；「INSERT 写 NULL」需补 codex 新建路径（persistSessionFields 不写 cli_session_id）parity 回填否则扩大 NULL 窗口。

**lead 裁决**：✅ 真问题但 **INFO**（不可达 + 修法得不偿失）。**不改代码**，仅加注释文档化 UNIQUE-by-rollback 安全性 + 为何不修（防 future regression 误加有害"修复"）。lead 已验 v021:28 UNIQUE 索引 + :25 backfill 存在。

### [LOW ✅ reviewer-codex 单方 + lead sqlite3 模拟] core-crud.ts:137 — listHistory 信任 limit/offset，IPC 可传 limit=-1 全量查询

reviewer-codex 单方。`listHistory` 直接绑定 opts.limit/offset。preload facade 暴露 limit?/offset?，IPC handler（ipc/sessions.ts SessionListHistory）raw 类型断言直传无 clamp。caller 传 limit=-1 → SQLite `LIMIT -1` 返回全部匹配历史行绕过分页一次性加载全量 history 卡主线程。MCP list_sessions 已 clamp 1..200，缺口只在 IPC history。

**lead 验证（sqlite3 模拟）**：`LIMIT -1` 返回全 3/3 行确认。

**修法**：clamp `limit = min(max(trunc(rawLimit), 1), 500)` + `offset = max(trunc(rawOffset), 0)`。

### [LOW ✅ reviewer-claude 单方 + lead sqlite3 模拟] core-crud.ts:152 — listHistory cwd LIKE 未转义 `%`/`_` wildcard

reviewer-claude 单方。`cwd LIKE @cwd` + `params.cwd = '%${opts.cwd}%'` 未 escape `%`/`_`/`\`。用户历史面板按 cwd 过滤输入含 `_`（路径常见，如 `my_project`）→ `_` 当单字符通配符匹配 `myXproject` 等非预期路径。非注入（命名参数挡），是搜索语义错误，与 task-repo REVIEW_61 LOW-β 同款（F 批前序）。

**lead 验证（sqlite3 模拟）**：修前 `LIKE %my_project%` 同时匹配 `my_project` + `myXproject`（s1,s2）；修后 escape `_`→`\_` + `ESCAPE '\'` 仅匹配 s1。

**修法**：escape `%` `_` `\` + `cwd LIKE @cwd ESCAPE '\'`（复用 task-repo-list.ts:44-50 同款）。

### [LOW ✅ reviewer-claude 单方 + lead grep] spawn-chain.ts:51 — listAncestors dead code（0 生产调用点）

reviewer-claude 单方。listAncestors 自注释「2026-05 deprecated…当前生产代码无调用点」。lead grep 全仓确认仅自身定义 + 注释/jsdoc/test mock，**0 真实 caller**（32 行含 visited Set 自指向防御逻辑常驻）。

**修法**：删 listAncestors + 同步 index.ts jsdoc / rename.ts 注释 / 共享 test mock（spread facade 自动移除 surface）。删后 660 tests 全过（确认无 caller）。

### [INFO] 双方已核实无问题项（裁决参考）

reviewer-claude 穷举核实正确：rename 10 表迁移完整性（全 FK 列 + messages 双字段无遗漏，E1 tasks/issues 在 DELETE OLD 前迁避开 CASCADE/SET NULL）/ upsert 21 列 INSERT-UPDATE 双向同步（id/started_at 不在 UPDATE 正确）/ archive setArchived changes!==1 throw TOCTOU / batchSetLifecycle·batchDelete 事务原子性 / rowToRecord 字段映射 / parseExtraAllowWriteJson defense-in-depth / setSpawnLink changes=0 warn / cli_session_id toExists=true 保留 NEW 语义 / buildKeywordPredicate FTS escape 无注入。reviewer-codex 核实 cwd LIKE / keyword 用 bind param 无注入。team_members PK 防御性子查询 by-design（claude INFO，注释充分保留）。

## 修复清单

| # | 文件:行 | 严重度 | 修法 | 验证 |
|---|---|---|---|---|
| 1 | rename.ts:~221 | MED ✅ | spawned_by+spawn_depth 一起无条件覆盖（单 UPDATE）| codex 单方 + lead node 模拟 + SQLite 真测 temp-revert 非空 |
| 2 | core-crud.ts:~137 | LOW ✅ | clamp limit [1,500] + offset ≥0 | codex 单方 + lead sqlite3 模拟 |
| 3 | core-crud.ts:~152 | LOW ✅ | cwd LIKE escape `%_\` + ESCAPE | claude 单方 + lead sqlite3 模拟（修前匹配 s1,s2）|
| 4 | spawn-chain.ts | LOW ✅ | 删 listAncestors dead code + 3 处引用同步 | claude 单方 + lead grep 0 caller + 660 tests 过 |
| — | rename.ts:114 | INFO ✅ | cli_session_id UNIQUE 注释文档化（不改代码）| claude MED → 反驳轮 codex 降级 + lead 验 |

## 验证

```
typecheck（双配置 tsconfig.node + tsconfig.web）：PASS
SQLite binding rebuild（Node 20.18.3 prebuild-install）→ 真测 → 还原 Electron ABI130 binding：
  - spawn_depth MED 回归 test：PASS（temp-revert 非空 expected 'parent' to be null）
  - Electron binding 已还原（size 1885024 == backup，dev/app 不受影响）
node_modules/.bin/vitest run session/ + agent-deck-mcp/__tests__/（默认 node）：660 passed | 3 skipped（44 files，含删 listAncestors 后无回归）
listHistory cwd escape + limit clamp：sqlite3 :memory: 模拟验证（修前 %my_project% 匹配 s1,s2 / 修后仅 s1）
```

## 结论

**Batch G 开篇批**。session-repo 是经多轮 review（REVIEW_17/28/32/56/74/83 等）沉淀的成熟持久层，rename 跨表迁移完整性 + upsert 列集同步 + archive TOCTOU + 事务原子性全核实正确。本轮挖出 1 MED + 3 LOW + 1 INFO。

**异构对抗价值**：双方各抓 1 MED 都落在 rename.ts（最复杂文件）但不同点——reviewer-codex 抓 spawn_depth/spawned_by 覆盖不对称（数据一致性维度，REVIEW_56 修 spawn_depth 时遗留 spawned_by 未对齐）；reviewer-claude 抓 cli_session_id UNIQUE 撞车（约束完整性维度）。**反驳轮收敛 cli_session_id MED → INFO**：codex 不仅反驳 severity 还指出建议修法的反作用（清冲突行破坏别 session resume / NULL 修法需 codex parity），这是反驳轮防止「过度修复」的价值——一个构造性可达但正常不可达的问题，加防御代码反而引入新风险，文档化 + 保留事务回滚是更优解。LOW 互补：codex limit 边界 / claude cwd escape（同 REVIEW_61 task-repo 同款，跨 repo 一致性）+ listAncestors dead code 清理。

**SQLite 真测落地**：本批首次在 deep-review 流程内完成 binding rebuild → 真测 → 还原闭环（spawn_depth MED 用真 in-memory SQLite 验 toExists=true 路径），比纯逻辑推演更硬。

## Follow-up（留 G2 / 用户决策）

1. **[G2 排查完成 — 待修] team-repo.test 3 个 failures（Follow-up #9 根因已定位）**：SQLite binding rebuild 后实测 3 failures 全是**测试侧问题**（因 ABI skip 长期未执行未暴露）：① `findSharedActiveTeams('sA','sC')` 断言 `[]` 但 setup 把 sA(L211)+sC(L213) 都加进 t2 → 应断言 `[t2.id]`（测试 assertion 错，代码正确）② `list` DESC order `[c,b,a]` 因 `created_at` 同毫秒 tie（Date.now()）非确定 → 需 ORDER BY 加 id tie-breaker（同 REVIEW_84 event-formatter same-ms 修法）或测试用 distinct 时间戳 ③ unique 约束 test（待 G2 细查）。**留 Batch G2（team-repo scope）专项修**（含决策：list 同毫秒是 code 加 tie-breaker 还是 test 改）。
2. **[测试盲区] listHistory cwd escape + limit clamp 无 vitest test**：listHistory 用 getDb() 全局不可注入，无法走 in-memory 测试 harness（rename 走 renameWithDb test-seam 可测）。本批用 sqlite3 :memory: 模拟验证。建议未来给 core-crud 加 getDb 注入 seam 或 mock。
3. **[测试盲区] rename toExists=true 字段覆盖矩阵**（reviewer-claude）：toExists=true 9 字段条件覆盖（permission_mode/sandbox/model/extra_allow_write OLD 覆盖 + cli_session_id 保留）缺专门断言，本批补了 spawn_depth 一条，其余留 follow-up。
