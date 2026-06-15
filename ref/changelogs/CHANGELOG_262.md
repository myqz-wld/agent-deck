# CHANGELOG_262: 数据 tab 额度窗口不再启动隐藏 provider 子进程

## 概要

修复打开「数据」tab 时可能弹出 macOS 系统权限窗口的问题。Provider 额度窗口仍在打开数据 tab 后自动读取并缓存，但 Claude 无 live 会话时不再启动隐藏 SDK Query，Codex 无已存活 app-server 时不再启动 `codex app-server`；改为直接显示暂不可读。

## 变更内容

- `App.tsx` 删除启动时的 `providerUsageSnapshot()` 预取，只保留本地 token 明细预取。
- `DataPanel` 保持打开 tab 后自动读取 provider 用量和 60 秒定时刷新，不新增额外按钮。
- Claude `getUsageSnapshot()` 无 live session 时返回 unavailable，占位提示需要已有 Claude 会话；删除后台 usage Query helper。
- Codex `getUsageSnapshot()` 从全局 oneshot pool 改到 bridge 复用已存活 per-session app-server；无存活进程时返回 unavailable，删除会懒启动 Codex 的旧 helper。
- token usage store 注释和 README 同步新的安全读取语义。
- 新增 DataPanel 回归测试，锁定「打开 tab 自动读取 provider，但不新增读取按钮」。
- 新增 Codex bridge 回归测试，锁定无存活 app-server 时不发 `account/rateLimits/read`。

## 验证

- `pnpm exec vitest run src/renderer/components/__tests__/DataPanel.test.tsx src/main/ipc/__tests__/provider-usage.test.ts src/main/adapters/__tests__/provider-usage.test.ts src/main/adapters/codex-cli/__tests__/usage-snapshot.test.ts`
- `pnpm typecheck`
