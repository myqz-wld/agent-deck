# CHANGELOG_220 — spawn_session 跨 adapter 权限默认值

## 变更类型
行为修复

## 背景
用户反馈 Codex 会话通过 `spawn_session` 拉起 Claude 会话时，新 Claude 会话仍显示「每次询问」，没有按应用新建会话默认进入「不再询问」。根因是 MCP spawn 路径仍无条件继承 caller 的权限 / 沙盒字段；当 caller 是 Codex、target 是 Claude 时，继承链拿不到 Claude permissionMode，最终落到 Claude SDK 默认 `default`。

## 实现
- `spawn_session` 权限 / 沙盒默认值改为：
  - caller 显式传参优先。
  - target adapter 与 caller adapter 相同才继承 caller 的 permission / sandbox。
  - 跨 adapter spawn 不继承 caller，改用 target adapter 默认值。
- Claude / Deepseek 目标 adapter 在跨 adapter spawn 时默认 `bypassPermissions`，与 NewSessionDialog 和 `agent-deck new` 默认行为对齐。
- sandbox 跨 adapter 不继承，继续让 target adapter 走 settings 全局默认。
- 同步更新 MCP `spawn_session` / `hand_off_session` schema description，避免 agent 继续按旧契约推断。

## 验证
- 新增回归覆盖：
  - 同 adapter Claude spawn 继承 permissionMode + claudeCodeSandbox。
  - Codex → Claude 跨 adapter spawn 使用 `bypassPermissions`，不继承 caller sandbox。
  - 跨 adapter 显式传 permissionMode / sandbox 时优先覆盖默认值。
  - 同 adapter Codex spawn 继承 codexSandbox。
