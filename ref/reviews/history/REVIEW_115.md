# REVIEW_115 — 数据 tab 打开时弹权限窗口

## 触发场景

用户反馈：打开「数据」tab 时会弹出权限窗口。

## Scope

- `src/renderer/App.tsx`
- `src/renderer/components/DataPanel.tsx`
- `src/renderer/stores/token-usage-store.ts`
- `src/renderer/components/__tests__/DataPanel.test.tsx`
- `src/main/adapters/claude-code/sdk-bridge/index.ts`
- `src/main/adapters/claude-code/usage-snapshot.ts`
- `src/main/adapters/codex-cli/index.ts`
- `src/main/adapters/codex-cli/sdk-bridge/index.ts`
- `src/main/adapters/codex-cli/usage-snapshot.ts`
- `src/main/adapters/codex-cli/__tests__/usage-snapshot.test.ts`
- `README.md`

## 裁决

### [MEDIUM ✅] provider 用量读取会为数据 tab 启动隐藏子进程

**证据**：`CHANGELOG_261` 后，DataPanel mount 会读取 `providerUsageSnapshot()`。Claude fallback 在没有 live 会话时会启动隐藏 SDK Query 调 `/usage`；Codex 用量读取会通过 oneshot pool 懒启动 `codex app-server --stdio` 后请求 `account/rateLimits/read`。这使「打开数据 tab」变成隐式启动外部 provider 子进程，macOS 可能弹系统权限 / 登录态 / 钥匙串相关窗口。

**修法**：

- App 启动只预取本地 `tokenUsageDaily()`，不预取 provider 额度窗口。
- DataPanel 保持打开 tab 后自动读取 provider 用量和 60 秒定时刷新，不新增按钮。
- Claude provider 用量只复用已有 live Claude session 的 usage control；无 live session 时返回 `unavailable`，删除隐藏后台 SDK Query helper。
- Codex provider 用量只复用已存活的 per-session app-server；没有已存活 Codex 进程时返回 `unavailable`，删除会懒启动全局 app-server 的旧 helper。
- README 同步说明额度窗口不会启动隐藏后台 Query / Codex 子进程。

## 回归测试

- 新增 `DataPanel.test.tsx`：渲染 DataPanel 后仍自动调用 `providerUsageSnapshot`，且不新增「读取 / 刷新」按钮。
- 新增 Codex bridge 用量测试：无 client / client 未存活时不调用 `request()`；已有存活 app-server 时才请求 `account/rateLimits/read`。

## 验证

```bash
pnpm exec vitest run src/renderer/components/__tests__/DataPanel.test.tsx src/main/ipc/__tests__/provider-usage.test.ts src/main/adapters/__tests__/provider-usage.test.ts src/main/adapters/codex-cli/__tests__/usage-snapshot.test.ts
pnpm typecheck
```

结果：

- 4 test files passed，13 tests passed。
- `pnpm typecheck` passed。

## 关联 changelog

- [`CHANGELOG_262.md`](../../changelogs/history/CHANGELOG_262.md)
