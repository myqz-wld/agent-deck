# CHANGELOG_40: 集中「待处理」Tab + 三个 Row 抽到 pending-rows + 按 session 批量响应

## 概要

顶部导航新增第三个 tab「待处理」（与「实时」「历史」并列），把所有有未响应请求（permission / ask-user-question / exit-plan-mode）的会话按 section 平铺到一屏，用户在此直接响应，不必逐个 SessionDetail 跳。CHANGELOG_10 那条 header「⚠ N 待处理」chip 是这个 tab 的精简前身（只能跳第一个），本次保留 chip 但行为改为「打开 PendingTab」，多个待处理终于能一眼看全。每个 section 自带「全部允许 / 全部拒绝」批量按钮（仅作用于权限请求 + ExitPlanMode，AskUserQuestion 必须人审具体选项不参与批量）。

为复用 ActivityFeed 的 `PermissionRow` / `AskRow` / `ExitPlanRow`（含 Monaco diff、选项、markdown），把这三个组件 + `toolInputToDiff` helper 从 ActivityFeed 抽到新文件 `src/renderer/components/pending-rows/index.tsx`，PendingTab 与 ActivityFeed 共用同一份实现，diff 就是「搬家」（逻辑零改动）；ActivityFeed 反而瘦身约 460 行。

## 变更内容

### 共享 selector（src/renderer/lib/session-selectors.ts）
- 新增 `selectPendingBuckets(sessions, perms, asks, exits)`：按会话聚合 pending，过滤口径与 `selectLiveSessions` 完全一致（`archivedAt === null && lifecycle ∈ {active, dormant}`），避免「实时面板看不到这条会话但待处理还显示」的口径分裂；归档会话即便 sdk-bridge 还在等也不在面板里骚扰用户（CHANGELOG_31「不主动弹通知」语义延伸）
- 排序：`activity === 'waiting'` 优先（卡在等用户的排顶），再按 `lastEventAt` 倒序
- 新增 `sumPendingBuckets(buckets)` helper：让 header chip 与 PendingTab 走同一份计数口径，避免 chip 显示「3 待处理」但 tab 里只看到 2 条的认知矛盾（如 pending 落在已归档会话上）

### 三个 Row 抽出（src/renderer/components/pending-rows/index.tsx）
- 新文件，从 `ActivityFeed.tsx` 完整搬运：`PermissionRow` / `AskRow` / `ExitPlanRow` / `toolInputToDiff`
- 三个 Row 改为 named export；`toolInputToDiff` 也 export（`ToolStartRow` 渲染 Edit/Write/MultiEdit 内嵌 diff 时仍要用，必须共享）
- 三个 Row 接口 / 行为 / 视觉 / 三态（等待中 / 已响应 / 已被 SDK 取消）逻辑零改动，是纯文件移动

### ActivityFeed 瘦身（src/renderer/components/ActivityFeed.tsx）
- 删除原内联的 `PermissionRow` / `AskRow` / `ExitPlanRow` / `toolInputToDiff`（共约 460 行）
- 顶部加 `import { AskRow, ExitPlanRow, PermissionRow, toolInputToDiff } from './pending-rows'`
- 同步删除已不再用的 `AskUserQuestionItem` / `DiffPayload` / `ImageSource` type import
- `ActivityRow` 派遣逻辑、`SimpleRow`、`MessageBubble`、`ToolStartRow`、`ToolEndRow`、`describe` / `describeToolInput` / `formatToolResult` / `parseImageReadResult` 全部保留

### 新「待处理」面板（src/renderer/components/PendingTab.tsx）
- 新文件，纯派生视图；从 store 拿 sessions + 三张 pending Map + 三个 resolveX 方法
- `useMemo` 调 `selectPendingBuckets` 聚合，每个 bucket 渲染一个 `<PendingSection>`
- **PendingSection header**：StatusBadge（activity/lifecycle/archived）+ 会话 title + 「内/外」标签（`session.source === 'sdk' ? '内' : '外'`）+ 总计 badge + 缩短的 cwd（>4 段时只保留最后 3 段）；header 整行可点击调 `onOpenSession(sid)` 跳到 SessionDetail，右侧用 `›` 字符做视觉提示
- **PendingSection 批量按钮**：「全部允许」串行响应所有 PermissionRequest（allow + 原 toolInput）+ ExitPlanModeRequest（approve）；「全部拒绝」串行响应 PermissionRequest（deny + 「用户批量拒绝」message）+ ExitPlanModeRequest（keep-planning）；AskUserQuestion 不参与批量（无答案的 deny 会让 SDK 收到空 message，体验差，必须逐条人审）；按钮区 `onClick={(e) => e.stopPropagation()}` 防冒泡触发跳转；`busy` 锁防连击；外部 CLI 会话 / 仅剩 ask 类型时按钮 disabled，tooltip 明确说明
- **复用三个 Row**：永远 `stillPending=true`（来源就是当前 pending Map）+ `wasCancelled=false`（取消事件已让 store 删 Map 项）；`event` 用占位构造（仅 Row 内部 `event.ts` 显示时间，用 `session.lastEventAt` 兜底）
- **空态**：「暂无待处理」+ 简短说明（不引入跳转 / 通知）
- 每条响应后 `resolveX` 同步删 store，下一帧 useMemo 重算让 row 逐条消失（动画感）；section total=0 后整个 section 自动消失

### App.tsx 接入（src/renderer/App.tsx）
- `View` 类型 `'live' | 'history'` → `'live' | 'history' | 'pending'`
- import 新增 `PendingTab` / `selectPendingBuckets` / `sumPendingBuckets`
- pending 计数 `useMemo` 改用 `sumPendingBuckets(selectPendingBuckets(...))`，与 PendingTab 共享口径；返回 number 取代之前的 `{ total, firstSid }`（不再需要"第一个 sid"）；deps 加 `sessions`
- `jumpToPending` 行为变更：`if (pending === 0) return; setView('pending'); select(null);` —— 切到新 tab 而非跳第一个会话；必须 `select(null)`，否则 `detailSession` 优先级会盖住 PendingTab（main 区域是 `detailSession ? <SessionDetail/> : view 分支`）
- header chip 文案：title 「跳到首个有未响应请求的会话」→「打开待处理列表」；显示由 `pending.total` → `pending`
- TabButton 列表：在「实时」和「历史」之间插入「待处理」并传 `badge={pending > 0 ? pending : undefined}`
- main 渲染分支：在 `view === 'live'` 后加 `view === 'pending' ? <PendingTab onOpenSession={(sid) => { setView('live'); select(sid); }} /> :` 分支
- `TabButton` 组件：增加可选 `badge?: number` prop，`badge && badge > 0` 时在文字右侧渲染小数字徽标（status-waiting 配色）
- CLI 路径 (`onSessionFocusRequest`) / `NewSessionDialog.onCreated` 不动，仍切「实时」+ select

## 不动 / 不实现的事

- session-store.ts（三张 pending Map / `resolveX` / `setPendingRequestsAll` 已现成；dead code `view`/`setView` 不删，与本需求无关）
- 后端：sdk-bridge.ts / ipc.ts / shared/ipc-channels.ts（`listAllPending` / `respondX` 已全套现成）
- schema / 数据库
- 通知行为（CHANGELOG_31）：PendingTab 切换 / 打开不弹通知 / 提示音
- SessionDetail.tsx（Row 抽出对它透明）
- 跨 session 批量（按 session 边界批量已够用，跨 session 一键容易误伤）
- AskUserQuestion 批量响应（无答案的 deny 体验差）
- 批量 confirm 弹窗（按钮文案明确 + busy 锁防连击足够）
- 快捷键（现有只有 Cmd+Alt+P，加多了反而难记）
- pending 入库时间戳（用 `session.lastEventAt` 兜底排序足够；如要精确属未来增强）
- chip 视觉（仅改 onClick + tooltip 文案）

## 验证

```bash
pnpm typecheck   # 通过
pnpm build       # 大改动跑
```

手动验证（renderer-only 改动，HMR 自动推送，无需 `pnpm dev` 重启）：

| # | 操作 | 预期 |
|---|---|---|
| 1 | SDK 会话触发 Edit/Write | header chip 与「待处理」tab badge 同时 = 1 |
| 2 | 点 chip | 切到「待处理」tab，看到该 session 的 PermissionRow（带 Monaco diff） |
| 3 | tab 内点「允许本次」 | row 消失；section total=0 后整体消失；chip / badge 同步 -1 |
| 4 | 触发 AskUserQuestion / ExitPlanMode | 各自渲染 AskRow / ExitPlanRow，按钮可用 |
| 5 | 点 PendingSection header（非按钮区） | 切「实时」+ 进入该会话 SessionDetail |
| 6 | 归档有 pending 的会话 | section 立刻消失，chip / badge 同步 -N |
| 7 | 多会话同时 pending | 多 section，waiting 优先 + lastEventAt 倒序 |
| 8 | SDK 自己 cancel 一条 pending | 对应 row 消失，**不弹通知**（CHANGELOG_31 约定保持） |
| 9 | 外部 CLI 会话产生 pending | section 显示，三个 Row 内置 isSdk 守卫禁用按钮；批量按钮也 disabled |
| 10 | renderer HMR 重 mount | 立刻渲染最新（App.tsx 启动时 `setPendingAll` 已铺好底） |
| 11 | 一个 session 挂 3 个权限 + 1 个 ExitPlan + 1 个 AskUser，点「全部允许」 | 4 个 row 逐条消失，AskUser row 保留 |
| 12 | 同场景点「全部拒绝」 | 3 个权限 deny + 1 个 ExitPlan keep-planning，AskUser 保留 |
| 13 | 仅剩 AskUser 的 section | 批量按钮 disabled + tooltip「仅剩 AskUserQuestion，请逐条作答」 |
| 14 | 点击批量按钮区域 | **不会**触发 onOpenSession（stopPropagation 生效） |
| 15 | 批量按钮 busy 期间快速连点 | disabled，不会发出第二轮请求 |

回归验证（关键点）：迁移 Row 后必须验证 SessionDetail 的活动流不受影响 —— 旧会话历史 Permission/Ask/Exit 行的「等待中 / 已响应 / 已被 SDK 取消」三态正常、Edit/Write 的 Monaco diff 正常、AskRow multiSelect / 自由输入 / 提交正常、ExitPlanRow markdown / 反馈框正常、ToolStartRow 的 Edit/Write/MultiEdit 内嵌 diff 正常（依赖被搬出去的 `toolInputToDiff`）。
