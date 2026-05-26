# CHANGELOG_147 — 实时 / 历史空态布局居中对齐待处理 / 团队

## 概要

修复实时面板空态文案靠上、历史面板空态（含 loading 态）靠左上的视觉不一致，统一为与待处理（PendingTab）/ 团队（TeamHub）同款的「纵横居中」布局。

## 变更内容

- **改** `src/renderer/components/SessionList.tsx`（实时面板）空态根 div 加 `h-full`（父容器是 `h-full overflow-y-auto`，子撑满即可纵向居中）
- **改** `src/renderer/components/HistoryPanel.tsx` loading + 空态两个文本节点从裸 `<div className="text-[11px] text-deck-muted">` 包成 `flex h-full items-center justify-center` 同款居中
