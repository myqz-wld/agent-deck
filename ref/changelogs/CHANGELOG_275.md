# CHANGELOG_275

## 修复额度探针触发 macOS 文件权限与幽灵历史会话

### 概要

修复 `CHANGELOG_274` 引入的静默 provider 额度探针隔离不彻底问题：Claude probe 初始化时不应继承应用启动 cwd，也不应加载用户 / project / local Claude settings 触发 hook，避免 macOS 弹出 Downloads 文件夹访问权限，并避免在历史会话里出现 cwd=`/` 的特殊 probe 会话。

### 变更内容

- 新增 `<userData>/provider-usage-probe-cwd` 作为 provider quota probe 专用 cwd，避免使用 `process.cwd()` 导致 `/`、Downloads 或 app 启动目录泄漏进 provider 子进程。
- Claude quota probe 改为 `settingSources: []`，不加载用户 / project / local settings，也不加载 Claude hook 配置。
- Claude quota probe 注入 `AGENT_DECK_ORIGIN=sdk`，即便未来误触发 hook，hook 通道也会识别为 SDK-derived 并丢弃。
- Claude quota probe 启动前注册 `sessionManager.expectSdkSession(probeCwd)`，同 cwd 的 hook 首发会被 claim/drop，不落历史会话。
- Codex transient app-server client 新增可选 `cwd`，background quota probe 也从应用私有 probe cwd 启动。
- 单测补充断言 safe cwd、`settingSources: []`、`AGENT_DECK_ORIGIN=sdk` 与 hook claim 注册。

### 验证

- `pnpm exec vitest run src/main/adapters/claude-code/__tests__/background-usage-snapshot.test.ts src/main/adapters/codex-cli/__tests__/background-usage-snapshot.test.ts src/main/adapters/claude-code/__tests__/usage-snapshot.test.ts src/main/adapters/codex-cli/__tests__/usage-snapshot.test.ts src/main/adapters/codex-cli/app-server/client.test.ts src/main/ipc/__tests__/provider-usage.test.ts src/main/adapters/__tests__/provider-usage.test.ts src/renderer/components/__tests__/DataPanel.test.tsx`
- `pnpm typecheck`
