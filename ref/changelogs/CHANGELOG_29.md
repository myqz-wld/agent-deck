# CHANGELOG_29: HistoryPanel 周边微调（rename / unarchive 体验闭环）

## 概要

CHANGELOG_24-28 把「断连自愈 + CLI fork 兜底」主链路落地后，4 个微调 commits 把 history view 与 live view 之间的过渡闭环：archived 会话发消息自动 unarchive、HistoryPanel 监听 rename/upsert 自动 reload、列表加「内/外」标签预判能否继续聊、rename 后从 history view 自动切到 live view。本份 changelog 为事后补（4 个 commits 当时未单独建文件，REVIEW_7 触发补齐）。

## 变更内容

### rename 后自动切 live view（9dd4698）

**`src/renderer/App.tsx` onSessionRenamed listener**

- 之前：rename 触发后 `historySession` 本地 state 不动，detail 卡在 history view 但 `selectedSessionId` 已被 `store.renameSession` 切到 NEW_ID
- 之后：listener 内 `setView('live')` + `select(to)` + 清 `historySession`，体感「我点的会话被自动放到实时面板继续聊」
- 符合 CLAUDE.md「凡让用户感觉像新开会话 / 跳回列表都是 bug」总纲

### HistoryPanel 列表行加「内/外」标签（e34cb3e）

**`src/renderer/components/HistoryPanel.tsx` 列表项 SourceBadge**

- 与 `SessionCard` / `SessionDetail.SourceBadge` 风格一致
- SDK = 内（emerald 绿，可在 detail 里继续聊）；其他 source = 外（灰，CLI 只读 `CliFooter`）
- 用户在历史列表里就能预判这条点进去能否继续聊

### HistoryPanel 监听 rename / upsert 自动 reload（93dac34）

**`src/renderer/components/HistoryPanel.tsx` 新增 listener useEffect**

- 触发场景：CHANGELOG_27/28 fork 兜底走 `sessionManager.renameSdkSession` 把 OLD_ID record 删除（DB 内）+ 子表迁到 NEW_ID（lifecycle=active 不在 history 视图），`HistoryPanel.rows` 缓存的旧 OLD_ID record 需 reload 才能消失
- 否则用户体感「会话明明已经在实时聊上了，但历史列表里还有」
- debounce 200ms 避免 event burst 时多次 reload；用 `useRef` 持有定时器，每次新事件来重置

### recoverAndSend archived 自动 unarchive（c182377）

**`src/main/adapters/claude-code/sdk-bridge.ts:614-621`**

- 用户在 detail 里主动发消息触发 `recoverAndSend` = 显式表达「我又要聊它了」
- 入口检测 `rec.archivedAt !== null` → `sessionManager.unarchive(sessionId)`，emit `session-upserted` 触发 HistoryPanel reload 把这条从历史列表移除
- `manager.ts:118-121` 立的「归档与 lifecycle 正交，不能因事件流自动 unarchive」约束针对的是 hook 触发的事件流（避免外部 CLI 在同 cwd 跑时用户刚归档的会话被自动恢复），本路径是用户显式 UI 动作不冲突

## 备注

- CHANGELOG_29 为事后补；4 个微调 commits 当时未建独立 changelog，REVIEW_7 触发补齐
- 关联 [REVIEW_7.md](../reviews/REVIEW_7.md)：本批微调 + CHANGELOG_24-28 主链路的整体复审（1 HIGH + 4 MED + 4 LOW，CHANGELOG_30 落地修复）
