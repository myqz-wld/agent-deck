# REVIEW_106 — task-repo 持久层（CRUD/delete/handoff/list/_deps）deep-review

> 全项目滚动 deep-review Batch 8。`agent-deck:deep-review` SKILL 多轮异构对抗。

## Scope

- **5 文件 ~828 LOC，Task Manager 持久层（better-sqlite3 同步 API，tasks 表，plan task-team-id-restore-20260525 v024）**：
  - `src/main/store/task-repo/task-repo-crud.ts`(118/4fn)：create（subject/ownerSessionId 存在性校验 + 默认值填充 + 单 INSERT）/ get（委托 _deps.getById）/ update（增量 UPDATE，UPDATABLE_KEYS 白名单 + undefined=不动/null=清空 + ownerSessionId 主动忽略）。
  - `src/main/store/task-repo/task-repo-delete.ts`(134/9fn)：delete（cascade BFS predicate 越权挡 + 单 db.transaction chunked DELETE 500 + cleanupBlocksReferences）+ cleanupBlocksReferences export（handoff 共享）。
  - `src/main/store/task-repo/task-repo-handoff.ts`(141/8fn)：reassignOwner（clear-team/preserve-team 单 SQL）+ applyHandOffSkipPolicy（单 tx 4 步原子：SELECT snapshot → chunked DELETE → cleanup blocks → reassign personal）+ findOwnedDistinctTeamIds（preserve-team safety）。
  - `src/main/store/task-repo/task-repo-list.ts`(116/4fn)：list 三态分流（visibleScope OR / ownerSessionIds+teamIdFilter / 全部）+ subject LIKE escape + IN 500 上限防御 + LIMIT/OFFSET 分页。
  - `src/main/store/task-repo/_deps.ts`(319/7fn)：共享 types/helpers SSOT（Row + TaskRepo interface 契约 + UPDATABLE_KEYS/COL_MAP + safeJsonArray/rowToRecord/toColumnValue/getById）。作上下文复审契约。
- **选批方法学（复用 Batch 4-7，fp:NONE 金标准 + 函数密度 + scope vs trace spot-check）**：
  - **持久层批 vs handler 批要分清**——REVIEW_87 审 task **handler** 层（task-list.ts/task-delete.ts handler），repo 子文件（task-repo-*.ts）只是 trace 佐证非 scope；session-repo(R88)/team-repo(R89)/message-repo(R90)/杂项 store(R91) 各有持久层专批，**独缺 task-repo 持久层专批** → 本批补。Phase 4 Step 4.5 拆分(8d3589a)后子模块新路径未被持久层专批覆盖（同 Batch 3/5/6 facade 拆分盲区模式）。
  - **函数密度对 facade/thin-wrapper 层失真**（本会话新教训）：preload/api 层 grep "function|=>" 计数虚高但全是 `ipcRenderer.invoke` 零逻辑转发，与纯 type 同类 ROI 极低 → 排除。task-repo 是真 logic-heavy（事务/级联/权限/排序/FK）。

## 轮次 / reviewer

- **R1+R2 双轮异构对抗**，reviewer-claude(Opus4.7) `2707b6ee` + reviewer-codex(gpt-5.5) `019e8762`，teamId `425271f6`（已 shutdown）。
- **commits**：本 commit（R1 3 fix + 2 回归测试 + R2 2 注释订正 + 本 REVIEW，一次性收口）。
- **lead 现场验证**（不 rubber-stamp）：
  - 预备分析独立命中 same-ms tie-breaker + sqlite3 :memory: 复现（5 行同 updated_at 当前返 rowid-ASC 违 newest-first）。
  - 核 migrations 确认 tasks 是 `id TEXT PRIMARY KEY` **非 WITHOUT ROWID** → rowid 可靠可用 tie-breaker；v023 建了 `idx_tasks_updated_at(updated_at DESC)` 索引（加重 same-ms 不确定性）。
  - sqlite3 3.43 验证 Fix1 全量 r5..r1 newest-first + 分页 page1[r5,r4]/page2[r3,r2]/page3[r1] 无重漏 + EXPLAIN QUERY PLAN。
  - 现场核实 codex LOW：读 task-list.ts handler 确认默认路径总传 visibleScope，>500 旧实现连 personal 都丢。
  - sqlite3 实证 claude LOW：`LOWER('Ärger')`='Ärger'（SQLite 内置 LOWER ASCII-only）vs JS `'Ärger'.toLowerCase()`='ärger'。
  - **独立验证 R2 性能取舍**：`CREATE INDEX ...(updated_at, rowid)` 报 `no such column: rowid`（复合索引方案不可行，三方一致）；EXPLAIN 实证 `rowid ASC` 走索引免 TEMP B-TREE vs `rowid DESC`（当前 fix）退化 `USE TEMP B-TREE FOR RIGHT PART`——验证 claude 增量断言成立。

## 异构对抗高光

- **MED-1 三重独立命中**：reviewer-claude（MED，真 SQLite 3.43 + EXPLAIN + 分页 repro）+ reviewer-codex（MED，sqlite3 :memory:）+ **lead 预备独立分析**（sqlite3 复现）同时命中 `list` same-ms `updated_at` 无 tie-breaker——异构对抗强冗余即算验证的教科书 case。**复发主题第 5 次**（REVIEW_84/89/90/91 同款 rowid tie-breaker 修法），task-repo 是漏网的最后一个 list repo。
- **R1 reviewer-codex 独特贡献**：`visibleScope.teamIds>500` 分支 `return []` 丢 caller personal task（LOW）——lead 预备分析没抓到，codex 静态 trace handler 默认走 visibleScope 命中，破坏可见性契约而非纯性能降级。
- **R1 reviewer-claude 独特贡献**：subject 搜索 SQLite `LOWER()` ASCII-only vs JS `toLowerCase()` Unicode 不一致（LOW）——非 ASCII subject case-insensitive 搜索失效，真 SQLite 实证。
- **R2 三方一致命中复合索引死路**：reviewer-claude + reviewer-codex + lead 独立实测 `CREATE INDEX ...(updated_at, rowid)` 建不出来（SQLite 拒绝具名 rowid 列）。**claude 增量更深一层**：现有 `idx_tasks_updated_at` 隐含尾随 `rowid ASC` → `rowid ASC` 可免 TEMP B-TREE 走索引直出，`rowid DESC`（当前 fix）方向相反退化临时排序——lead EXPLAIN 实证成立，定调维持 `rowid DESC`（语义自洽优先）+ 注释记取舍。

## Findings 三态裁决

### [MED-1 ✅ 真问题] task-repo-list.ts:110 — list `ORDER BY updated_at DESC` 缺 same-ms tie-breaker（复发主题第 5 次）

**lead 预备 + reviewer-claude + reviewer-codex 三重独立命中 + 各自 sqlite3 实证。** `updated_at` 用 `new Date().toISOString()` 写（crud.ts:47/109，ms 精度），plan workflow 批量 create/update task 极易撞同毫秒。仅 `ORDER BY updated_at DESC LIMIT ? OFFSET ?` 对同毫秒簇无 total order。

**根因 + 实证**：
- 真 SQLite 3.43 实测：5 行同 updated_at，BUGGY 返回 rowid-ASC（最旧在前）**恰与 jsdoc「newest-first」语义相反**。
- 跨 SQLite 版本 / 索引可用性可变（v023 建了 `idx_tasks_updated_at(updated_at DESC)` 索引，same-ms 簇内 rowid 序由 B-tree 物理布局定，更不可预测）；带 LIMIT/OFFSET 分页时同毫秒边界行可能跨页**漏/重**。
- `EXPLAIN QUERY PLAN`：无 status filter 走 `SCAN USING INDEX idx_tasks_updated_at`；有 status filter 走 `SEARCH idx_tasks_status + USE TEMP B-TREE FOR ORDER BY`——两条 plan same-ms 序都不保证。

**修法（本 commit）**：`ORDER BY updated_at DESC` → `ORDER BY updated_at DESC, rowid DESC`。
- **必须 rowid 不能 id**：`tasks.id` 是 `crypto.randomUUID()` 随机值无插入序单调性，`id DESC` tie 内仍乱序（REVIEW_90 关键陷阱原文）；tasks 是 `id TEXT PRIMARY KEY` 非 WITHOUT ROWID 表 → 有隐式单调 rowid 可用（lead 核 migrations 确认）。
- +回归测试（task-repo.test.ts）：raw SQL 固定 5 行同 updated_at（绕过 create 无法保证同 ms）+ 断言全量 newest-first（r5..r1）+ 三页分页无重漏。

### [LOW ✅ 真问题] task-repo-list.ts:60 — `visibleScope.teamIds.length > 500` 分支 `return []` 丢失 caller personal task

**reviewer-codex 单方 + lead 现场核实。** visibleScope 契约（_deps.ts:144-153）= 「caller 可见 team task ∪ caller 自己 personal task」。`teamIds=[]` 分支正确退化为 personal-only，但 `teamIds.length > 500` 分支直接 `return []`，连 caller 自己的 personal task 也一并丢失——破坏可见性契约（不只是性能降级）。

**验证**：lead 读 task-list.ts handler 确认默认路径（`teamIdFilter === undefined`）总传 `visibleScope`；sqlite3 实证退化分支 WHERE `(team_id IS NULL AND owner_session_id=caller)` 仅返 caller personal。触发条件 = caller 同时在 >500 active team（极端病态）故 LOW。

**修法（本 commit）**：>500 分支不再 `return []`，改退化为 personal-only `wheres.push('(team_id IS NULL AND owner_session_id = ?)')` + `params.push(callerSid)`（与 `teamIds.length === 0` 分支字节一致，reviewer-claude R2 验证 SQL/params 对齐无误）。放弃 team-bound task 命中（caller 应清理历史 dormant teams / handler 拆批），但 personal task 仍可见，契约最小保真。+回归测试（501 teamIds 断言仍返 caller personal）。

### [LOW ✅ 真问题] task-repo-list.ts:44 — subject 搜索 SQLite `LOWER()` ASCII-only vs JS `toLowerCase()` Unicode 不一致

**reviewer-claude 单方 + lead sqlite3 3.43 实证。** param 侧 `opts.subjectKeyword.toLowerCase()` 是 JS Unicode-aware 折叠（'Ä'→'ä'）；列侧 `LOWER(subject)` 是 SQLite 内置 ASCII-only LOWER（'Ä' 不变）→ 非 ASCII subject 的大写字符永不匹配（param 已折叠成小写，列侧未折叠）。与 REVIEW_61 引入的 `%/_/\` wildcard escape 是独立维度（repo 层首审故列出）。

**验证**：真 SQLite `LOWER('Ärger')`='Ärger'、`LOWER('CAFÉ')`='cafÉ'（C-A-F 折叠，É/Ä 保留）；`subject='Ärger'` + param `%är%` → 查询返空。

**修法（本 commit）**：best-effort 搜索 gap（不影响数据正确性），按 claude 建议补 jsdoc 注明「大小写不敏感仅对 ASCII A-Z 生效」，不上 ICU extension（重依赖）。

### [INFO ✅ 文档化] task-repo-list.ts:12 顶部 jsdoc 注释漂移（R2 reviewer-codex）

R1 fix 后 >500 分支已改 personal-only，但顶部 jsdoc「任一 IN 子句长度 > 500 → 短路返 0 行」未同步——**「fix 后清 stale 注释」教训第 N 次复现**（Batch 5/6/7 反复踩）。本 commit 订正：区分 `visibleScope.teamIds>500`（退化 personal-only）vs `ownerSessionIds>500`（仍返空，admin 语义）两分支 + 补 ASCII-only 搜索说明。

### [INFO ✅ 文档化] task-repo-list.ts ORDER BY 注释补 rowid DESC vs ASC 取舍（R2 reviewer-claude）

复合索引 `(updated_at, rowid)` 建不出来（SQLite 拒绝具名 rowid 列）。现有 `idx_tasks_updated_at` 隐含尾随 `rowid ASC` → `rowid ASC` 可免 TEMP B-TREE 走索引直出但同毫秒簇 oldest-first；`rowid DESC`（当前选择）退化 `USE TEMP B-TREE FOR RIGHT PART` 但同毫秒簇 newest-first 与 jsdoc 自洽（对齐 REVIEW_90 messages 先例）。TEMP B-TREE 仅打裸 list() admin 路径（带 status/visibleScope 真实 handler 查询本就走 temp），task 表规模小可忽略 → 语义一致性优先选 `rowid DESC`。本 commit 补注释记取舍（未来表增大且裸 list 成热点可改 ASC）。

### R1 三 INFO 维持原级（reviewer-claude，不升级，可接受）

1. **delete 全表扫 O(N)**（task-repo-delete.ts:45）：即便单条非 cascade delete 也 `SELECT id,blocks,blocked_by FROM tasks` 全表 + 逐行 JSON 重解析。当前规模（数十~数百 task）可忽略，表增大才显。`changedBlocks` 用 length 比较正确（filter 只减不增，长度变即内容变）。
2. **toColumnValue teamId 空串不归一 NULL**（_deps.ts:318）：`value ?? null` nullish，`teamId=''` 非 nullish 原样写入。handler zod `z.union([uuid, null])` 挡住，契约成立。`priority=0` 经 `0 ?? null=0` 正确保留（未误用 `||`）。
3. **`total` 命名易误导**（task-list.ts:83）：`total: tasks.length` 实为本页返回数非匹配总数。schema/F4/工具 description 三处已声明契约一致。

### [INFO ✅ 可辩护不改] >500 两分支行为不对称（R2 reviewer-claude 复查注意到）

`visibleScope.teamIds>500` 退化 personal-only（保可见性契约）vs `ownerSessionIds>500` 仍 `return []`（丢全部）。**可辩护**：ownerSessionIds 是「显式指定 owner 过滤」admin 语义，handler 实际只在 null-personal 分支传 `[callerSid]`（长度恒 1），>500 不可达 = 防御性死代码；visibleScope 是「我的可见 scope」语义，丢 personal 才违约。两者语义不同 → 不对称合理，仅记录备查。

## 正向确认（focus 维度逐项，双方 + lead 验证无问题）

- **事务原子性**：`applyHandOffSkipPolicy` 4 步全在单 `db.transaction()` 内，任一步 throw 整 tx ROLLBACK + re-throw → `return {...}` 不可达，caller（hand-off handler outer try/catch）拿不到「DB 已回滚但闭包仍中间值」脏返回 ✅；`del` cascade 两步（chunked DELETE + cleanup）同 tx ✅（reviewer-codex step4 FK fail rollback 测试覆盖）。
- **cascade BFS predicate 边界**：越权 child `continue` 真正不 `queue.push(...child.blocks)` 即不展开下游（task-repo-delete.ts:101-108）✅；handler 端 pre-walk 复用同款 predicate（REVIEW_87 LOW 已修）✅。
- **IN 子句边界**：chunked DELETE CHUNK=500 防 999 上限 ✅；list 三处 IN 均有 >500 短路 + `[]` 短路返 0 行（避 `IN ()` 语法错）✅。
- **list 三态分流 + rowid tie-breaker 交互**：visibleScope OR / ownerSessionIds IN / teamIdFilter 三路径 ORDER BY 统一在尾部，rowid DESC 与任何 WHERE 过滤正交（rowid 全表全序）✅（reviewer-codex sqlite3 三类 WHERE 组合验 + reviewer-claude 混合 5 行同毫秒三路径验）。
- **reassignOwner**：clear-team `SET owner, team_id=NULL` / preserve-team `SET owner` 不刷 updated_at（F5）语义正确 ✅。
- **crypto.randomUUID 全局可用性**：Electron 33 bundled Node 20.x → `globalThis.crypto.randomUUID` 全局就位（Node 19+），message/team/issue repo 同款用法旁证 ✅。
- **toColumnValue/safeJsonArray nullish**：blocks/blockedBy/labels `value ?? []` + safeJsonArray try/catch 退化 `[]` + `.every(typeof string)` 守门 ✅。

## 收口

**R2 双 reviewer 均明示 conclude + 可合，0 HIGH 0 真 MED**。R2 新增全是 INFO（codex 注释漂移已修 / claude 性能取舍已采纳补注释 / claude >500 不对称可辩护不改）。

- typecheck 双配置（tsconfig.node.json + tsconfig.web.json）双绿。
- `pnpm exec vitest run task-repo.test.ts`：binding-gated（ABI v130 vs v137）全 skip BY DESIGN，测试文件无语法/类型错正确 collect（含新增 2 回归测试）；reviewer-codex 侧 `pnpm test`（Electron-as-node ABI 匹配）67 tests passed。lead 用 sqlite3 CLI 验机制（不主动跑 SQLite 真测避 binding corruption，plan 关键踩坑纪律）。

## Follow-up（非阻塞，双方裁定可接受）

1. **delete cleanupBlocksReferences 全表扫 O(N)**：当前规模可忽略，表增大才需优化（如按 deletedIds 反查引用者的索引，但 blocks/blocked_by 是 JSON 字符串列无法直接索引）。
2. **list 裸 admin 路径 TEMP B-TREE**：未来 task 表显著增大且裸 `list()`（无 WHERE）成热点，可改 `rowid ASC` 复用 `idx_tasks_updated_at` 免临时排序（代价：同毫秒簇翻为 oldest-first，需评估是否可接受 newest-first 语义损失）。
3. **subject 非 ASCII case-insensitive 搜索**：如需全 Unicode 大小写不敏感需 LIKE 双侧一致 fold 或上 ICU extension（当前 ASCII-only best-effort 已注释说明）。
