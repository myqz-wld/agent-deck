# CHANGELOG_20: 修打包后 LLM 总结全降级（PATH 找不到 node）

## 概要

装到 `/Applications` 的 .app 里，间歇总结永远走「最近一条 assistant 文字 / 事件 kind 统计」兜底，LLM 一句话总结从未生效。dev 模式正常。

根因：`@anthropic-ai/claude-agent-sdk` 默认 `executable: 'node'`（[sdk.mjs:8601](file:///Applications/Agent%20Deck.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs)），spawn 时直接 `spawn('node', ...)`。但 macOS 通过 launchd 启动的 .app 只继承 `/usr/bin:/bin:/usr/sbin:/sbin` 这套最小 PATH —— nvm / homebrew 装的 node 都不在里面，spawn ENOENT，SDK throw，summarizer 的 try/catch 落到第二层降级。dev 从 terminal 起继承完整 shell PATH，所以一直没暴露。

修法：传 `executable: process.execPath` + 设 `ELECTRON_RUN_AS_NODE=1`，让 SDK 直接用 .app 自己的 Electron 二进制以 Node 模式跑 cli.js。零依赖系统 node、跨设备一致；同时也修了应用内会话（sdk-bridge）的同样问题。

## 变更内容

### src/main/adapters/claude-code/sdk-runtime.ts（新增）
- 暴露 `getSdkRuntimeOptions()`，返回 `{ executable, env }`：
  - `executable = process.execPath`（.app 主进程的 Electron 二进制）
  - `env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }`（让 Electron 进入 Node 模式）
- SDK 的 .d.ts 把 `executable` 限制为 `'bun' | 'deno' | 'node'` 联合，但运行时只是 `spawn(string, args)` —— 这里集中用 `as unknown as 'node'` 绕过 type，不让调用方都重复 cast

### src/main/session/summarizer.ts
- `summariseViaLlm` 在 `query({ options })` 里加 `executable` + `env`，从 helper 拿

### src/main/adapters/claude-code/sdk-bridge.ts
- `startSession` 的 `query({ options })` 同步加 `executable` + `env`，避免应用内会话在 .app 里同样跑不起来（这条用户没明说，但同根因，一并修，否则装好的 .app 内任何 SDK 通道都形同虚设）

## 验证

- `pnpm typecheck` 通过
- 需要重打包验证：`rm -rf release && pnpm dist` → 覆盖装到 /Applications → 看一段时间内活跃会话能否拿到 LLM 一句话总结（不是事件统计兜底）
