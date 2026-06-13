# REVIEW_113 — spawn_session 权限与沙盒 override 字段说明

## 触发场景

用户询问本轮 deep-review reviewer 为什么是只读权限，并指出 `permissionMode`、`claudeCodeSandbox`、`codexSandbox` 除非明确要求，否则不要填写。用户随后要求还原 `simple-review` / `deep-review` 的临时技能规则，把约束改到 MCP 工具说明。

## Scope

- `src/main/agent-deck-mcp/tools/schemas.ts`
- `resources/claude-config/agent-deck-plugin/skills/deep-review/SKILL.md`
- `resources/codex-config/agent-deck-plugin/skills/deep-review/SKILL.md`
- `resources/claude-config/agent-deck-plugin/skills/simple-review/SKILL.md`
- `resources/codex-config/agent-deck-plugin/skills/simple-review/SKILL.md`

## 方法

- 使用 `prompt-asset-improver` 流程处理长期 prompt / tool description 资产。
- 先按用户上一版方向派发聚焦编辑 agent，随后在用户改口后停止该会话，避免并发写入。
- Lead 侧直接收口最终范围：移除四份 review skill 中临时新增的 reviewer spawn 参数规则，并只修改 `spawn_session` schema 描述。
- 未把 `send_message` MCP 缺失问题混入本条 MCP 描述修法；该问题由 [`REVIEW_114.md`](REVIEW_114.md) / [`CHANGELOG_257.md`](../changelogs/CHANGELOG_257.md) 单独收口。

## 源码默认链确认

`src/main/agent-deck-mcp/tools/handlers/spawn.ts` 中权限 / 沙盒字段按以下优先级计算：

```text
caller 显式参数 > same-adapter lead 继承 > target adapter 默认
```

关键结论：

- `permissionMode`：显式参数优先；same-adapter 时继承 lead；cross-adapter 时 Claude-family target 默认 `bypassPermissions`，Codex target 不设置该字段。
- `codexSandbox`：显式参数优先；其次 Codex custom agent sandbox；same-adapter 时继承 lead；否则不传，后续 Codex bridge 走 `opts.codexSandbox > resume 记录 > settingsStore.get('codexSandbox')`。
- `claudeCodeSandbox`：显式参数优先；same-adapter 时继承 lead；否则不传，后续 Claude bridge 走 `opts.claudeCodeSandbox > resume 记录 > settingsStore.get('claudeCodeSandbox') > 'off'`。

## 三态裁决

### [MEDIUM ✅ 真问题] `spawn_session` override 字段说明没有阻止非必要显式传参

**证据**：本轮 lead 显式传入 `codexSandbox: "read-only"` 后，reviewer-codex 报告 Vitest 因无法写临时目录 / `node_modules/.vite` 结果文件而失败。用户进一步指出 `permissionMode` 也应同样避免非必要覆盖。

**裁决**：采纳。review skill 的职责是编排异构 reviewer 和审查协议，不应承担通用 MCP 参数默认纪律；该纪律应由 `spawn_session` 工具说明表达。

**修法**：`SPAWN_SESSION_SCHEMA` 三个字段说明改为 explicit override：除非用户明确要求该权限或沙盒档位，否则省略，让 Agent Deck 使用同 adapter 继承或目标 adapter 默认链。

### [INFO ✅ 另修] reviewer-claude 缺少 `send_message`

本轮 deep-review rebuttal 中 reviewer-claude 报告 Agent Deck MCP `send_message` 不可用，无法按 wire reply path 投递，只能让用户从 SessionDetail 手动转贴。该问题不混入本次 MCP 描述修法，由 [`REVIEW_114.md`](REVIEW_114.md) 单独修复。

## 验证

- `rg -n "When spawning or respawning reviewers|permissionMode|claudeCodeSandbox|codexSandbox" resources/.../skills/.../SKILL.md`：四份 review skill 不再包含临时规则。
- `rg -n "Explicit .*override|Omit unless the user explicitly requests" src/main/agent-deck-mcp/tools/schemas.ts`：三处字段说明命中。
- `diff -u resources/claude-config/.../deep-review/SKILL.md resources/codex-config/.../deep-review/SKILL.md` 无输出。
- `diff -u resources/claude-config/.../simple-review/SKILL.md resources/codex-config/.../simple-review/SKILL.md` 无输出。
- `git diff --check` 通过。
- `pnpm typecheck` 通过。

## 关联 changelog

- [`CHANGELOG_256.md`](../changelogs/CHANGELOG_256.md)
