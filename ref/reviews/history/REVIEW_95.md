# REVIEW_95 — 全项目 deep review 批 H3：SessionDetail subsystem（Batch H 收官）

- 日期: 2026-06-01
- 类型: 功能 BUG（cancelToast auto-dismiss 失效 + 跨会话残留 / ComposerSdk closed 会话安全下拉显示更宽松 / listFileChanges reject 全屏 fatal / 同毫秒 file change 选旧 row / file-changes 重订阅吞节流 timer / diffError re-sync 失败抹掉已加载 diff）+ a11y（SelectRow label 关联）+ 代码优化（helpers 抽离 + 冗余 guard）+ 文案（confirm 全角标点）（全项目 deep review 第二十五批，Batch H 子批 H3，SessionDetail 子系统，**Batch H 收官**）
- 触发: 用户「deep review 下项目，聚焦功能 BUG / 代码优化 / 文字措辞优化，自主一路推进 + 自主 hand off」授权（plan deep-review-project-20260531）
- 关联: plan deep-review-project-20260531 / REVIEW_93（H1 issue 组件）/ REVIEW_94（H2 renderer core）/ REVIEW_2/35（SessionDetail 历史 finding 独立复验成立）/ CHANGELOG_26/74/94/100/105（断连恢复 / claude sandbox / hand-off / 跨会话 message / ComposerSdk 拆分）
- 方法: 多轮异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5，**复用 H pair dr-project-h-20260531 dormant resume**，保留 H1/H2 renderer mental model）+ 三态裁决 + lead Read/Grep + IPC handler 追踪 + manager.list scope 验证 + Node 状态机复现 + 全 fix temp-revert 非空验证。
- 收口: R1→R2 两轮。**R1 异构高度互补**：codex 押「IPC reject / 同毫秒 / a11y」（1 MED + 3 LOW），claude 押「状态机生命周期 / 双源」（2 MED + 2 LOW + 3 INFO），cancelToasts 双方都抓（codex LOW / claude MED-1，claude 多挖一处跨会话残留）。R2 双方验证 7 fix 全闭合 + claude 新挖 1 LOW（diffError 渲染优先级与 MessagesPanel 不一致——**fix 注释自称同款但守门不同款**，lead 自身 flag 违反）→ lead 修。R2 双方共识 conclude。

## 范围（批 H3）

SessionDetail 子系统 10 文件（Batch H 收官）：

| 文件 | LOC | 处置 |
|---|---|---|
| index.tsx | 353→约 400 | **主审**：5 tab 路由 + file-changes 加载/订阅 seq counter + diff 分组 + cancelToasts |
| ComposerSdk.tsx | 411 | **主审**：SDK 输入区 + permission/sandbox 三冷切 + 图片附件 + send 双锁 |
| MessagesPanel.tsx | 137 | **主审**：跨会话消息 tab（验证通过，反作为 diffError 守门对照基准）|
| ChangeTimeline.tsx / helpers.ts / CliFooter.tsx / SourceBadge.tsx | 55/37→约90/9/19 | **主审**：helpers 抽 groupFileChanges/pickLatestChange |
| composer-sdk/SandboxSelects.tsx / ErrorBanner.tsx / ImageIcon.tsx | 70/37/26 | **主审**：SelectRow a11y fix |

## 收敛与裁决

### ✅ 双方提出（must-fix）

**MED cancelToasts 生命周期双重破损：auto-dismiss 失效 + 跨会话残留（index.tsx:43/65-99 原始）** — reviewer-claude MED-1 + reviewer-codex LOW（双方，claude 多挖跨会话残留）

① **auto-dismiss 失效**：`upsertEvent`（session-store.ts:104-121）每条事件返回新数组 → `recent` 每条事件换引用 → `[recent]` effect 每条事件 cleanup+重跑。序列：cancel 事件 C 到达设 timerC + `return clearTimeout(timerC)`；任意后续事件 N 到达 → React 先跑 cleanup 杀 timerC → effect 重跑 recent[0]=N 非 cancel `return` 不设新 timer → **toast 永不 auto-dismiss**（活跃会话取消后必有后续活动，必踩）。
② **跨会话残留**：`<SessionDetail session={detailSession}/>`（App.tsx:338）**无 key prop**（lead 验证）→ 切会话不 remount，cancelToasts useState 跨会话存活；`[session.id]` reset effect 只清 tab/changes/selected **不清 cancelToasts** → 切到会话 B 时 A 的 toast 仍挂。
- codex Node repro `timerActiveAfterNextEvent: false` 证 ①。
- 修法: timer 移 `toastTimersRef` Map（不绑 [recent] cleanup）——检测 effect 只加 toast + 注册 timer；timer fire 自删 / 手动 dismissToast 清 / `[session.id]` reset 清空 toast+timer / unmount 清所有 timer 四路径齐全。

### ✅ 单方提出 + lead 现场验证（must-fix MED）

**MED ComposerSdk 双源读：closed 会话丢失 permission/sandbox 持久值，安全下拉显示更宽松（ComposerSdk.tsx:59 原始）** — reviewer-claude MED-2（lead manager.list scope 验证）

ComposerSdk 自己 `useSessionStore(s=>s.sessions.get(sessionId))` 重读 store，无视 parent 传的 session prop。
- lead 验证: `manager.list() = listActiveAndDormant()`（manager.ts:441）→ **closed 会话不在 renderer sessions Map**。history 视图开 closed SDK 会话：parent `detailSession = sessions.get(id) ?? historySession` = historySession（getSession 全量带真值）；但 ComposerSdk 自读 `sessions.get` = undefined → 三下拉全落 fallback。**反向危险**：真实 `claudeCodeSandbox='strict'`（最安全）→ 显示 `'off'`（最危险档）。
- severity: display-only + 首次 resume 后 session-upserted 自愈 → claude 标 MED 请裁；lead 判 **fix**（安全相关显示 + focus-1 明确点名双源一致性）。
- 修法: ComposerSdk 改接收 parent `session` prop（对 closed 经 historySession 更准），删自读 store + useSessionStore import。claude grep 确认无 React.memo 阻断 prop 反应链。

### ✅ 单方提出（must-fix MED）

**MED listFileChanges reject 冒泡全屏 fatal（index.tsx:116 原始）** — reviewer-codex MED（lead handler 验证）

diff tab `sync()` 只挂 `.then` 无 `.catch`。lead 验证 handler（sessions.ts:33 `fileChangeRepo.listForSession(parseStringId(...))`）可 reject → renderer unhandledrejection → main.tsx:70-85 showFatal 全屏遮挡。MessagesPanel 同类 IPC 已有 catch，这里是缺口（**H1/H2 同款 .catch 缺失主题第三次**）。
- 修法: sync 加 `.catch`（复用 disposed||cur!==req guard）→ diffError state。渲染对齐 MessagesPanel（changes===null 才整屏 error，有数据 re-sync 失败 inline strip 保留 stale，见 R2 LOW）。

### ✅ 双方 / 单方 LOW（已 fix）

- **LOW 同毫秒同文件改动选旧 row 当「最新」（index.tsx fileGroups + sync latest）** — codex + Node repro（**同毫秒 tiebreaker 主题第五批**，前 G2/G3/G4/E2 在 SQL，此处 renderer）：组内仅 `a.ts-b.ts` 稳定排序 + `items[length-1]` 取最新 → 同 ts 顺序不定可能选旧 row（DB 端 `ts DESC, id DESC` 新 id 在前）。修法: 抽 `groupFileChanges`/`pickLatestChange` 到 helpers.ts，组内 `(a.ts-b.ts)||(a.id-b.id)` 升序、组间 `lastTs||lastId` 倒序、latest `(b.ts-a.ts)||(b.id-a.id)`。
- **LOW file-changes hasLoaded 重订阅吞在途节流 timer（index.tsx:141 原始）** — claude（lead trace）：`hasLoaded=changes!==null` 入 effect deps → 首次 sync setChanges 后 false→true 重订阅，cleanup `clearTimeout` 杀掉 sync 在途期间 file-changed 设的 300ms timer → 那条刷新被吞。修法: deps 去 hasLoaded，改 `changesLoadedRef` 读最新 → 订阅在首加载前后稳定。
- **LOW SelectRow label 未关联控件（SandboxSelects.tsx:30）** — codex（claude R1 误判 OK，codex 正确）：label 是裸 `<span>`，select 无 id/aria-label。修法: useId + `<label htmlFor={id}>` + `<select id={id}>`。
- **LOW（R2 新发现）diffError 渲染优先级与 MessagesPanel 不一致（index.tsx:310 R1 修法）** — claude R2（lead 自验，fix 注释自称同款但守门不同款）：R1 `diffError ? ... : changes===null ?` 无条件优先 error → 后台 re-sync 失败抹掉已加载 diff（MessagesPanel `error && messages.length===0` 保留 stale）。修法: 改 `changes===null` 才整屏 error，有数据时 inline strip 保留 stale + 提示（注释订正为真同款）。

### ✅ INFO（已 fix / 文档化）

- **INFO 冗余 guard（ComposerSdk 3 处 change*）** — claude：`if(next==='X' && permissionMode!=='X')` 外层已 `next!==permissionMode` early-return → 内层恒真。修法: 简化为 `next==='X'`。
- **INFO confirm detail 半角逗号/问号** — claude：用户可见安全文案半角 `,`/`?` → 全角 `，`/`？`（3 处 confirm）。
- **INFO cancelToast post-expiry 窄复活（自愈）** — claude R2：timer fire 后若该 cancel 仍 recent[0]（5s 静默）+ 紧跟 in-place tool-use 更新 → toast 复活再挂 5s timer。极窄 + 自愈 → 文档化不修。
- **INFO 冷切 confirm stale closure（不可达）** — claude R1 *未验证*：confirmDialog 是 window-modal（showMessageBox attach 父窗）→ 弹窗期间 select 不可点 → 双发不可达。文档化不修。

### ✅ 验证通过未发现问题（深查项）

图片附件 snapshot→clear 顺序（toIpcInputs try/catch throw 不清图）/ busyRef+busy 双锁 / MessagesPanel req+disposed+200ms 节流（反为 diffError 守门对照基准）/ decodeBlob JSON.parse 边界 / 各 list key / button type / SelectRow generic —— 全 OK。

## 修复清单

| # | 文件 | 严重度 | 修法 | 验证 |
|---|---|---|---|---|
| 1 | index.tsx cancelToasts | MED | timer ref registry + 四路径清理 + reset 清空 | 双方 + codex Node repro + lead key 验证 |
| 2 | ComposerSdk.tsx | MED | 接 parent session prop 不自读 store | claude + lead manager.list scope |
| 3 | index.tsx listFileChanges | MED | .catch → diffError 内联 | codex + lead handler 验证 |
| 4 | helpers.ts + index.tsx | LOW | 抽 groupFileChanges/pickLatestChange + id tiebreaker | codex + Node repro |
| 5 | index.tsx file-changes effect | LOW | hasLoaded → changesLoadedRef 稳定订阅 | claude + lead trace |
| 6 | SandboxSelects.tsx | LOW | SelectRow useId + label htmlFor | codex |
| 7 | index.tsx diffError 渲染（R2）| LOW | changes===null 才整屏 + inline strip 保留 stale | claude R2 + lead 自验 |
| 8 | ComposerSdk.tsx | INFO | 冗余 guard 简化 + confirm 全角标点 | claude |

## 测试

- **helpers.test.ts 新建 +12**：decodeBlob 4（image/非法 JSON/null/text）+ fileKindLabel 2 + pickLatestChange 3（空/不同 ts/同毫秒 id tiebreaker）+ groupFileChanges 3（分组升序/组内同毫秒 id 升序 items[last] 真最新/组间 lastTs+lastId 倒序）。
- **temp-revert 验证**：groupFileChanges/pickLatestChange 去 `||id` tiebreaker → 2 FAIL（组内 + 组间排序）。非空。
- 其余 fix（cancelToasts timer / ComposerSdk prop / listFileChanges catch / hasLoaded ref / diffError 渲染）React-effect 绑定，项目无 RTL setup → 由 lead source-trace + 双 reviewer code-trace 验证（非 unit test 覆盖）。
- typecheck 双配置绿；全项目 vitest **1269 passed / 210 skipped**（+12 helpers；skipped = SQLite 真测需 Electron binding，本批不碰）。

## 异构对抗复盘

- **R1 高度互补**：codex 偏「IPC reject / 同毫秒 / a11y 控件语义」（外部边界），claude 偏「状态机生命周期 / 双源一致性」（内部时序）。cancelToasts 双方都抓但 claude 多挖跨会话残留（key 缺失），且 claude 把 codex 判 OK 的 SelectRow a11y... 实为 codex 对、claude R1 误判 OK（异构互补纠偏）。
- **R2 claude 自查 lead 的 fix flag**：R1 我修 listFileChanges 时注释自称「与 MessagesPanel 同款收口」，claude R2 发现守门实际不同款（无条件 error vs 保留 stale）→ lead 修正对齐（自身 flag 违反，1 行成本）。异构 review 连「fix 注释与实现一致性」都覆盖。
- **R2 双方共识 conclude**（codex 0 finding + claude 0 HIGH/0 MED + 1 LOW 已修）。

## Batch H3 小结

SessionDetail 子系统：**3 MED + 5 LOW + 2 INFO inline = 10 fix** + 12 回归 test。共性主题：**状态机生命周期 / 异步边界处理不彻底**（toast timer 绑错 dep / IPC reject 无 catch / closed 会话双源 / 重订阅吞 timer / re-sync 抹 stale）+ 同毫秒 tiebreaker（renderer 侧第五批）+ a11y/文案补强。reviewer pair **dr-project-h-20260531**（claude 23fbf1ec / codex 019e7f4c）复用 dormant resume，R1→R2 两轮共识 conclude。

## Batch H 全收官

H1（issue 组件 REVIEW_93，1 HIGH + 4 MED + 4 LOW + 2 INFO）+ H2（renderer core REVIEW_94，1 MED + 5 LOW + 1 INFO）+ H3（SessionDetail REVIEW_95，3 MED + 5 LOW + 2 INFO）= **1 HIGH + 8 MED + 14 LOW + 5 INFO = 28 fix** + 33 回归 test（issue-detail 7 + issues-store 6 + session-store 8 + helpers 12）+ 1 反驳轮 + 1 Follow-up（#15 same-ms repo 单调 revision）。renderer 层共性主题：**异步边界（IPC reject 无 catch ×3 子批 / fetch×event 时序竞态 / 全量替换抹 live state）+ 同毫秒 tiebreaker + a11y label 关联 + 安全文案**。同一对 fresh→dormant-resume reviewer pair 贯穿 H1-H3 复用 mental model。
