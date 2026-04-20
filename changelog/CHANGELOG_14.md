# CHANGELOG_14: SessionDetail 不再被「刷新跳转」回 SessionList

## 概要

修一个反复出现的体感 bug：**用户在 SessionDetail 看会话时，偶尔会被瞬时踢回 SessionList**。具体场景：

- 新建会话（NewSessionDialog `onCreated`）/ CLI 命令行新建（`onSessionFocusRequest`）/ header「⚠ N 待处理」chip 跳转（`jumpToPending`）—— 这些路径都同步调 `select(sid)` 把 `selectedSessionId` 立刻置为新 id，但对应的 `SessionRecord` 要等主进程 `session-upserted` 经 `webContents.send` 异步到达 renderer 才会进 `sessions` Map
- App.tsx 的 detail 派生 `selectedFromMap = sessions.get(selectedId) ?? null` 在这个窗口里返回 null → `detailSession === null` → `{detailSession ? <SessionDetail/> : <SessionList/>}` 三元跳到 SessionList → 几十 ms 后 upsert 到达，重新派生 `selectedFromMap = newRecord` → 又跳回 SessionDetail
- 用户感知 = 「啪一下闪一下」/ 「刷新跳转」

## 变更内容

### `src/renderer/App.tsx`

- `selectedFromMap` 派生不变（保留 `sessions.get(selectedId)` 实时读 Map）
- 新增 `stickySelected: SessionRecord | null` useState 缓存最近一次成功 get 到的 record
- useEffect 维护规则：
  - `selectedId === null` → 清缓存（用户点返回 / 删除 → 应该跳回列表）
  - `selectedFromMap` 存在 → 更新缓存为最新 record
  - `selectedId` 有值 但 `selectedFromMap === null` → 不动缓存，等下次 `session-upserted` 把 record 灌进 Map 再更新
- `detailSession = view === 'history' ? historySession : (selectedFromMap ?? stickySelected)`
  - 实时模式下：sessions Map 短暂没数据时回退到缓存，用户看到的还是 detail，不会闪到 list

### 设计要点

- **修一处覆盖所有 select 入口**：`onCreated` / `onSessionFocusRequest` / `jumpToPending` / `SessionList.onSelect` 全都受益，不需要每个调用方各自 await session-upserted
- **跳回列表的语义保持不变**：只在 `selectedId` 显式置 null 时才跳回（`onClose` / `removeSession` 内部把 selectedId 设为 null），跟用户预期一致
- **不引入 stale 数据问题**：副作用就是 `selectedId` 从 A 切到 B 时，第一帧（B 还没 upsert）会显示缓存的 A —— 几十 ms 后 B 到达自动覆盖。比起闪到 list 再跳回 detail，stale 一帧更不容易被察觉
- **不动 store 接口**：`selectSession(id)` 仍然只接受 id，调用方不需要传 record；缓存逻辑限制在 App.tsx 一个组件内

## 备注

- README 不动：用户可见行为「在 detail 时不会被踢回 list」是 bug fix，不是新功能；功能描述不变
- 这个修复跟 CHANGELOG_10 的 SDK fallback `renameSession` 是不同 race —— 那个是 sessionId 真的变了（tempKey → realId），需要把 store 的 by-session 状态整体迁移；这个是 sessionId 不变（或者 select 一个新 id），sessions Map 短暂跟不上 selectedId 的变化
- 边界场景：用户在 history 视图选了 historySession（跟 selectedId 无关），切回 live 时仍按 selectedId/stickySelected 派生，行为正确（CHANGELOG_12 的 history 视图清理逻辑不变）
