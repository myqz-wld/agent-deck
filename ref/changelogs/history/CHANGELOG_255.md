# CHANGELOG_255: 最终 diff 改用会话记录文件快照

## 概要

最终 diff 不再读取当前 Git 工作区。文件改动入库时新增 best-effort `before_snapshot` / `after_snapshot`，后续「最终 diff」只比较会话记录里的首个 before 快照和最后一个 after 快照；历史记录缺少快照时退回已记录的 unified patch。

## 变更内容

- `file_changes` 表新增 `before_snapshot` / `after_snapshot`，写入时对文本文件记录完整 before/after 快照（单个快照上限 1MB）。
- Claude Edit / MultiEdit 通过当前 after 文件 + tool input 反推 before 快照；Codex 通过 unified diff + after 文件反推 before 快照，delete 记录用空 after 快照表示文件已删除。
- `getSessionFileFinalDiff` 删除 Git 调用和当前文件倒推逻辑，改为纯记录快照生成最终 diff；旧记录缺快照时保留 `metadata.diff` patch 兜底。
- SessionDetail 单次改动渲染优先使用记录快照，因此新 Codex 单次修改可直接走 Monaco before/after 路径；旧 Codex 记录继续用 unified diff 片段还原兜底。
- 抽出 shared unified diff 工具，renderer 和 main 共用解析逻辑。
- README Diff 渲染说明同步。

## 验证

- `pnpm vitest run src/main/session/__tests__/final-file-diff.test.ts src/main/session/__tests__/file-change-snapshots.test.ts src/renderer/components/diff/renderers/TextDiffRenderer.test.tsx`（16 passed）
- `pnpm typecheck`
- `git diff --check`
- `pnpm build`
