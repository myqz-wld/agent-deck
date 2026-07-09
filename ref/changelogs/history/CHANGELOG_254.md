# CHANGELOG_254: Codex unified diff 复用 Monaco 展示

## 概要

用户反馈 Codex 改动页里 unified diff 的展示样式和 Claude 侧不一致。根因是 Claude 会话通常有 `before_blob` / `after_blob` 快照，文本 renderer 会进入 Monaco DiffEditor；Codex app-server 与“最终 diff”路径只提供 `metadata.diff` 里的 unified patch，CHANGELOG_252 仅把它作为纯文本 `<pre>` 展示。

本次把可解析的 unified diff 还原成临时 before/after 片段，复用同一套 Monaco DiffEditor 样式；解析不了的 binary/rename patch 仍显示原始 patch 文本。

## 变更内容

- `TextDiffRenderer`：新增 unified diff snapshot 还原逻辑；meta-only 文本 diff 若解析成功，走和 Claude before/after 快照相同的 Monaco DiffEditor。
- 保留兜底：无 hunk 的 binary/rename patch 继续按纯文本显示，避免空白。
- `TextDiffRenderer.test.tsx`：覆盖裸 hunk、带 git header 的 hunk、不可解析 patch fallback，以及 Codex metadata diff 进入 Monaco 路径。
- `README.md`：Diff 渲染说明改为 Codex / 最终 diff 会优先复用 Monaco，解析失败才显示原文。

## 验证

- `pnpm vitest run src/renderer/components/diff/renderers/TextDiffRenderer.test.tsx` 通过（8 tests）。
- `pnpm typecheck` 通过。
- `pnpm build` 通过。
