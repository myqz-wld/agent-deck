# CHANGELOG_210

## Claude Code 默认沙盒与新会话默认权限

### 概要

Claude Code 新会话默认进入工作目录可写的系统沙盒；新建会话类弹窗的权限模式默认改为「不再询问」。

### 变更内容

- `DEFAULT_SETTINGS.claudeCodeSandbox` 从 `off` 改为 `workspace-write`，设置面板同步标注「工作目录可写（默认）」。
- settings-store 新增一次性 uplift：旧安装里 `claudeCodeSandbox` 仍是旧默认 `off` 时迁移到 `workspace-write`，并用独立 sentinel 防止用户之后改回 off 时被反复覆盖。
- `NewSessionDialog` 与 `ResolveInNewSessionDialog` 的 Claude Code 权限模式冷启动默认改为 `bypassPermissions`；用户本次运行期间改过后仍按原有 last-used 记忆优先。
- README 设置说明同步标注 Claude Code 沙盒默认 Workspace Write。

### 验证

- `pnpm exec vitest run src/main/store/__tests__/settings-store.test.ts src/renderer/hooks/__tests__/useLastSessionDefaults.test.ts`
- `pnpm typecheck`
