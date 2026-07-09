# CHANGELOG_252: 改动页展示 Codex unified diff 与文件最终 diff

## 概要

Codex app-server 的 `fileChange.changes[].diff` 已经随 `file-changed` 事件保存到 `file_changes.metadata_json.diff`，但改动页只读取 `before_blob` / `after_blob`，导致 Codex 会话显示“仅记录路径”。现在文本 diff renderer 在缺少 before/after 快照但存在 unified diff 时直接展示 patch 内容；同时改动页新增“单次改动 / 最终 diff”切换，优先按当前 Git 工作区计算选中文件相对 `HEAD` 的最终 diff，Git 不可用时退化为会话记录 + 当前文件快照还原。

## 变更内容

- `TextDiffRenderer`：meta-only 改动优先读取 `metadata.diff` 并显示 unified diff；只有 diff 为空时才显示兜底提示。
- 新增 `SessionGetFileFinalDiff` IPC：主进程校验文件属于当前 session 的 `file_changes` 后，只读执行 `git diff HEAD -- <file>`；未跟踪新文件走 `git diff --no-index /dev/null <file>`；Git 不可用 / 非 Git 目录 / Git diff 失败时，尝试读取当前文件并按文本 `file_changes` 反向还原会话起点，生成 fallback unified diff。
- fallback 边界：仅处理文本记录；无法从快照还原时，如果记录里有 `metadata.diff`，展示记录 patch；仍无数据则显示明确失败原因。
- `SessionDetail` 改动页：新增“单次改动 / 最终 diff”切换；最终 diff 使用主进程返回的 unified diff 渲染。
- `TextDiffRenderer.test.tsx`：覆盖 diff metadata 展示、空 diff 兜底和旧 `changeKind` object 兼容。
- `README.md`：Diff 渲染说明补充 Codex unified diff 展示路径。

## 验证

- `pnpm vitest run src/main/session/__tests__/final-file-diff.test.ts src/renderer/components/diff/renderers/TextDiffRenderer.test.tsx src/renderer/components/SessionDetail/__tests__/helpers.test.ts` 通过。
- `pnpm typecheck` 通过。
- `pnpm build` 通过。
