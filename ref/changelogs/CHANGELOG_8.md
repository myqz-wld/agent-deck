# CHANGELOG_8: SessionList/Detail 行为修复（sticky / 归档过滤 / cwd 缺省 / 集中 PendingTab）

## 概要

合并原 CHANGELOG_14（SessionDetail 不被「刷新跳转」回 SessionList）+ CHANGELOG_17（修归档会话仍出现在「实时」面板）+ CHANGELOG_23（新建会话 cwd 缺省回落用户主目录）+ CHANGELOG_40（集中「待处理」Tab + 抽 pending-rows + 按 session 批量响应）。一组 SessionList / SessionDetail 行为修复 + 待处理列表的集中重构。

## 变更内容

### SessionDetail 不被「刷新跳转」回 SessionList（原 CHANGELOG_14）

- 反复出现的体感 bug：用户在 SessionDetail 看会话偶尔被瞬时踢回 SessionList。场景：新建会话（NewSessionDialog `onCreated`）/ CLI（`onSessionFocusRequest`）/ header chip 跳转（`jumpToPending`）—— 这些路径同步调 `select(sid)` 把 `selectedSessionId` 立即置为新 id，但对应 `SessionRecord` 要等主进程 `session-upserted` 异步到达 renderer 才进 `sessions` Map → `selectedFromMap = sessions.get(...) ?? null` 在窗口内返 null → 三元跳到 SessionList → 几十 ms 后 upsert 到达又跳回 SessionDetail → 用户感知「啪一下闪」
- 修：`App.tsx` 新增 `stickySelected: SessionRecord | null` useState 缓存最近一次成功 get 到的 record；useEffect 维护规则（`selectedId === null` 清缓存；`selectedFromMap` 存在更新缓存；`selectedId` 有值但 `selectedFromMap === null` 不动缓存）；`detailSession = view === 'history' ? historySession : (selectedFromMap ?? stickySelected)`
- 修一处覆盖所有 select 入口；不动 store 接口

### 修归档会话仍出现在「实时」面板（原 CHANGELOG_17）

- `SessionList.tsx grouped` useMemo 只按 `lifecycle` 分组，没过滤 `archivedAt`。归档操作只打 `archived_at` 标记不动 lifecycle（CLAUDE.md 正交约定），归档后 `session-upserted` 推回 renderer 时 record 仍带原 lifecycle → 继续留在实时面板，要重启走 `setSessions(listActiveAndDormant)` 才消失
- `grouped` useMemo 在 `sort` 之前加 `.filter((s) => s.archivedAt === null)`；加注释指明与 CLAUDE.md「归档与 lifecycle 正交」对应

### 新建会话 cwd 缺省回落用户主目录（原 CHANGELOG_23）

- `NewSessionDialog.tsx`：标签 `工作目录 cwd *` 去掉 `*` 必填星号；placeholder 改为 `留空使用主目录 (~)`；删提交前校验；按钮 disabled 条件去掉 `!cwd.trim()`
- `ipc.ts AdapterCreateSession`：`o.cwd` 为空 / 仅空白 → 改写为 `homedir()`
- `cli.ts parseCliInvocation`：`--cwd` 缺省不再抛 `agent-deck new: 缺少 --cwd <path>`，改为 `homedir()` 兜底；wrapper 仍用 `$PWD`，这条兜底给「直接调 .app 二进制 / 第三方调用」场景

### 集中「待处理」Tab + 抽 pending-rows（原 CHANGELOG_40）

- 顶部导航新增第三个 tab「待处理」（与「实时」「历史」并列），把所有有未响应请求的会话按 section 平铺到一屏，用户在此直接响应不必逐个 SessionDetail 跳；CHANGELOG_6 那条 header chip 是这个 tab 的精简前身（只能跳第一个），现保留 chip 但行为改为「打开 PendingTab」
- 共享 selector：`session-selectors.ts` 新增 `selectPendingBuckets(sessions, perms, asks, exits)` —— 按会话聚合 pending，过滤口径与 `selectLiveSessions` 完全一致（`archivedAt === null && lifecycle ∈ {active, dormant}`）；`activity === 'waiting'` 优先；新增 `sumPendingBuckets(buckets)`
- 三个 Row 抽出：新文件 `src/renderer/components/pending-rows/index.tsx` 完整搬运 `PermissionRow` / `AskRow` / `ExitPlanRow` / `toolInputToDiff`（约 460 行，纯文件移动逻辑零改动）；ActivityFeed 反而瘦身
- `PendingTab.tsx`：纯派生视图。`PendingSection` header（StatusBadge + title + 「内/外」标签 + 总计 badge + 缩短 cwd），整行可点击跳详情；批量按钮「全部允许」（PermissionRequest allow + ExitPlanModeRequest approve）/「全部拒绝」（PermissionRequest deny + ExitPlanModeRequest keep-planning）；AskUserQuestion **不参与批量**（无答案的 deny 让 SDK 收到空 message 体验差）；按钮 `stopPropagation` 防冒泡触发跳转；`busy` 锁防连击
- `App.tsx`：`View` 加 `'pending'`；header chip 改为「打开待处理列表」；TabButton 列表加 badge 数字；main 渲染分支加 `view === 'pending' ? <PendingTab/> : ...`

## 备注

- CHANGELOG_8 这套修复对所有调用 `select(sid)` 入口都生效，调用方不需要 await `session-upserted`
- 跳回列表语义保持不变：只在 `selectedId` 显式置 null 时才跳回（`onClose`/`removeSession` 内部把 selectedId 设为 null）
- 「首条消息」仍必填 —— SDK streaming 协议约束，跟 cwd 是两回事
- 不做跨 session 批量响应：按 session 边界批量已够用，跨 session 一键容易误伤
- pending 入库时间戳（用 `session.lastEventAt` 兜底排序足够；如要精确属未来增强）
