# REVIEW_94 — 全项目 deep review 批 H2：renderer core（App + session-store）

- 日期: 2026-06-01
- 类型: 功能 BUG（启动 pending 全量快照整表替换抹掉 live pending → SDK 死锁 / renameSession 丢 fromId by-session 缓存 / pushEvent cancel 留空数组 key / merge 排序倒挂截掉最新事件）+ 代码优化（cancelled flag / seq guard / 约定一致性）（全项目 deep review 第二十四批，Batch H 子批 H2，renderer 顶层 state 管理）
- 触发: 用户「deep review 下项目，聚焦功能 BUG / 代码优化 / 文字措辞优化，自主一路推进 + 自主 hand off」授权（plan deep-review-project-20260531）
- 关联: plan deep-review-project-20260531 / REVIEW_93（H1 issue 组件）/ REVIEW_2/4/6/7/35/45/52/54（session-store 历史 finding，本批独立复验全部成立）/ CHANGELOG_27/29/31（CLI fork rename / detailSession 派生）
- 方法: 多轮异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5，**复用 H pair dr-project-h-20260531 dormant resume**，保留 H1 renderer mental model）+ 三态裁决 + lead Read/Grep + 全链路追踪（use-event-bridge 启动顺序 / listAdapterPendingAll IPC handler）+ Node 状态机复现 + 全 fix temp-revert 非空验证。
- 收口: R1→R2 两轮。**R1 异构高度收敛**：双方都抓 pushEvent cancel `[]` + renameSession 丢 fromId（severity 互换：claude MED/codex LOW 的 cancel；codex MED/claude LOW 的 rename），codex 独有 setPendingRequestsAll 死锁 MED + onHistorySelect seq LOW，claude 独有 async cancelled flag LOW + 3 INFO。R2 双方验证 4 fix 闭合 + **双方独立发现 moveEvents merge 排序倒挂 LOW**（Node repro：fromId 满 200 时 toId 最新事件被 slice 截掉）→ lead 修。R2 双方共识 conclude。

## 范围（批 H2）

renderer 顶层 state 管理 3 文件：

| 文件 | LOC | 处置 |
|---|---|---|
| App.tsx | 444→约 470 | **主审**：根组件 tab 路由 + ~10 useEffect event 订阅 + detailSession 派生 + stickySelected 缓存 |
| session-store.ts | 467→约 540 | **主审**：核心 zustand store（sessions Map + 7 张 by-session 衍生缓存 + pending×3 + renameSession 迁移 + upsertEvent tool-use 替换）|
| event-type-guards.ts | 66 | **主审**：纯 payload type guards（验证通过无 finding）|

## 收敛与裁决

### ✅ 单方提出 + lead 现场验证（must-fix MED）

**MED setPendingRequestsAll 启动全量快照整表替换抹掉 live pending → SDK 死锁（App.tsx:64 + session-store.ts:411 原始）** — reviewer-codex MED-1（lead 全路径验证）

App mount 先挂 useEventBridge（onAgentEvent 订阅，同步），再异步拉 listAdapterPendingAll；旧 `setPendingRequestsAll` `set(()=>new Map(snapshot))` 整表替换 3 张 pending Map。
- timeline（lead Read 验证）: t0 useEventBridge 订阅（use-event-bridge.ts:36）；t1 App effect 发 listAdapterPendingAll IPC（异步）；t2 IPC 在途期间 `waiting-for-user` live event 到达 → pushEvent 加 pending r1；t3 快照（main 端 listAllPending.ts:366 实时读，不含 r1 或 r1 的 session）resolve → 整表替换抹掉 r1 → chip 0 + 按钮不显示 → 用户授权不了 → **SDK await 死锁**。
- 危害高于 H1 stale-display（实际 SDK 死锁，需用户进 detail 触发单会话 listAdapterPending 才恢复）。
- 修法: 改 **merge**——mergeBucket 按 sid + requestId union（cur 优先保留 + 快照补 cur 没有的）；App effect 加 cancelled flag。union additive-only 不复活 stale（snapshot 实时读不含已 resolve；移除走独立 cancel event）。

### ✅ 双方独立提出（must-fix）

**MED renameSession M4 防御「toId 已存在则丢 fromId」整张丢弃 by-session 缓存（session-store.ts:431 原始）** — reviewer-codex MED-2 + reviewer-claude LOW（双方）

REVIEW_7 M4 对 sessions 主表「保较新 record」正确，但对 7 张 by-session Map 用同款 `if(!next.has(toId)) set` → toId 预先有一小段（CLI fork 后 realId 上先到一条 event/pending）时，**fromId 的 200 条 recentEvents/summaries/pending 被静默整张丢弃**（既不覆盖也不合并）。
- severity 裁决: codex MED / claude LOW（realId 几乎总是全新 id，toId 预存极罕见）→ lead 判 **merge 是正确行为，fix 不依赖可达性**。
- 修法: moveMapKey 拆 moveEvents/moveSummaries/moveLatest/movePending **merge**——events concat 后按 ts DESC 排序 + tool-use dedup + RECENT_LIMIT 截断 / summaries ts DESC / latest 取 ts 更新者 / pending union by requestId。sessions 主表保 M4。
- `fromId===toId` 入口已 return → delete(fromId) 后 get(toId) 无自删（双方验证）。

**LOW pushEvent 三处 cancel 分支 filter 后留 `[]` 空数组不删 key（session-store.ts:242 原始）** — reviewer-claude MED + reviewer-codex LOW（双方）

`*-cancelled` 事件 filter 最后一条后 `set(sessionId, [])` 留空数组，**从不 delete**，与同文件 resolvePermission(L366)/resolveAskQuestion/resolveExitPlanMode + setPendingRequests delete-on-empty **不对称**。
- severity 裁决: claude MED（前瞻 brittleness：未来 `.has()` 消费 false-positive）/ codex LOW（当前 selector `total===0 continue` 兜住，cosmetic + 内存微泄漏）→ lead 判 **LOW**（当前可达性 cosmetic，但 trivial fix + 消除约定不一致 + 防未来 footgun）。
- 修法: 三处 cancel 分支对齐 resolve*：`next.length===0 → delete` else set。

**LOW renameSession moveEvents merge 排序倒挂 + slice 截掉最新 toId 事件（session-store.ts concatEvents，R2 发现）** — 双方 R2 独立 + Node repro

R1 的 merge fix 引入：`concatEvents(v=fromId, existing=toId)` = `[旧块..., 新块...]`。但 recentEvents 数组是 **DESC[newest-first]**（pushEvent unshift / activity-feed 直接 map 不 re-sort）→ concat「旧在前」对 DESC 数组倒挂；更严重，fromId 若满 RECENT_LIMIT，`[...fromId(200), ...toId].slice(0,200)` 把 toId 最新事件**全截掉**。
- 双方独立 + Node repro（fromId 200 + toId ts 更大 → `containsNew:false`）。
- 自愈: SessionDetail 切到 toId 后 activity-feed listEvents(toId) 用 DB `ORDER BY ts DESC` 覆盖内存 → 近即时自愈 → LOW 非阻塞。
- 修法: concatEvents 合并后 `.sort((e1,e2)=>e2.ts-e1.ts)` 再 dedup 再 slice（与 moveSummaries 对齐，按 ts 排序后 slice 才保最新）。

### ✅ 单方提出（must-fix LOW）

**LOW onHistorySelect 无 seq guard，快速连点旧响应覆盖新选择（App.tsx:217 原始）** — reviewer-codex LOW-2（lead 采纳）

`getSession(id)` 无 request id / cancelled guard，快速点 A 再点 B、A 后 resolve → A 覆盖 B。
- 修法: 加 historySelectSeqRef 递增，then 内 `seq !== current` 丢弃旧响应。

**LOW 多个异步 IPC（getSettings/listAdapterPendingAll/getSession）无 cancelled flag（App.tsx）** — reviewer-claude LOW（lead 采纳）

App 根组件实战不 unmount，但 StrictMode dev 双 mount → promise resolve 后对已卸载实例 setState warn。
- 修法: getSettings/listAdapterPendingAll effect 加 cancelled flag（与 H1 同款）；onHistorySelect 由 seq guard 覆盖。

### ✅ INFO（已 fix / 文档化）

- **INFO moveSummaries 注释称「去重」但代码只 sort 无 dedup** — claude R2：from/to 不共享 summary record（按 sessionId 分键）实际无需 dedup → 注释改正为「concat 后按 ts DESC 排序（无共享 record 无需去重）」。
- **INFO togglePin vs onPinToggled 持久化不对称** — claude R1：验证无双写回环（按钮走 WindowSetAlwaysOnTop 不 emit PinToggled），正确，记录。
- **INFO onSessionFocusRequest createSession 极快返回时 focus 丢失** — claude R1：注释自述已知可接受边界，不改。
- **INFO event-type-guards 6 guard 严谨无缺口** — claude R1：验证通过，R3.E7 删 team-permission guard 正确。

### ✅ 验证通过未发现问题（深查项）

- setSessions prune 覆盖全 7 张 Map + selectedId 失效清空（双方）；upsertSession 不 prune 正确（单条 upsert 无需全表）；removeSession 7 张全清。
- upsertEvent tool-use-start/end in-place 替换边界（toolUseId 非空 string 守门 + start/end 各自 findIndex）正确。
- App useEffect deps：select/setPendingAll/setView 均 zustand/useState setter 稳定引用，deps 正确；onSessionRenamed historySessionRef 镜像避免 stale closure 正确（双订阅职责不重叠）。
- detailSession 派生兜底链（history: sessions.get??historySession / live: selectedFromMap??stickySelected）正确。
- merge 后 7 Map 与 sessions 主表 key orphan 风险 = pre-existing 结构（非本轮引入）+ selector `sessions.get` 取不到即 skip + setSessions prune 清除 → 无回归。
- TabButton badge `badge && badge>0 ? : null` 正确（badge=0 falsy 被三元兜住不渲染裸 0）。

## 修复清单

| # | 文件 | 严重度 | 修法 | 验证 |
|---|---|---|---|---|
| 1 | session-store.ts setPendingRequestsAll + App.tsx | MED | merge union 防整表替换抹 live pending（SDK 死锁）+ cancelled flag | codex + lead 全路径追踪 |
| 2 | session-store.ts renameSession | MED | moveMapKey 拆 4 merge helper（events/summaries/latest/pending）防丢 fromId | 双方 + lead |
| 3 | session-store.ts pushEvent cancel ×3 | LOW | delete-on-empty 对齐 resolve* | 双方 |
| 4 | session-store.ts concatEvents | LOW | merge 后 sort by ts DESC 防排序倒挂 + slice 截最新（R2）| 双方 R2 + Node repro |
| 5 | App.tsx onHistorySelect | LOW | seq guard 防连点旧响应覆盖 | codex |
| 6 | App.tsx getSettings/listAdapterPendingAll | LOW | cancelled flag | claude |
| 7 | session-store.ts moveSummaries 注释 | INFO | 注释改正（无 dedup 实为 concat+sort）| claude R2 |

## 测试

- **session-store.test.ts 新建 +8**：setPendingRequestsAll merge（live 先到保留 / union 去重 2）+ renameSession merge（toId 已有 events ts DESC 合并 / 常规迁移 / pending union / **fromId 满 200 toId 最新不被截** 4）+ pushEvent cancel delete-on-empty（删 key / 留其他 2）。
- **temp-revert 验证**：setPendingRequestsAll 整替 + renameSession 丢 fromId + pushEvent cancel set([]) → 3 FAIL（R1）；concatEvents 去 sort → 排序 + 截断 2 FAIL（R2）。全非空。
- typecheck 双配置绿；全项目 vitest **1257 passed / 210 skipped**（+8 from session-store.test.ts；skipped = SQLite 真测需 Electron binding，本批 renderer 不碰）。

## 异构对抗复盘

- **R1 高度收敛 + severity 互换**：双方都抓 pushEvent cancel + renameSession 丢 fromId 两条核心（severity 各异：cancel claude MED/codex LOW、rename codex MED/claude LOW），codex 独有 setPendingRequestsAll 死锁（最严重）+ onHistorySelect seq，claude 独有 async cancelled + 3 INFO。互补盲点：codex 偏「时序/死锁」，claude 偏「约定一致性/根组件 lifecycle」。
- **R2 双方独立发现同一新 LOW**：R1 merge fix 引入的 moveEvents 排序倒挂，双方 Node repro 收敛 → lead 修（sort by ts，align moveSummaries）。
- **lead severity 裁决**：cancel `[]` 与 rename 各有 MED/LOW 分歧 → 按「当前可达性 + 修法正确性」裁定（cancel 当前 cosmetic 定 LOW 仍修；rename merge 是正确行为定 fix 不论可达性）。
- **R2 双方共识 conclude**（claude「同意 conclude」+ codex「同意 conclude」+ 0 HIGH/0 MED 残留）。

## Batch H2 小结

renderer 顶层 state 管理：**1 MED + 5 LOW + 1 INFO = 7 fix**（codex 死锁 MED 是本批最严重）+ 8 回归 test。共性主题：**全量替换/迁移路径的合并语义不彻底**（pending 快照整替抹 live / rename 丢 fromId / merge 排序倒挂）+ 约定一致性（cancel delete-on-empty / async cancelled flag）。reviewer pair **dr-project-h-20260531**（claude 23fbf1ec / codex 019e7f4c）复用 dormant resume，R1→R2 两轮共识 conclude。
