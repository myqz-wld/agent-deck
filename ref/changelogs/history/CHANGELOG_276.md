# CHANGELOG_276

## 应用启动时预热 provider 额度缓存

### 概要

把 provider 额度信息的首次读取从打开数据 tab 改为应用启动时预热。数据 tab 仍通过原有 IPC 读取 main 端 TTL cache，并保留 60 秒定时刷新。

### 变更内容

- 新增 `prefetchProviderUsageSnapshots()`，复用现有 `providerUsageSnapshotHandler()` 的 TTL cache 与 in-flight 去重。
- main bootstrap 在 IPC 注册后 fire-and-forget 调用 provider usage prefetch；失败只记日志，不阻塞窗口创建或启动流程。
- DataPanel 逻辑不改：打开时如果 main cache 已预热，会直接拿缓存；未完成则复用同一个 in-flight promise。
- README 同步说明启动时预热 provider 额度缓存。

### 验证

- `pnpm exec vitest run src/main/ipc/__tests__/provider-usage.test.ts src/main/adapters/claude-code/__tests__/background-usage-snapshot.test.ts src/main/adapters/codex-cli/__tests__/background-usage-snapshot.test.ts src/main/adapters/claude-code/__tests__/usage-snapshot.test.ts src/main/adapters/codex-cli/__tests__/usage-snapshot.test.ts src/main/adapters/codex-cli/app-server/client.test.ts src/main/adapters/__tests__/provider-usage.test.ts src/renderer/components/__tests__/DataPanel.test.tsx`
- `pnpm typecheck`
