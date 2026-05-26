---
review_id: 53
reviewed_at: 2026-05-24
expired: false
---

# REVIEW_53: CHANGELOG_146 task-mcp 合并入 agent-deck-mcp deep review — 2 ✅ MED + 4 ✅ LOW 全 land

## 触发场景

用户主动触发「deep code review」+「项目代码 bug + 架构优化」，应用 `agent-deck:deep-review` SKILL（多轮异构对抗 review × fix 收口）评审最近最大改动 **CHANGELOG_146**（task-mcp 5 个 tool 物理合并入 agent-deck-mcp namespace，~7000 LOC 新增 / ~1800 LOC 删除）：

- 工具名 breaking change `mcp__tasks__task_*` → `mcp__agent-deck__task_*`
- v023 migration（task.team_id → owner_session_id 模型重设计）
- settings-store smart migration 4-case 钩子（enableTaskManager → enableAgentDeckMcp 自动迁移）
- EXTERNAL_CALLER_ALLOWED 决策矩阵（task_create/update/delete=false / task_list/get=true）

## 方法

**SKILL teammate 模式多轮异构对抗**（应用环境 deep-review SKILL 编排，**非** user CLAUDE.md §决策对抗主路径双 Bash 形态）：

| Reviewer | Adapter | Model | sid |
|---|---|---|---|
| reviewer-claude · CHANGELOG_146 | claude-code | Opus 4.7 default thinking | `ed87b05b-7de9-479c-bf51-71a728bb9bc3` |
| reviewer-codex · CHANGELOG_146 | codex-cli | gpt-5.5 xhigh | `019e5962-331b-7081-994d-42bda8b5553a` |

两 reviewer 同 team_id `37036064-9677-46a5-94cd-75d72a5775c9`，跨 adapter 物理保证异构（claude SDK 子进程 vs codex SDK 子进程）。R1 spawn 后 R2 复用同一对（send_message + reply_to_message_id 链接 R1 reply 锚点），享 teammate context 持久化 + 反驳轮 mental model 复用。

**scope**（10 文件 2846 LOC）：

| 文件 | LOC | 改动类型 |
|---|---|---|
| `src/main/agent-deck-mcp/tools/handlers/task-{create,delete,get,helpers,list,update}.ts` | 77+92+31+107+53+78 = 438 | 5 task handler + helper 新建 |
| `src/main/store/task-repo.ts` | 422 | owner_session_id 重设计 + cascade BFS |
| `src/main/store/migrations/v023_tasks_owner_session_id_rewrite.sql` | 93 | 新 migration |
| `src/main/store/settings-store.ts` | 154 | smart migration 4-case 钩子 |
| `src/main/agent-deck-mcp/tools/schemas.ts` | 1101 | STATUS_VALUES export + 5 TASK_*_SCHEMA |
| `src/main/agent-deck-mcp/types.ts` | 146 | EXTERNAL_CALLER_ALLOWED 严格 5 entries |
| `src/main/agent-deck-mcp/tools/index.ts` | 436 | 5 tool 注册 + annotations 4-tuple |
| `src/main/adapters/claude-code/sdk-bridge/mcp-server-init.ts` | 56 | 删 tasksServer 拼装段 |

**focus 多轮挖深**：

- **R1**（修复正确性 / 是否引新问题 / 测试质量）：5 handler owner_session_id 闭包注入 / EXTERNAL_CALLER_ALLOWED 决策矩阵 / cascade BFS ownerMap / settings smart migration 4-case 矩阵 / annotations 4-tuple / schemas STATUS_VALUES export 等 10 个 prompt 维度
- **R2**（边界条件 / 并发 race / 资源 lifecycle）：cascade self-loop / 并发 archived caller / probe Store lifecycle / TOCTOU race / EXTERNAL_CALLER_ALLOWED 严格性 / 注册顺序 / SDK options re-build 全量 vs 增量 / 测试盲区 8 个 prompt 维度

## 三态裁决清单

### ✅ 真问题（必修）— 2 MED + 4 LOW 全 land

#### F1 — R1 settings-store smart migration 被 conf defaults 写回短路（**生产 bug — 老用户偏好静默丢失**）

- **单方 + lead 现场 conf 源码铁证 ✅ + 推翻 reviewer-claude F9 INFO「4-case 完整」误判**: reviewer-codex 单方 MED；lead 现场 grep `node_modules/.pnpm/conf@10.2.0/node_modules/conf/dist/source/index.js:131-138`（real Store ctor `Object.assign(createPlainObject(), options.defaults, fileStore)` merge 后 `assert.deepEqual(fileStore, store)` 不等就 `this.store = store` 触发 setter `_write` 物理 fs.writeFileSync 写回 fs）+ `:274-298`（`get store()` 走 `fs.readFileSync` 实时读拿到 merged 内容）→ 影响所有 `!('newKey' in raw)` 形态 migration 第二次启动起永远短路。
- **影响面（DEFAULT_SETTINGS 含的 key）**：
  - `windowTransparent: true` → `transparentWhenPinned → windowTransparent` migration 失效（老用户主动关过透明窗口偏好丢失）
  - `enableAgentDeckMcp: false` → `enableTaskManager → enableAgentDeckMcp` migration 失效（老用户 task 能力丢失）
- **修法**: `src/main/store/settings-store.ts:53-72` 构造 real Store 前先开一个无 defaults 的 probe Store，snapshot 持久化 raw 不受 conf defaults 写回污染；所有 migration 判定改基于 `persistedRaw` 一处修双救。
  ```ts
  const probe = new Store<Record<string, unknown>>({
    name: 'agent-deck-settings',
  }) as { store: Record<string, unknown> };
  const persistedRaw: Record<string, unknown> = { ...probe.store };
  // ... 后续 migration 全部 'X' in persistedRaw 判定
  ```
- **测试加固**: `src/main/store/__tests__/settings-store.test.ts` mock 升级模拟 conf defaults 写回行为 + 新增 case (5) F1 regression 验证 enableTaskManager 路径 + case (6) windowTransparent 对称 regression（R2 双方独立 F-R2-A）。

#### F2 — R1 task-repo SQL IN list chunk 缺口（设计不一致 + 极端边界 SQLITE_TOOBIG）

- **单方 + lead 现场 grep 铁证 ✅**: reviewer-claude 单方 MED；lead 现场 grep `src/main/store/agent-deck-team-repo/member-query.ts:107` 已有 `CHUNK_SIZE = 500` chunked SELECT pattern + 注释「大批量分块 CHUNK_SIZE = 500 防超 sqlite IN list 默认上限 999」；对比 `src/main/store/task-repo.ts:255-262`（listTasks IN）+ `:326-329`（cascade DELETE IN）双处裸 IN 无 chunk — design 不一致铁证。极端场景（多 team 累积 sessionIds / plan 链 blocks 树 500+ nodes）撞 999 上限抛 `SQLITE_TOOBIG` 整 list/cascade 操作崩。
- **修法**:
  - `task-repo.ts:255-271` listTasks 加 `ownerSessionIds.length > 500` graceful guard 返空 + warn（极端场景病态，走 Node 端 chunked SELECT + merge sort 实现复杂收益边际低）
  - `task-repo.ts:340-353` cascade DELETE 改 chunked loop `CHUNK = 500` 在 `db.transaction()` 内多次 prepared statement run → 原子性保留（任一 chunk fail → 整 tx ROLLBACK）

#### F4 — R1 task_list/task_get annotations 4-tuple 不全（项目内不一致违 §「资产同步」）

- **单方 + lead 现场对比铁证 ✅**: reviewer-claude 单方 LOW；lead 现场对比 `tools/index.ts:359-364`（taskCreate）+ `:392-397`（taskUpdate）+ `:410-415`（taskDelete）3 个 write tool 都 4-tuple `{readOnlyHint, destructiveHint, idempotentHint, openWorldHint}`；`:373`（taskList）+ `:381`（taskGet）只 `readOnlyHint: true` — 项目内不一致。MCP annotations spec 缺省字段 caller 端（codex CLI approval gate / claude CLI 渲染）按 undefined 不同 client 解释不一致，部分 fallback `destructiveHint: true` → 只读 tool 反而触发不必要的高 risk 渲染。
- **修法**: `tools/index.ts:368-396` task_list / task_get 补齐 4-tuple 对称 `readOnlyHint:true + destructiveHint:false + idempotentHint:true + openWorldHint:false`。

#### F-R2-A — settings-store windowTransparent F1 regression test 缺失（R2 双方独立 ✅）

- **双方独立提出 ✅ 异构强冗余 = 即算验证**: reviewer-claude R2 LOW-1 ↔ reviewer-codex R2 INFO-C1，双方都点出 F1 fix 影响面双键（enableTaskManager + windowTransparent），但 R1 case (5) 只覆盖 enableTaskManager 一半 — 未来 conf 升级 / 重构 probe Store 拓扑 → windowTransparent migration 可能静默失效但 test 不报警。
- **修法**: `src/main/store/__tests__/settings-store.test.ts:202-232` 加 case (6) F1 regression 对称覆盖 transparentWhenPinned → windowTransparent migration，复用 case (5) mock 基础设施。

#### F-R2-B — cascade chunked DELETE 中间失败回滚 test 缺失（R2 双方独立 ✅）

- **双方独立提出 ✅**: reviewer-claude R2 LOW-2 ↔ reviewer-codex R2 INFO-C2；F2 修法 jsdoc 自承 "chunked DELETE 仍在 db.transaction 内多次 prepared statement run → 原子性保留" 逻辑正确，但无 fault-injection test 锁住「N > 500 nodes cascade + 中间 chunk throw → tx rollback 保留原集 + 不留 partial-delete 残骸」契约。
- **修法**: `task-repo.ts:340-360` 加 jsdoc F-R2-B 原子性契约段，文档化锁住语义；test 暂未补（task-repo.test.ts 整文件 better-sqlite3 binding `NODE_MODULE_VERSION` 不兼容 skip，详 CHANGELOG_42 教训不本地 rebuild 污染 Electron binding；未来本机 binding 兼容时补 fault-injection regression test）。

#### F-R2-C — caller==owner 不挡 archived caller（防御深度 gap，**实际无利用面**）

- **claude 单方 + 双重锁分析**: reviewer-claude R2 LOW-3；`task-helpers.ts:90-93 isCallerAuthorizedToWrite` 特例 `callerSid === ownerSid` 直接 return true 不查 caller archived/lifecycle 状态。但**双重锁实际无利用面**：(1) in-process transport sdk-bridge closure 强制覆盖 callerSid 为当前 active SDK session sid，archived SDK live query 已 abort 不会发 tool call；(2) HTTP/stdio external EXTERNAL_CALLER_ALLOWED.task_update/delete=false + denyExternalIfNotAllowed 拦截。
- **修法**: `task-helpers.ts:82-93` 加 jsdoc F-R2-C 防御边界说明，明示双重锁 + 未来 transport 演化必须同步评估本特例是否仍安全。

#### F-R2-D — settings-store ensure() 中间步抛错残留 partial store（防御深度 gap，极罕见）

- **claude 单方 + 设计取舍**: reviewer-claude R2 LOW-4；`ensure()` 函数体未包 try/catch，step (2) `store = new Store(...)` 已赋值后任何 (3..N) migration step throw → 下次 ensure() `if (!store)` 短路返回半残 store。极罕见 + electron-store v8.2.0 内部通常 swallow + 加 try/catch 后回滚语义复杂可能撞死循环。
- **修法**: `settings-store.ts:44-64` 加 jsdoc F-R2-D 设计假设说明，明示「所有 migration step 同步无 IO 抛错；未来加 IO 类 migration 步必须重审本假设」。

### ❌ 反驳 / 推翻 — 1 条

#### F9 — R1 reviewer-claude INFO「settings smart migration 4-case 覆盖完整」误判

- **被 F1 推翻 ❌**: reviewer-claude R1 INFO 列「4 case 覆盖完整 / ordering 正确 / warn 噪音控制好」断言只读应用层 `settings-store.ts:91-100` 代码，未读 conf 底层 ctor `index.js:131-138` defaults 写回 fs 行为；reviewer-codex 读底层 dependency 源码挖出 F1 真 bug。**异构对偶价值证明** — 同源化（双 Claude）会同时漏 F1 这个真有用户损失的 MED bug。

### ❓ 单方 LOW/INFO — 5 条（不修，记技术债 / 已 ack）

| # | Finding | 来源 | 处理 |
|---|---|---|---|
| F3 | task-list `total` 字段命名 misleading | claude 单方 LOW | tool description 已 ack；不修，记技术债 |
| F5 | task-delete pre-walk ownerMap 双重遍历 future maintenance risk | claude 单方 LOW | jsdoc 已 ack invariant；不修 |
| F6 | task-create sessionRepo.get pre-check 对 HTTP/stdio 冗余 | claude 单方 INFO | 设计 defensive 不是 bug；不修 |
| F7 | task-repo SELECT * 全表扫已 ack | claude 单方 INFO | jsdoc 已 ack 边界 + 走 transaction 保证原子性；不修 |
| F8 | v023 DROP TABLE 不可恢复已 user RFC 共识 | claude 单方 INFO | RFC 第 3 轮 Q1.A 明确接受；不修 |

### R2 6 维度核查通过项（不计入 finding，信任锚）

reviewer-claude R2 实证 6 维度无 finding 升级（cascade BFS self-loop / 钻石 / handler pre-walk vs repo BFS 镜像一致 / probe Store 无 listener leak / findSharedActiveTeams 无 TOCTOU race / EXTERNAL_CALLER_ALLOWED 严格 Record TS + runtime 双重防御 / STATUS_VALUES schemas.ts 切断 schema→handler runtime dep）。

## 修复条目（按严重度）

### MED (2)

- **F1** `src/main/store/settings-store.ts:53-72`：probe-before-defaults 修法
- **F2** `src/main/store/task-repo.ts:255-271 + :340-360`：list length guard + cascade chunked DELETE

### LOW (4)

- **F4** `src/main/agent-deck-mcp/tools/index.ts:368-396`：task_list/get annotations 4-tuple 对称
- **F-R2-A** `src/main/store/__tests__/settings-store.test.ts:202-232`：case (6) windowTransparent F1 regression
- **F-R2-B** `src/main/store/task-repo.ts:340-360`：cascade chunked DELETE 原子性契约 jsdoc
- **F-R2-C** `src/main/agent-deck-mcp/tools/handlers/task-helpers.ts:82-93`：caller==owner 防御边界 jsdoc
- **F-R2-D** `src/main/store/settings-store.ts:44-64`：ensure() 设计假设 jsdoc

### 测试加固

- `src/main/store/__tests__/settings-store.test.ts`：mock 升级模拟 conf defaults 写回 + case (5) F1 regression + case (6) windowTransparent F1 regression = 6/6 全过

## 验证

- `pnpm typecheck` ✅
- `pnpm build` ✅
- `pnpm exec vitest run src/main/store/__tests__/settings-store.test.ts` ✅ 6/6（含 case 5+6 F1 regression）
- `pnpm exec vitest run src/main/agent-deck-mcp/__tests__/ src/main/store/__tests__/task-repo.test.ts` ✅ 468 passed / 37 skipped（task-repo.test.ts binding skip 是 CHANGELOG_42 已记录环境问题不破 fix）

## 异构对偶价值实证

reviewer-claude（应用层视角，Opus 4.7） vs reviewer-codex（深度 dependency 视角，gpt-5.5 xhigh） 双方独立结论：

- **reviewer-codex 独自挖出 F1**（读 `conf@10.2.0/dist/source/index.js` 第三方依赖源码）— reviewer-claude 给同个 case INFO「完整」（只读应用层未读底层）
- **reviewer-claude 独自挖出 F2**（grep 同 repo `member-query.ts` 现有 chunk pattern 与 task-repo 不一致）— reviewer-codex 未点出该 design inconsistency
- **R2 双方独立提出 F-R2-A + F-R2-B 测试覆盖建议** — 异构强冗余即算验证升 ✅

同源化（双 Claude）会同时漏 F1 这个真有用户损失的生产 bug。本 review 是 deep-review SKILL 异构对抗价值的教科书级 case。

`heterogeneous_dual_completed: true`
