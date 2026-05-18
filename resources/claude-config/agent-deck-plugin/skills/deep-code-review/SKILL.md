---
name: deep-code-review
description: ⚠️ 已重命名 → 请改用 `/agent-deck:deep-review`（plan codex-handoff-team-alignment-20260518 P6.7,2026-05-19）。本 SKILL 仅作 backward-compat stub，6 个月后版本移除。触发关键词「深度 code review」/「deep code review」/「double opposed review」沿用兼容。
---

# ⚠️ deep-code-review SKILL 已重命名 → `deep-review`

本 SKILL 已重命名为 `/agent-deck:deep-review`，请改用新名调用。新 SKILL 完全兼容老协议（同款 mcp__agent-deck__* tool 编排 + 三态裁决 + 多轮挖深）+ 加 typed scope `{kind: 'code' | 'plan' | 'mixed', paths: string[]}` + auto sandbox cp + manifest（详新 SKILL §Sandbox 处理 节）。

**老名仅保留作 deprecation pointer**，6 个月后版本移除。后续在 user CLAUDE.md / 4 reviewer body 中 cross-reference 已统一为 `/agent-deck:deep-review` 新名 + 加 P6.7 mv 注释。

## 立即迁移

把所有 `/agent-deck:deep-code-review` slash 调用改成 `/agent-deck:deep-review`：

```diff
- /agent-deck:deep-code-review
+ /agent-deck:deep-review
```

老的「深度 code review」/「deep code review」/「double opposed review」等自然语言触发关键词新 SKILL 完全兼容（详新 SKILL frontmatter description 触发关键词列表）。

## 历史

- **plan codex-handoff-team-alignment-20260518 P6.4 / P6.7（2026-05-19）**：原 SKILL `deep-code-review` 升级支持 plan / mixed review + auto sandbox cp，同步重命名为 `deep-review`（去掉 `code` 前缀更准确反映三种 kind 支持）。物理 mv + 加 deprecation stub。
