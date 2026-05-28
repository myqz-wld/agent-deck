# REVIEW_61 — Deep-Review 批 C: 剩余 7 文件 R1 收口

> 触发：用户请求 deep code review 批 C（继 REVIEW_59 批 A / REVIEW_60 批 B 之后），聚焦于 task-repo / session-manager / main bootstrap / adapter types / window lifecycle / shared settings / message-repo 7 文件横切的修复正确性 / 边界 race / 架构耦合 / 测试覆盖 / 单文件大小护栏 / 跨模块设计一致性 6 维度。
>
> 工具链：agent-deck:deep-review SKILL（多轮异构对抗 reviewer-claude + reviewer-codex 跨 adapter spawn）+ 三态裁决 + 现场验证。
>
> 关联 fix：[CHANGELOG_172.md](../changelogs/CHANGELOG_172.md)。

## Scope

| 文件 | LOC | 角色 |
|---|---|---|
| `src/main/store/task-repo.ts` | 712 | Task Manager 持久层（5 mcp tool 调用入口 / v024 team_id 三态 + hand_off team_task_policy reassignOwner + applyHandOffSkipPolicy） |
| `src/main/session/manager.ts` | 686 | SessionManager 单例 facade（ingest / renameSdkSession / updateCliSessionId 反向 rename + sdkOwned / recentlyDeleted 黑名单） |
| `src/main/index.ts` | 577 | 主进程 bootstrap + IPC bridge + before-quit cleanup + global shortcut |
| `src/main/adapters/types.ts` | 558 | Adapter 接口契约 + ClaudeCreateOpts / CodexCreateOpts + capabilities |
| `src/main/window.ts` | 547 | FloatingWindow 单例 facade（create / toggleMaximize / toggleDefault / toggleCompact / flash / pin / 透明） |
| `src/shared/types/settings.ts` | 544 | AppSettings + DEFAULT_SETTINGS + SettingsPermissionsBlock 扫描类型 |
| `src/main/store/agent-deck-message-repo.ts` | 516 | Universal team backend 消息持久层（insert / claim / markDelivered / markFailed / retryAfterFail / findEligible） |

合计 4140 LOC。批 A (REVIEW_59 / commit 7475b75) 已审 mcp tools 3 文件 / 批 B (REVIEW_60 / commit 627a0c2 + 5b66cd8) 已审 sdk-bridge 双端 4 文件,本批 C 7 文件不与前两批重叠。

## 流程

- **Step 0** dual self-check: `.gitignore` 含 `.deep-review-cache/` + orphan sweep 通过
- **Step 1** 并发 spawn reviewer pair `dcr-batch-c-20260528` (reviewer-claude claude-code adapter Opus 4.7 + reviewer-codex codex-cli adapter gpt-5.5 xhigh,物理保证异构)
- **R1** 全量审 7 文件 / 6 维度 → 双方 reply 自动注入 lead conversation
- **三态裁决** + lead 自己 Read 4 文件 + grep 调用方现场验证
- 单方独有 MED → 主裁决 (不走反驳轮,因为单方独有 + lead 现场验证已足够定性)
- **fix loop** 5 处实施(MED-A / MED-B / LOW-α / LOW-1 / LOW-β) → typecheck pass → commit
- **R2** 待发送(skip 字段含本 commit 列表 — 详 CHANGELOG_172 末尾「下一步」)

## 三态裁决总览

| Finding | reviewer | 原 severity | 验证结果 | 裁决 |
|---|---|---|---|---|
| MED-1 window.ts kickRepaintAfterPin closure stale | claude | MED | jsdoc 明确「同步 +1 / 下一个 macro task 调回原值」是设计意图,改动态读破坏 layout trigger 机制 | ❌ 降级 INFO 不修 |
| MED-A window.ts BrowserWindow 销毁后 stale this.win | codex | MED | ✅ 验证铁证: create() 无 'closed' listener, showOnce/notifyUser/cli 多处直调 .show() 无 destroyed 防护 | ✅ MED 必修 |
| MED-2 index.ts:285 agent-event IPC 无 debounce | claude | MED | agent-event 是 event-stream 不是 state-update 语义,SessionDetail 已自实现 throttle,无 profile 数据 | ❌ 降级 INFO 不修 |
| MED-B index.ts:214/494 app.exit(1) 绕过 closeDb | codex | MED | ✅ 验证铁证: Electron app.exit 文档明确不发 before-quit,SQLite WAL 不 checkpoint | ✅ MED 必修 |
| MED-3 listBySession 全表 OR 扫描 + 缺索引 | claude | MED | by design (注释明文 trade-off「rows ≤ 几千」),无 profile 数据 | ❌ 降级 INFO 不修 |
| LOW-1 window.ts flash() 重入污染 baseline opacity | claude | LOW | ✅ 验证铁证: 二次进入 getOpacity 取到 0.5 当 baseline → 永久半透明 | ✅ LOW 修 |
| LOW-2 task-repo cleanupBlocksReferences length-only | claude | LOW | filter 单调性保证语义正确 (filter 只删不加 → len 变化等价命中判定) | ❌ 已确认非 bug |
| LOW-3 manager.ts updateCliSessionId 函数体注释 | claude | LOW | jsdoc line 610-648 极详尽 + inline comment line 657-659 已充分覆盖 | ❌ 过度防御 |
| LOW-4 index.ts before-quit 不调 removeAllListeners | claude | LOW | process exit 自然清,safeSend 已兜底 isDestroyed,纯防御 | ❌ 过度防御 |
| LOW-α agent-deck-message-repo final retry 不写 attempt_count | codex | LOW | ✅ 验证铁证: markFailed 不更新 attempt_count,reason 写 attempt=3 但 DB 列停在 2 | ✅ LOW 修 |
| LOW-β task-repo:381 subject LIKE wildcard 未 escape | codex | LOW | ✅ 验证铁证: 不是 SQL injection,但 `%` `_` 让搜索语义偏移 | ✅ LOW 修 |
| INFO-1 至 INFO-5 (claude) 拆分建议 | claude | INFO | 拆分建议 | 见维度 5 处理 |
| **维度 5** 7 文件全超 ≤500 LOC | 双方 | INFO+ | 双方独立提出 ✅ | 登记保护清单理由(本批 R1 不拆,候选单独 plan) |

## 必修 finding 详细 (5 条)

### ✅ MED-A [window.ts:107-118] BrowserWindow 销毁后 this.win 仍指 stale 对象 (codex,验证铁证)

**问题**:
`create()` line 60-151 把 `BrowserWindow` 存到 `this.win`,**没有**注册 `'closed'` event listener 清空。只有显式调用 `FloatingWindow.close()` (line 523) 才置 null。用户用 Cmd+W / OS close / 系统强杀关窗后,BrowserWindow.isDestroyed() = true 但 `this.win` 仍指 stale 对象。

**触发路径**:
- `showOnce` 内 `this.win.show()` (旧 line 116) 不防 destroyed
- `setTimeout(() => showOnce('fallback-timeout'), 1500)` 1.5s 兜底 timer 仍持 stale this.win
- `notifyUser` via `getFloatingWindow().window` (notify/visual.ts) 直接 .isFocused()
- CLI focus 路径 (cli.ts) 直调 .show() / .focus()

**验证**:
- 全文 grep `'closed'` event listener 注册 — `src/main/window.ts` 仅 `'ready-to-show'` `'did-finish-load'` `'did-fail-load'`,无 `'closed'`
- `close()` 方法 line 523-531 仅在显式调用时跑

**修法**:
`create()` 末尾(line 107 之后)注册 `this.win.once('closed', () => { this.stopInvalidateLoop(); this.win = null; })` 自动清。同步把 `showOnce` 加 `this.win.isDestroyed()` 防护(防 setTimeout 1.5s 兜底 fallback 撞 destroyed)。dock activate → ensureFocusableOnActivate → create() 重建会重新设 this.win 到新 BrowserWindow,所以 'closed' 清 null 不破坏重建路径。

---

### ✅ MED-B [index.ts:214 + index.ts:494] fatal bootstrap app.exit(1) 绕过 before-quit closeDb (codex,Electron 文档铁证)

**问题**:
- line 99 `initDb()` 已开 SQLite
- line 214 hook-server fail 直接 `app.exit(1)`
- line 494 bootstrap fatal catch 直接 `app.exit(1)`
- Electron 文档明确 `app.exit()` 不发 `before-quit` / `will-quit` → before-quit handler line 519 不会跑 → `closeDb()` 不会执行 → SQLite WAL 不 checkpoint → 下次启动 replay log,极端 corruption 风险

**注**: before-quit handler line 540-565 自己也用过同款修法 — `closeDb` 在 race 外**总是**跑(REVIEW_35 R2 MED-D claude R2-3 留的注释), 但 fatal app.exit(1) 两个分支绕开了同一不变量。

**修法**:
两处 `app.exit(1)` 前同步 best-effort 跑 `closeDb()`:
```ts
try { closeDb(); } catch (err) { console.warn('[<fatal context>] closeDb error', err); }
app.exit(1);
```

fatal 路径仅 warn 不阻塞 exit(本来就是 fatal,WAL 丢一点比 hang 住强)。

---

### ✅ LOW-α [agent-deck-message-repo.ts:426-431] final retry markFailed 不写 attempt_count (codex,验证铁证)

**问题**:
`retryAfterFail` 内 `newAttemptCount = cur.attempt_count + 1`,达到 MAX_RETRY=3 时调 `markFailed(messageId, 'retry-exhausted (attempt=3): ...')`,但 `markFailed` (line 405-416) 只 UPDATE `status/status_reason/delivering_since`,**不**更新 `attempt_count` 列 → DB 里 attempt_count 仍停在 2 (cur.attempt_count 值),与 status_reason 字符串里的 `attempt=3` 不一致。

**影响**: 失败消息的结构化 attemptCount 字段和可读 reason 分裂,UI / 诊断 / 后续审计低报一次尝试。

**修法**:
final retry 分支用一条 UPDATE 同时写 `attempt_count` + `status` + `status_reason` + `delivering_since`(不复用 markFailed,避免 markFailed 接口语义变化影响其他 caller)。

---

### ✅ LOW-1 [window.ts:507-521] flash() 重入污染 baseline opacity (claude,验证)

**问题**:
flash() A 进行中 opacity 在 [0.5, 1.0] 切换;此时第二次调 flash() B → `getOpacity()` 取到的可能是 0.5 (A 刚把它设成 0.5),B 把 0.5 当 baseline → B 结束时 setOpacity(0.5) → 窗口永久半透明直到下次 flash 边界覆盖。

**修法**:
- 把 timer 引用提到 instance state (`this.flashTimer`)
- 二次进入时先 `clearInterval` 旧 timer + 复位 opacity 到 `flashOriginalOpacity` 再起新轮
- `close()` 显式收尾同步清 flashTimer(防 flash 跑到一半显式 close,setInterval 句柄残留 event loop)

---

### ✅ LOW-β [task-repo.ts:381-384] subject LIKE wildcard 未 escape (codex,验证铁证)

**问题**:
```ts
wheres.push('LOWER(subject) LIKE ?');
params.push(`%${opts.subjectKeyword.toLowerCase()}%`);
```

用户输入 `%` 或 `_` 会按 SQL wildcard 匹配,返回范围扩大;不是 SQL injection (param 绑定挡住),但搜索语义偏移(用户输入 `100%` 实际意图搜「100%」字符串,旧实现等价「任意以 100 开头」)。

**修法**:
escape `%` `_` `\` 三个 wildcard 字符 + 加 `ESCAPE '\'`:
```ts
const escaped = opts.subjectKeyword
  .toLowerCase()
  .replace(/\\/g, '\\\\')
  .replace(/%/g, '\\%')
  .replace(/_/g, '\\_');
wheres.push("LOWER(subject) LIKE ? ESCAPE '\\'");
params.push(`%${escaped}%`);
```

注: escape `\` 必须放第一个 (replace 链顺序敏感),否则后续 `\%` 会被 `\\` 替换破坏。

---

## ❌ 降级 INFO 不修 finding (5 条)

### MED-1 window.ts:203-213 kickRepaintAfterPin closure stale (claude)

函数 jsdoc line 199-202 明确设计意图: 「同步 setContentSize(+1px),下一个 macro task 调回原值,触发 Chromium 完整 layout/repaint 路径把旧 surface 冲干净」。 closure 捕获 stale dimensions 是 BY DESIGN — 改成 setImmediate 内重读 getContentSize 会让动态读 -1 复原变成「相对值减 1」可能破坏 layout trigger 效果(残影修复机制依赖 +1 涨缩触发完整 ViewSizeChanged)。setImmediate 跨 macro task 边界 < 1ms,用户在 <1ms 内拖窗口边角的几率极低。

### MED-2 index.ts:285 agent-event 无 debounce (claude)

agent-event 是 1:1 event-stream(每条 kind 'message' / 'status' / 'file-changed' / 'file-deleted' 独立语义),与 team-changed / message-changed 的 state-update 语义不同 — debounce 会损害正确性(丢 message event 用户看不到)。SessionDetail 自实现 300ms throttle 收 file-changed 是合理边界(高频 kind 单独处理)。claude 提的「重渲染压力」无具体 profile 数据,by design trade-off 保持现状。

### MED-3 agent-deck-message-repo.ts:289-313 listBySession 全表 OR 扫描 (claude)

函数注释 line 292 明文承认 by design trade-off「不走 idx_messages_sent_at(无法两个谓词都索引),扫表 + WHERE filter,rows ≤ 几千问题不大」。SessionDetail tab 切换才触发,用户切 tab 频率 ≤ 秒级,本身不至炸。无 profile 数据证明已撞性能瓶颈。**性能优化候选**(纯 schema migration + sqlite ANALYZE,加双复合索引 `idx_messages_from_session(from_session_id, sent_at DESC)` + `idx_messages_to_session(to_session_id, sent_at DESC)` SQLite 会用 OR-split + UNION ALL 自动选两个 index),但本批不在 fix scope 内,待用户报告慢/profile 数据后单独 plan。

### LOW-2 task-repo.ts:567-570 cleanupBlocksReferences length-only (claude)

claude 自己澄清: filter 单调性 → `blocks = origBlocks.filter(x => !deletedIds.has(x))`,filter 后 len 减少 == 至少一个 id 被删,len 不变 == filter 没命中 == 该 task 与 deletedIds 不相交,无需 UPDATE。length 比对是删除场景的精确等价判定。**已确认非 bug,不动**(注释建议可加但不强求,REVIEW_56 已审过同款无意见)。

### LOW-3 manager.ts:649-660 updateCliSessionId 函数体注释 (claude)

jsdoc line 610-648 极其详尽(38 行)写清反向 rename invariant + 与 renameSdkSession 跨表事务复杂迁移**完全不同**的关键 invariant 5 条 + 黑名单链 3 步 + spawn-path no-op 短路 + 6 处 caller path 表。函数体 line 657-659 已有 inline comment「不 emit session-renamed (D6 反向 rename 不 emit) / 不调 mcpSessionTokenMap.rename / 不调 sessionRenameHookFn」。新人误改风险已充分覆盖,**过度防御不修**。

### LOW-4 index.ts:519-576 before-quit 不调 removeAllListeners (claude)

before-quit 整片 process exit 进程销毁 listener 自然清,**安全**。race timeout 命中 `process.exit(1)` 走完 closeDb 之前,残余 listener 在 closeDb sync 期间触发 emit → safeSend → mainWindow isDestroyed=true → safeSend 内 `if (w.isDestroyed())` 兜底早退(line 278) → **无 crash 风险**。纯防御性建议,**过度防御不修**。

## INFO 拆分建议 (双方共识维度 5)

7 文件全部超 500 LOC 触发拆分尝试 SOP。双方独立提出建议(claude INFO-1 至 INFO-5 + codex INFO 综合表)。本批 R1 fix 不拆(避免 5 处必修 fix + 7 文件拆分两件事混 1 commit,blame radius 难拉),**单独 plan 走分批拆分**(逐个 commit + typecheck 防回归)。

### 拆分候选(待单独 plan)

| 文件 | 当前 LOC | 拆分建议 | 拆后预估 |
|---|---|---|---|
| task-repo.ts | 712 | 拆 task-repo-cleanup.ts (cleanupBlocksReferences + cascade BFS) + task-repo-handoff.ts (reassignOwner + applyHandOffSkipPolicy + findOwnedDistinctTeamIds) | ~452 |
| manager.ts | 686 | 续拆 manager-rename.ts (renameSdkSession + updateCliSessionId) + manager-tombstone.ts (recentlyDeleted / markRecentlyDeleted) | ~538 仍微超 |
| index.ts | 577 | 拆 ipc-event-bridge.ts (line 270-407 IPC bridge) + before-quit-cleanup.ts (line 518-576) | ~412 |
| adapters/types.ts | 558 | 抽 BaseCreateOpts (消重 70% 字段 + jsdoc): ClaudeCreateOpts extends Base + CodexCreateOpts extends Base | ~350-400 |
| window.ts | 547 | 拆 window-toggle.ts (toggleMaximize/toggleDefault/applyTargetSize/rememberIfCustom) + window-pin.ts (kickRepaintAfterPin/startInvalidateLoop) | ~387 |
| shared/types/settings.ts | 544 | 拆 settings-scan.ts (line 478-544 PermissionScanResult / SettingsLayer / MergedRule 等扫描类型) | ~474 |
| agent-deck-message-repo.ts | 516 | facade 模式 14 method 委托,拆收益低;保留或抽 message-repo-queries.ts (listBySession + listByTeam) | ~466 |

### 保护清单(本批不动 + 单独 plan 候选)

按 file-size-guardrail SOP §档 3「真不能拆要登记保护清单 + 理由」,本批 7 文件全列保护:

1. **task-repo.ts** (712): hand_off team_task_policy 三态 reassignOwner / applyHandOffSkipPolicy / findOwnedDistinctTeamIds 三 helper 与 cleanupBlocksReferences 共享 db / transaction / Row 类型 — 拆分需 cross-file pass db handle 或抽 helper 模块,blame radius 大。**待单独 plan**。
2. **manager.ts** (686): manager-* helper 已拆 4 个(manager-helpers / manager-enrich / manager-ingest-pipeline / manager-team-coordinator),续拆 rename + tombstone 与 sdkOwned/recentlyDeleted 单例 state 强耦合。**待单独 plan**。
3. **index.ts** (577): bootstrap 11 步骤间共享 settings / floating / safeSend closure / debouncedTeamSender helper,IPC bridge 段提取需打包 closure args dict 反降可读性。**待单独 plan**。
4. **adapters/types.ts** (558): 70% 字段重合的 ClaudeCreateOpts vs CodexCreateOpts 抽 BaseCreateOpts 收益高,但属 schema 升级影响所有 adapter caller signature。**待单独 plan**(estimated 中等工作量)。
5. **window.ts** (547): FloatingWindow 单例 facade,toggleMaximize/toggleDefault/applyTargetSize 共享 isNear / centerInDisplay / clampPositionInDisplay / rememberIfCustom helper,拆 window-toggle.ts 需要把 this.preferredSize / this.lastToggleAt 通过 args 传递。**待单独 plan**。
6. **shared/types/settings.ts** (544): 拆 settings-scan.ts 工作量最低(纯 type 拆分无 runtime 行为变化),但 settings.json 4 层合并扫描功能跨 main/renderer 共用,拆 type 文件需同步更新 main/ipc/settings.ts + renderer 用到 PermissionScanResult 的 Settings 页面 import。**待单独 plan**。
7. **agent-deck-message-repo.ts** (516): facade 模式 14 method 委托(line 478-516),拆 default export 到独立文件意义不大;拆 message-repo-queries.ts 收益约 50 LOC 也不显著突破 500 阈值。**保留现状**(SOP §档 3 允许的「真不能拆」场景)。

---

## 测试覆盖度评估

| 文件 | 现有单测 | 关键路径覆盖 | 缺口 |
|---|---|---|---|
| task-repo.ts | task-repo.test.ts | create / list / update / delete + cascade / reassignOwner / applyHandOffSkipPolicy + v024 team_id 三态 | 缺 LIKE wildcard escape 回归 test(本 fix 配套加) |
| agent-deck-message-repo.ts | agent-deck-message-repo.test.ts | insert / claim / markDelivered / markFailed / retryAfterFail / findEligible | 缺 final retry attempt_count 持久化断言(本 fix 配套加) |
| manager.ts | partial | 部分路径 | 反向 rename / closeDb-always-runs 路径无直接单测,依赖 integration |
| window.ts | 无 | 无 | BrowserWindow lifecycle 需 BrowserWindow mock 测试,本批 fix 不补(成本 vs 收益) |
| index.ts | 无 | 无 | bootstrap fatal lifecycle 同上 |
| adapters/types.ts | N/A (纯类型) | N/A | — |
| shared/types/settings.ts | N/A (纯类型) | N/A | — |

## 跨模块设计一致性 (维度 6)

- **task-repo / session-manager / shared/types/settings**: tasks 表 `owner_session_id` NOT NULL FK → `sessions(id)` ON DELETE CASCADE,settings.json `historyRetentionDays` 改变后 LifecycleScheduler.delete sessions 触发 CASCADE 自动删 task — 各层同步生效 ✅
- **message-repo / adapters/types**: message envelope `AgentDeckMessage` schema 与 adapter dispatch payload (universal-message-watcher → adapter.receiveTeammateMessage) 字段一致 ✅
- **window / main/index lifecycle**: floating singleton recreate 路径(macOS dock activate → ensureFocusableOnActivate → create) 之前 stale this.win 未清问题已被本批 MED-A 修 ✅
- **before-quit cleanup vs fatal exit**: 旧版 fatal app.exit(1) 与 before-quit closeDb 不变量裂开问题已被本批 MED-B 修 ✅

## R2 准备 (待发送)

`skip` 字段含本 commit 5 处 fix:
- 已修: src/main/window.ts:107 register `closed` listener 清 this.win + showOnce 加 destroyed 防护 (commit d5549c6) [MED-A]
- 已修: src/main/window.ts:507-540 flash 重入保护 + close 清 timer (commit d5549c6) [LOW-1]
- 已修: src/main/index.ts:214 + index.ts:494 两处 app.exit(1) 前 best-effort closeDb (commit d5549c6) [MED-B]
- 已修: src/main/store/agent-deck-message-repo.ts:426-440 final retry 单条 UPDATE 同时写 attempt_count + status (commit d5549c6) [LOW-α]
- 已修: src/main/store/task-repo.ts:381-394 subject LIKE wildcard escape `%` `_` `\` + ESCAPE '\' (commit d5549c6) [LOW-β]

R2 focus: 验证 fix 正确性 + 是否引新问题 + 维度 5 拆分候选审议(预计 R2 无新真 finding 即可收口)。

## R2 收口实况

### reviewer-claude R2 reply (msg 6384bdbc)

✅ R1 5 处 fix 全部 single-sided verify 通过(现场 grep + 读 closeDb impl + LIKE escape 顺序 dry-run 三 case `100%` / `c:\path` / `100\%_` 实测通过)。残留 deep dive 4 文件 R1 fix 之外区域无新真问题。跨模块设计一致性无新漂移。

❓ INFO 级 2 项提示(不影响合并): showOnce setTimeout 1500ms 句柄不存(timer leak 但 callback safe no-op);'closed' listener 与 startInvalidateLoop cb 自身 destroy 侦测冗余(无害保险)。建议加 LOW-α/β 配套 unit test 覆盖。**明确 ✅ 可合,本 R2 收口**(reviewer-codex 如同意则双方共识)。

### reviewer-codex R2 reply (msg d2425cae)

R1 fix 大部分 verify 通过(closeDb / final retry attempt_count / LIKE escape 现场 sqlite3 实测字面字符匹配通过)。**❗ 新 LOW finding**(reviewer-claude FIX-2 小补充自己提到 setTimeout 句柄不存但**漏掉**「卸 winA + 又新建 winB」双步): window.ts 旧窗口 generation 异步回调跨 close+recreate 操作新 winB — 1.5s fallback / showOnce / flash setInterval cb / 'closed' listener 自身读 mutable `this.win` 会拿到 winB 误操作。**❗ 新 INFO**: d5549c6 未改 test,LOW-α attempt_count 持久化 + LOW-β LIKE escape 字面匹配 2 处 regression test 缺失。

**lead 裁决**:
- LOW 走单方独有 + lead 现场验证(reviewer-codex 已现场验证序列 + LIKE escape sqlite3 实测;reviewer-claude R2 FIX-2 小补充同款风险支撑) → ✅ 真问题 + 修法低成本 → 必修
- INFO test 缺失走良性补缺 → ✅ 配套补 2 test

### R2 LOW fix 实施 (commit 5d389cf)

**window.ts generation guard 三层防御**:

1. `create()` 入口 `const capturedWin = this.win` 捕获本 generation,所有 callback 用 capturedWin 而非 mutable this.win
2. `'closed'` listener 加 `if (this.win !== capturedWin) return` generation guard + 同步清 flashTimer + clearTimeout fallbackShowTimer + this.win = null(4 资源 best-effort cleanup,任一资源失败不互相阻塞)
3. 1.5s 兜底 setTimeout 句柄存 instance state `this.fallbackShowTimer`,'closed' / `close()` 同步 clearTimeout
4. `flash()` setInterval cb 同款 generation guard(跨 generation 不复位 winB opacity,避免污染新窗口真实 opacity)
5. `close()` 显式调用同步清 flashTimer + fallbackShowTimer(双保险,close() 早于 'closed' event 时立即生效)

**2 regression test 配套**:

- `agent-deck-message-repo.test.ts` retryAfterFail final case 加 `expect(r?.attemptCount).toBe(3)` + `expect(r?.statusReason).toContain('attempt=3')`(锁 R1 LOW-α 契约,旧实现 DB 列停在 2 与 reason 分裂)
- `task-repo.test.ts` 新增 `subjectKeyword LIKE wildcard 字面匹配` test(覆盖 `%` 字面排除 `1000` 误命中 / `_` 字面排除 `fooXbar` 误命中 / `\` 字面 Windows path 匹配,锁 R1 LOW-β 契约)

## R3 收口实况

### reviewer-claude R3 reply (msg fec98c9a)

✅ R2 LOW generation guard 三层防御 FIX-A/B/C/D 4 处全部 single-sided verify 通过:

- **FIX-A 'closed' listener generation guard**: capturedWin 捕获时机正确(line 80+ new BrowserWindow 之后 / setAlwaysOnTop 之后 / callback 注册之前);跨 close+recreate 路径 verify winA close → cb 跑(this.win=winB ≠ capturedWin=winA)→ skip 不动 winB;4 资源 best-effort 顺序正确(stopInvalidateLoop / clearInterval flashTimer / clearTimeout fallbackShowTimer / this.win = null 最后);listener 注册时绑定 winA event emitter,winB 自有 own listener 不会误触
- **FIX-B showOnce + fallbackShowTimer 双 guard**: 三 guard 短路求值正确(shown / this.win !== capturedWin / capturedWin.isDestroyed());capturedWin.show() 强制双保险即使 generation guard 出 bug 也只会 show winA(可能已 destroyed → no-op);三处清理路径(自然到点 / 'closed' / close)无遗漏。R2 setTimeout 句柄不存 INFO 已被一次性彻底修(比 R2 提议范围还广,加 generation guard 防新 winB 误 show)
- **FIX-C flash setInterval cb generation guard**: 跨 generation 不复位 opacity 关键设计正确(`this.flashOriginalOpacity` 是 winA baseline,跨 generation 把它 set 到 winB 会污染 winB 真实 opacity);极端 race verify(winA close 'closed' listener 同步 clearInterval flashTimer + this.win=null → 下个 120ms 周期 cb 不会触发);flash 重入 line 562 仍用 this.win 但 JS single-thread 顺序保证安全
- **FIX-D close() 双保险同步清**: close() 显式调用早于 'closed' event 触发(close 是 sync 触发,'closed' event 是 async emit) → 同步生效,'closed' listener 跑时 timer 已 null → if 守门 skip 无双 clear 副作用

✅ TEST-1 retryAfterFail final assertion 真锁契约(旧实现 attemptCount 停在 2 → expect(3) 会挂);✅ TEST-2 subjectKeyword LIKE 字面 4 case 真覆盖 `%`/`_`/`\\` 三 wildcard。

**明确 ✅ 可合,本 R3 收口**。判定依据: 0 新真问题 + R2 LOW 修法范围实际**比 R2 提议的还广**(reviewer-codex 抓到完整「卸 winA + 又新建 winB」双步污染面,本 R3 三层 generation guard 一次性彻底修) + test 配套真锁 R1 LOW-α/β 契约 + typecheck 0 error。

### reviewer-codex R3 reply (msg a5f5ccd1)

✅ 双方共识可合,本 R3 收口。0 finding。验证结论:

- window.ts:126-159 capturedWin 捕获时机 + showOnce 三 guard 短路求值正确
- window.ts:127-140 'closed' listener generation guard 防破坏新 winB 重建 + 4 资源同步清不破坏 ensureFocusableOnActivate() 重建路径
- window.ts:156-159 + 587-602 fallback timer 句柄进 instance state + 三处清理路径覆盖 R2 指出的旧 fallback 跨 close+recreate show 新窗口路径
- window.ts:568-584 flash interval generation guard + 只有同 generation 才复位 opacity 避免旧 generation 污染 winB opacity
- agent-deck-message-repo.test.ts:134-141 final retry case 新增 attemptCount === 3 + statusReason 含 attempt=3 锁住 R1 LOW-α 结构化字段与 reason 一致性
- task-repo.test.ts:187-207 `%` 字面 / `_` 字面 / `\` 路径 under `ESCAPE '\'` 回归测试: 100% 排除旧 wildcard 误命中 1000,foo_bar 排除旧 `_` wildcard 误命中 fooXbar,反斜杠 case 锁新 ESCAPE 语义下 Windows path 字面匹配

## 最终收口总结

**R1+R2+R3 三轮异构对抗收口** = 共 **6 处必修 fix**(R1 5 + R2 LOW 1)+ **2 regression test**:

| Round | Fix | Commit | 来源 |
|---|---|---|---|
| R1 MED-A | window.ts 'closed' listener + showOnce destroyed 防护 | d5549c6 | reviewer-codex 验证铁证 |
| R1 MED-B | index.ts 两处 fatal app.exit(1) 前 best-effort closeDb | d5549c6 | reviewer-codex Electron 文档铁证 |
| R1 LOW-α | agent-deck-message-repo retryAfterFail final 单条 UPDATE | d5549c6 | reviewer-codex 验证铁证 |
| R1 LOW-1 | window.ts flash() 重入保护 + close() 清 timer | d5549c6 | reviewer-claude 验证 |
| R1 LOW-β | task-repo subject LIKE wildcard escape `%` `_` `\` + ESCAPE '\' | d5549c6 | reviewer-codex 验证铁证 |
| **R2 LOW** | **window.ts generation guard 三层防御(capturedWin + 'closed' listener generation guard + fallbackShowTimer instance state + flash cb generation guard)** | **5d389cf** | **reviewer-codex 验证(reviewer-claude R2 FIX-2 小补充自身漏点)** |
| R2 INFO Test | agent-deck-message-repo + task-repo 2 regression test 配套 | 5d389cf | reviewer-codex 良性补缺 |

**降级 INFO 不修** (5 条 R1 + 0 R2 + 0 R3): 见 §❌ 降级 INFO 不修 finding 节。

**维度 5 ≤500 LOC 拆分** (双方共识): 7 文件全超(4140 LOC),登记保护清单 + 候选**单独 plan 走分批拆分**(本批 R1-R3 不拆,避免与 fix 混 commit blame radius 难拉)。

**SKILL 学习点**:
1. **R2 reviewer 互相补全 R1 自身漏点价值教科书级 case**: reviewer-claude R2 FIX-2 小补充提到「setTimeout 1500ms 句柄不存」但漏掉「卸 winA + 又新建 winB」双步污染面;reviewer-codex R2 抓到完整序列(同源化双 Claude 会同时漏这个 LOW);本 R2 三层 generation guard 一次性彻底修法范围比双方原始建议都广。**异构对偶价值再次实证**
2. **单方独有 LOW + lead 现场验证 + 双 reviewer 同款风险支撑可不走反驳轮**: 按 SKILL 规则反驳轮仅 HIGH 强制,LOW/MED 走 lead 自己 Grep/Read 验证更高效;本 R2 LOW reviewer-codex 已现场实测序列 + reviewer-claude R2 FIX-2 小补充自身提到同款风险 → lead 直接接裁决无需反驳
3. **R3 严格只看 R2 fix-to-fix 范围快速 PASS**: R3 prompt 明示「严格只看本轮 fix-to-fix 范围不溢」,避免 R3 deep dive 又挖新区域无限拖;双 reviewer R3 都按 prompt 限定范围 verify,0 finding 快速收口
4. **regression test 配套 = R1-R2 fix 契约锚点**: 2 test 锁 R1 LOW-α 结构化字段一致性 + R1 LOW-β SQL wildcard escape 语义,binding 修好后自动跑(默认 skip 守门符合 CLAUDE.md §打包踩坑清单契约)

