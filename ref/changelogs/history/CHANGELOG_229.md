# CHANGELOG_229: 修正 Codex deep-review 提示词工具名

## 概要

修复 CHANGELOG_228 后续审计发现的 Codex 侧提示词资产漂移：Codex bundled
`deep-review` skill 中仍残留 Claude `Bash` 工具写法，可能误导 Codex reviewer
按不存在的工具名执行缓存拷贝、`.gitignore` 自检和 cleanup。

## 变更内容

- `resources/codex-config/agent-deck-plugin/skills/deep-review/SKILL.md`：
  将外部 scope cache 流程中的 `Bash cp`、`Bash: grep`、裸 `rm -rf` 文案改为
  Codex 侧可执行的 `shell:` 命令写法。
- 保持行为契约不变：cache manifest、24h orphan sweep、`.gitignore` 自检、
  `ack_cache_unignored` 批处理确认和 review 后 cleanup 逻辑仅改工具名表达。

## 验证

- `git diff --check` 通过。
- `diff -u resources/codex-config/agent-deck-plugin/skills/deep-review/SKILL.md /Users/wanglidong/.codex/skills/agent-deck/deep-review/SKILL.md` 为空。
- `rg` 确认目标 Codex deep-review skill 中无残留 `Bash: grep` / `Bash \`cp` / `Bash \`` 文案。
- prompt / markdown-only 改动，未运行 typecheck。
