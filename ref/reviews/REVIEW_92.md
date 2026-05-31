# REVIEW_92 — 全项目 deep review 批 G5：settings-store（Batch G / store 子系统收官）

- 日期: 2026-06-01
- 类型: Debug / 功能 BUG（一次性 migration re-fire 压制用户选择）+ 防御性硬化（token 格式校验）+ 文档漂移修复（全项目 deep review 第二十二批，Batch G 子批 G5，store 子系统收官）
- 触发: 用户「deep review 下项目，自主一路推进 + 自主 hand off」授权（plan deep-review-project-20260531）
- 关联: plan deep-review-project-20260531 / REVIEW_91（G4 杂项 store）/ REVIEW_70（issue-repo baseline，本批 descope）/ REVIEW_83-84（Batch E：issue-lifecycle-scheduler + issue-repo listForGc，本批 descope）/ deep-review-changelog146-20260524（settings-store F1 probe 修法 + F-R2-D 假设）/ plan remove-aider-generic-pty-adapters-20260520（value-uplift migration F2）/ plan task-mcp-merge-into-agent-deck-mcp-20260521（enableTaskManager smart migration）
- 方法: 多轮异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5，**复用 G4 dormant pair dr-project-g4-20260531**，同 caller 29a77672 直接 send_message 新 scope）+ 三态裁决 + lead 现场 `node` / UI range 实证 + conf@10.2.0 dist 源码核对。
- 收口: R1→R2 两轮。**异构互补盲点**：reviewer-claude 把 codex/lead 都低估为「测试盲区 LOW」的 value-migration 缺陷**升级为 MED 真功能 bug**（每次 boot re-fire 永久压制用户重选），codex 互补补 token 格式 + 版本/rethrow 注释。R2 双方独立确认「可合」+ 0 HIGH/MED 残留。

## 范围（批 G5）

store 子系统收官批。主审 settings-store.ts（195 LOC）；issue-repo.ts / issue-lifecycle-scheduler.ts 经评估 descope：

| 文件 | LOC | 处置 |
|---|---|---|
| settings-store.ts | 195 | **主审**：electron-store 封装 + REMOVED_KEYS 清理 + 4 一次性 migration + token 生成 |
| issue-repo.ts | 495 | **descope**：主体主分支 REVIEW_70（当天）刚审 + worktree 仅 +20 行（E2 listForGc LIMIT，REVIEW_84 已审）|
| issue-lifecycle-scheduler.ts | 117 | **descope**：Batch E REVIEW_83/84 已审 + worktree 仅 +4 行 |

## 收敛与裁决

### ✅ 单方提出 + lead 现场验证（must-fix，severity 经裁决升级）

**MED value-uplift migration 非真一次性，每次 boot re-fire 永久压制用户选择（settings-store.ts:113-120 原始）** — reviewer-claude MED（reviewer-codex 仅判 LOW 测试盲区 → claude 升级）
两个 value-migration（`mcpMaxFanOutPerParent` 5→10 / `mcpSpawnRatePerMinute` 10→20）判定基于**值**且迁移目标就是**同一 key**，无 sentinel/version gate。与 transparentWhenPinned/enableTaskManager 的 key-presence migration（迁移后 delete 旧 key 故天然一次性）本质不同。
- 数据流（关键场景 B）：用户重启后在 UI 主动选回 5（fanOut）或 10（rate）→ fs=5/10 → 下次启动 probe 读 fs=5/10 → migration **RE-FIRE** 静默压回 10/20 → 用户显式选择**永久无法跨重启存活**。
- 验证: lead 读 AgentDeckMcpSection.tsx:107-120 确认 `mcpMaxFanOutPerParent` min=1/max=20（含 5）+ `mcpSpawnRatePerMinute` min=1/max=60（含 10）→ 两值均合法用户可选 → 数据流真实可达。grep 确认无 schemaVersion/sentinel gate；persistedRaw 每次 ensure() 由独立 probe Store 重读 fs 不缓存。
- 注释冲突: 原 L105「一次性 migration」+ L110-112「罕见 false positive」把它描述成迁移窗口期一次性事件；实际是每次启动永久压制。
- 修法: loose 内部 sentinel `__valueUpliftMigrationDone`（不进 AppSettings/DEFAULT_SETTINGS/UI）gate 整个迁移块 —— 缺失才跑、跑完**无条件置位**（即便本次未触发任一迁移）。已迁移老用户（fs=10/20 无 sentinel）首次 no-op 后置位；停在 5/10 的用户最后被 uplift 一次后置位，此后 5/10 选择生效。配套 `getAll()` 剔除 `__` 前缀 loose key 防 sentinel 泄漏到 IPC/renderer。
- **残留 transition（reviewer-claude R2 信息论论证不可约简）**: 无 sentinel 历史的 pre-fix 状态下 fs=5 无法区分 old-default-5 vs 故意-5（无额外数据承载意图）→ 首次 post-fix boot 必然 uplift 一次。成本可控（仅一次 + 5/10 是老 default 故意停留罕见 + uplift 后立即可 UI 重选永久生效）→ 可接受。

### ✅ 单方提出 + lead 现场验证（防御性硬化，LOW）

**LOW token regeneration 仅校验 length<64 接受 malformed token（settings-store.ts:153/164 原始）** — reviewer-codex LOW
`if (!token || token.length < 64)` 只判长度 → 64 个空格 / 64 个 `x` 等 malformed token 被接受不重生成，与注释「32 字节随机 hex」契约不符。
- 可达性: app 自身生成路径（`randomBytes(32).toString('hex')`）恒 canonical，不产 malformed；风险是配置被手工改坏 / 外部写入 malformed token 后不自愈。
- 验证: node 实测 `' '.repeat(64)` / `'x'.repeat(64)` 均通过原 length 检查；`randomBytes(32).toString('hex')` 1000× 全 match `^[0-9a-f]{64}$`（恒 lowercase hex）。
- 修法: 收紧为 canonical hex 校验 `^[0-9a-f]{64}$`（hook+mcp 双 token 共用 `isCanonicalToken` type predicate）。非 hex / 大写 / 长度错 / 空格 / x 均触发重生成自愈；存量 app-generated token 100% canonical 不误伤（不会 regen-loop）。
- **范围边界（reviewer-codex R2 INFO）**: canonical-format ≠ 低熵自愈。`'0'.repeat(64)` 是合法 lowercase hex（0 是 hex digit）→ **仍被接受不重生成**，这是 by-design（canonical format 目标，非熵检测）。覆盖明显低熵手改 token 需额外 denylist/entropy check，本批不做（randomBytes 不会产全零 + 低熵手改是 contrived scope）。

### ✅ 双方独立 / 单方 + lead 源码验证（注释更正）

**LOW/INFO 版本注释漂移（settings-store.ts:8 + 76）** — reviewer-claude LOW / reviewer-codex INFO（双方独立）
L8 注释「electron-store v10 继承自 conf v14」与实际依赖不符。
- 验证: lead node 实测 `electron-store@8.2.0`（package.json dep）+ `conf@10.2.0`（非 v14）；同文件 L71/73 F1 注释又正确写 conf@10.2.0 → 内部自相矛盾。
- 修法: L8 改「electron-store v8.2.0 继承自 conf v10.2.0」+ 标注 REVIEW_92 来源；L76「electron-store v10 父类」→ v8.2.0。

**INFO F-R2-D premise#2「set/delete 不抛」与 conf 实际 rethrow 行为不符（settings-store.ts:62）** — reviewer-codex INFO + lead 源码实证
F-R2-D 不变量 #2 称「store.set / store.delete 同步操作不抛（electron-store 内部 try/catch wrap）」。
- 验证: lead 读 conf@10.2.0 dist `_write`（line 374-385）确认仅对 EXDEV 兜底回退非原子写，**其余写错误（ENOSPC/EACCES 等）直接 `throw error`**。
- 修法: 注释改为「conf `_write` 仅对 EXDEV 兜底，其余 rethrow；本不变量真正依赖『常态磁盘可写时不抛』而非『内部 swallow 一切』；极罕 IO 错仍冒泡 → 见下方 step (2) throw 半残分析」。F-R2-D 整体设计假设（bootstrap fail-fast 比 half-migrated partial-recover 明确）仍成立，仅前提表述更如实。

### Clean 维度（双方独立确认）

- **F1 probe 修法**: probe Store（无 defaults）在 real Store defaults 写回 fs 之前 snapshot 真实 persistedRaw（claude 读 conf dist line 131-138 confirm `assert.deepEqual` fail 触发 _write 回写）；transparentWhenPinned/enableTaskManager/value-uplift/sentinel 全基于 persistedRaw 不被 DEFAULT_SETTINGS 污染。
- **migration 顺序**: 全部 migration step 在 REMOVED_KEYS delete loop 之前；三段读启动初 snapshot persistedRaw（非 live store）互不干扰。
- **enableTaskManager smart migration 4-case**: test 全覆盖；判定 `=== true && !('enableAgentDeckMcp' in persistedRaw)` 尊重用户 explicit 决策。
- **sentinel 边界**: `__valueUpliftMigrationDone` 不在 REMOVED_KEYS（不自删）；patch() 只迭代 patch keys 不碰 sentinel；conf 无 schema 持久化存活 fs round-trip。
- **getAll() `__` filter**: AppSettings 无 `__` 开头合法 key；9 处 main 消费者全走 getAll 过滤版无旁路直读 ensure().store；代价是未来公开 AppSettings key 不得用 `__` 前缀。
- **ensure() 无 try/catch（F-R2-D）**: 当前 0 IO step，常态假设有效；注释已诚实标注「未来加 IO 类 migration 步必须重审」。
- **patch()/set(undefined) 不可达**: conf set() 对 undefined 抛「Use delete()」，但 IPC JSON 序列化丢 undefined 不过线；null 可过 conf 正常存。

## 修复清单

| # | 文件:行 | 修法 | 裁决 |
|---|---|---|---|
| 1 | settings-store.ts:126-148 + getAll | value-uplift migration `__valueUpliftMigrationDone` sentinel gate 真一次性 + getAll() 剔除 `__` 前缀防泄漏 | ✅ MED（claude 单方 + lead UI range 验证；codex 仅判 LOW test-gap） |
| 2 | settings-store.ts:179-194 | token regen 收紧为 `/^[0-9a-f]{64}$/` canonical hex（hook+mcp 双 token） | ✅ LOW（codex 单方 + lead node 验证） |
| 3 | settings-store.ts:8-11 / 76 | 版本注释 v10/conf v14 → electron-store@8.2.0 + conf@10.2.0 | ✅ 双方独立（claude LOW / codex INFO） |
| 4 | settings-store.ts:62-66 | F-R2-D premise#2「不抛」→「conf _write 仅 EXDEV 兜底其余 rethrow」 | ✅ INFO（codex + lead conf 源码实证） |
| 5 | settings-store.ts:143-146 | sentinel 扩展边界注释锚点（跨版本新 value-migration 需第二 sentinel） | INFO（claude R2 建议，lead 采纳） |

## 测试

- **扩充** `src/main/store/__tests__/settings-store.test.ts` +8 test（6→14）：
  - value-uplift sentinel A-E 5 case：(A) 老用户 5/10 首次 uplift+置位 / **(B 关键) sentinel 已置+用户重选 5/10 → 不 re-fire（选择存活）** / (C) 用户选 7/15 不 migrate+置位 / (D) fresh install 不 migrate+置位 / (E) getAll() 剔除 `__` sentinel 不泄漏
  - token canonical 3 case：malformed（64 空格/64 x）重生成 canonical hex / canonical token 稳定不 regen / null fresh install 生成 canonical
- **temp-revert sentinel gate** → 6 FAIL（含关键 test B 显示 re-fire "Number of calls: 2"）验证有效。
- **typecheck 双配置全绿**；14 test passed（reviewer-claude 实跑 binding 可跑也 14 green）。测试走 vi.mock electron-store + in-memory Map（pure-fn，node 直跑，无 SQLite binding 依赖）。

## Follow-up（无新增必修项）

- 本批 INFO 全已 inline 修复或文档化（token 低熵自愈 contrived scope 不做 / sentinel 跨版本扩展边界已注释锚点），无遗留 Follow-up。
- **Batch G（store 子系统）✅ 全收官**：G1 session-repo（REVIEW_88）/ G2 team-repo（REVIEW_89）/ G3 message-repo（REVIEW_90）/ G4 杂项 store（REVIEW_91）/ G5 settings-store（REVIEW_92）。
