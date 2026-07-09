# CHANGELOG_208

## Review SKILL 五级严重度与合入 gate

### 概要

本次把 `simple-review` / `deep-review` 从旧 `HIGH / MED / LOW / INFO` 口径升级为 `CRITICAL (P0)` / `HIGH (P1)` / `MEDIUM (P2)` / `LOW (P3)` / `INFO (P4)` 五级严重度。CRITICAL/HIGH 必须有反驳论，且只有 0 CRITICAL/HIGH 时才允许合入；MEDIUM 改为必须有 lead 处置记录但不单独阻塞合入。

### 变更内容

- `resources/{claude,codex}-config/agent-deck-plugin/skills/{simple-review,deep-review}/SKILL.md`：补齐五级严重度评定细则、CRITICAL/HIGH 反驳轮、MEDIUM 处置记录和 0 CRITICAL/HIGH 收口条件。
- `resources/{claude,codex}-config/agent-deck-plugin/agents/reviewer-{claude,codex}.md`：reviewer 输出模板同步为五级严重度，验证不足时标 `*未验证*` 并降为 MEDIUM 或更低。
- `resources/templates/review.template.md`：同步 review 文档模板的严重度占位和未验证降级措辞，避免未来 REVIEW_X 继续沿用旧口径。
- `resources/claude-config/CLAUDE.md`：复杂 plan Step 1.5 deep-review gate 和多轮 review 收口经验同步为 0 CRITICAL/HIGH 口径。
- `resources/{claude,codex}-config/*`：teamless DM 文案里“需要保留 reviewer mental model”时从建议回到 team改为必须回到 team，消除提示词资产自检命中。

### 验证

- `git diff --check`：pass。
- prompt asset 自检：旧 `HIGH/MED`、`HIGH / MED`、`[MED]`、`非 HIGH`、旧 `MED` 别名接受逻辑等旧等级契约无残留；自检关键词命中仅剩提示词资产维护规则本身和弱断言关键词白名单。
- simple-review R1：
  - reviewer-codex 提出四份 SKILL 仍接受旧 `MED` 别名的 MEDIUM，已删除别名接受句。
  - reviewer-claude 提出 `resources/templates/review.template.md` 仍沿用旧 `HIGH/MED/LOW` 和 `非 HIGH` 的 MEDIUM，已同步为五级口径。
  - reviewer-codex fix 复核补抓 `resources/templates/review.template.md` 修复章节残留 `### MED`，已改为 `### MEDIUM` 并补齐 `CRITICAL` / `INFO` 分组。
  - 两路均未发现 CRITICAL/HIGH。
  - reviewer-codex fix 复核确认旧 `MED` 别名接受逻辑已清零，0 CRITICAL/HIGH/MEDIUM。
  - reviewer-claude 最终复核确认两个 MEDIUM 均关闭，template / 4 SKILL / 2 reviewer 旧口径扫描 clean，0 CRITICAL/HIGH/未关闭 MEDIUM。
