# CHANGELOG_44: 升级 claude-agent-sdk 0.1.77 → 0.2.118 修「Task 工具完成后会话死」bug

## 概要

修「Claude 调用 Task 工具起 subagent / 跑 local_bash 后台任务，任务完成时整条会话突然出现红色 `⚠ only prompt commands are supported in streaming mode` 然后 `finished {ok:false}` 死掉」的根因 bug。双对抗 Agent（Claude 主 reasoning + Codex CLI xhigh 异构核实）共识完整链路：上游 SDK `@anthropic-ai/claude-agent-sdk@0.1.77` 的 streaming dequeue 主循环（`cli.js:5037`）只放行 `mode==='prompt'` / `'orphaned-permission'` 两种命令，而 SDK 自己又会在 Task / local_bash 后台任务完成时 `eH({mode:'task-notification'}, ...)` 入到同一个 `queuedCommands`（`cli.js:1820/1829/1977`）—— streaming 主循环根本没有 `task-notification` 分流步骤（`x71` 函数定义了但没在 streaming 路径调用），dequeue 取出直接撞 throw → catch 写一条 `{type:'result', subtype:'error_during_execution', errors:[err.message]}` 到 SDK output stream → `sdk-bridge.ts:961-963` 识别 `is_error` 把 `errors` 拼成红条 emit 给 UI + emit `finished {ok:false}` → 会话从 SDK 角度终结，bridge 层无法续活（query async iterator 已 return）。

升级 SDK 到 0.2.118（最新版，跨了 41 个 patch 版本但 minor 大版本号）后官方完全重写了 streaming 路径：`task-notification` 不再走 queuedCommand mode 而变成 `SDKTaskNotificationMessage` 流消息类型，`only prompt commands` 字符串完全消失，`queuedCommands` / `task-notification` mode 关键字在新版 cli.js 0 命中 —— 根因 fix。本仓库实际改动只有 2 处：(1) `package.json` 版本号（caret 是 0.1.x 内升级，必须手动跳 minor），(2) `sdk-bridge.ts` 30s fallback 诊断文案里写的 `node node_modules/@anthropic-ai/claude-agent-sdk/cli.js` 路径在 0.2.x 不存在（包结构整体重构，巨型 cli.js 拆成 sdk.mjs / bridge.mjs / assistant.mjs / browser-sdk.js 四个 entry），改成 `claude -p "hi"`。

## 变更内容

### 依赖升级（package.json）
- `@anthropic-ai/claude-agent-sdk`：`^0.1.10` → `^0.2.118`（实际锁到 0.1.77 → 0.2.118）
- 自动新增 65 个间接依赖：0.2.x 把原来自包含的实现拆出 `@anthropic-ai/sdk@^0.81.0` + `@modelcontextprotocol/sdk@^1.29.0` 两个真依赖
- peerDep zod 收紧 `^3.25 || ^4.0` → `^4.0` only（仓库已是 `4.3.6`，无需动）

### API 兼容性核实（无 breaking change 落到本仓库）
我们 `src/main/adapters/claude-code/sdk-bridge.ts` 用到的 4 个类型在 0.2.118 全部仍存在：
- `CanUseTool` → `sdk.d.ts:146`
- `PermissionResult` → `sdk.d.ts:1777`
- `Query` → `sdk.d.ts:1950`（仍是 `AsyncGenerator<SDKMessage, void>`）
- `SDKUserMessage` → `sdk.d.ts:3389`
- `query()` 函数 → `sdk.d.ts:2155`

`msg.type` switch 只处理 `'assistant' / 'user' / 'result'` 三种（[sdk-bridge.ts:880/937/952](../src/main/adapters/claude-code/sdk-bridge.ts#L880)），0.2.x 新增的 `SDKTaskNotificationMessage` / `SDKHookStartedMessage` / `SDKMirrorErrorMessage` / `SDKAuthStatusMessage` 等十几种新 message 类型会落到现有「ignore」分支（用 string 字面量比较），typecheck 不报错、运行时也不影响功能（只是新事件暂不翻译展示，需要时再补 case）。

### 诊断文案修正（src/main/adapters/claude-code/sdk-bridge.ts）
- 30s SDK 无消息 fallback 的红条文案：`node node_modules/@anthropic-ai/claude-agent-sdk/cli.js -p "hi"` → `claude -p "hi"`
- 0.2.x 包内已经没有 cli.js 文件（拆成 sdk.mjs / bridge.mjs / assistant.mjs / browser-sdk.js 四个 entry），原文案点出去就是死链接
- 「CLI 启动失败」改为「SDK 启动失败」更贴合 0.2.x 包结构（不再 fork 独立 CLI 进程）

### 验证
- `pnpm typecheck` 通过（0 error）
- `pnpm build` 通过（main 142KB / preload 10KB / renderer 1MB，无 warning）
- 实际改的只有 package.json 一行 + sdk-bridge.ts 两行字符串

## 没改但值得知道

- 0.2.x SDK 包结构是大重构（4 entry point、新增 mcp + anthropic-sdk 真依赖），但 query() / 4 个核心类型 API 表面 100% 兼容，是难得"内部大改但对外不破"的升级
- 我们还有 `src/main/adapters/claude-code/sdk-loader.ts` 的 dynamic import + `sdk-runtime.ts` 的 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 兜底（CHANGELOG_20 加的）—— 0.2.x 不再 fork CLI 子进程，理论上 sdk-runtime.ts 这套 Electron-as-Node 兜底可能不再必要，但 SDK 0.2.x sdk.mjs 是否完全 in-process 跑还需要后续验证。先保留，等后续遇到 .app 打包后总结仍降级再考虑拆掉
- 升级路径 B/C（bridge 层吞红条 / 自动 resume 续活）暂不做：A 路根治，如果实跑出现别的红条再评估止血
