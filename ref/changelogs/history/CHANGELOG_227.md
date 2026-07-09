# CHANGELOG_227: spawn_session 同 adapter 继承 extraAllowWrite

## 概要

修复 `spawn_session` 权限/沙盒继承的漏项：同 adapter spawn 现在会继承 caller
session 的 `extraAllowWrite`，跨 adapter spawn 仍不继承 caller 沙盒配置，继续走 target
adapter 默认值。

## 变更内容

- `src/main/agent-deck-mcp/tools/handlers/spawn.ts`
  - 新增 `effectiveExtraAllowWrite`，优先级与 permission/sandbox 三字段对齐：
    caller 显式传参 > same-adapter lead 继承 > cross-adapter 不传。
  - `extraAllowWrite: []` 视为显式空值，不回退继承。
- `src/main/agent-deck-mcp/__tests__/tools.test.ts`
  - 扩展 `createSession` spy 捕获 `extraAllowWrite`。
  - 回归覆盖 same-adapter 继承、cross-adapter 不继承、caller 显式覆盖三条路径。

## 验证

- `pnpm exec vitest run src/main/agent-deck-mcp/__tests__/tools.test.ts` ✅
- `pnpm typecheck` ✅
