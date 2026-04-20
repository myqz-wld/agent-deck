# CHANGELOG_17: 修复归档会话仍出现在「实时」面板

## 概要

`SessionList` 的 grouping 只按 `lifecycle` 分组，没有过滤 `archivedAt`。由于归档与 lifecycle 正交（归档操作只打 `archived_at` 标记、不动 lifecycle，详见 CLAUDE.md），在当前会话内点「归档」后，主进程 emit 的 `session-upserted` 推回 renderer 时 record 仍带原 lifecycle（active / dormant），于是它继续留在实时面板里，要重启走 `setSessions(listActiveAndDormant)` 才会消失。

## 变更内容

### src/renderer/components/SessionList.tsx
- `grouped` useMemo 在 `sort` 之前加 `.filter((s) => s.archivedAt === null)`，保证实时面板只展示「未归档的 active/dormant」
- 加注释指明这条过滤与 CLAUDE.md 中「归档与 lifecycle 正交」的约定一一对应，避免后续重构时被误删
