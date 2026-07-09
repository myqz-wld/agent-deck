# CHANGELOG_256: spawn_session 权限 / 沙盒 override 字段说明收紧

## 概要

`spawn_session` MCP schema 的 `permissionMode`、`codexSandbox`、`claudeCodeSandbox` 描述改为明确的 override 语义：除非用户明确要求指定权限或沙盒档位，否则调用方应省略这些字段，让 Agent Deck 继续按既有默认链处理。

## 背景

本轮 deep-review 中 lead 显式传了 `codexSandbox: "read-only"`，导致 reviewer-codex 无法运行需要临时写文件的 Vitest。用户进一步指出 `permissionMode` 也不应由 review workflow 主动覆盖，并要求不要把这条规则写进 `simple-review` / `deep-review`，而是收敛到 MCP 工具说明。

源码默认链保持不变：

```text
caller 显式参数 > same-adapter lead 继承 > target adapter 默认
```

## 变更内容

- 还原 `simple-review` / `deep-review` 四份 packaged skill 中临时新增的 reviewer spawn 参数规则。
- 更新 `src/main/agent-deck-mcp/tools/schemas.ts` 的 `SPAWN_SESSION_SCHEMA`：
  - `permissionMode`：标为 Claude-family session 的显式 permission override；用户未明确要求时省略；`codex-cli` 忽略该字段。
  - `codexSandbox`：标为 `codex-cli` session 的显式 sandbox override；用户未明确要求时省略。
  - `claudeCodeSandbox`：标为 `claude-code` / `deepseek-claude-code` session 的显式 OS sandbox override；用户未明确要求时省略。

## 验证

- `rg -n "When spawning or respawning reviewers|permissionMode|claudeCodeSandbox|codexSandbox" .../skills/.../SKILL.md` 确认四份 review skill 不再包含临时规则。
- `diff -u` 验证 Claude/Codex 两份 `deep-review` 完全一致。
- `diff -u` 验证 Claude/Codex 两份 `simple-review` 完全一致。
- `git diff --check` 通过。
- `pnpm typecheck` 通过。

## 关联

- Review 记录：[`REVIEW_113.md`](../../reviews/history/REVIEW_113.md)
