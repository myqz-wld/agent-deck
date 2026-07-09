# CHANGELOG_15: SDK runtime + 升级 + ENOTDIR 系列主线

## 概要

合并原 CHANGELOG_20（修打包后 LLM 总结全降级 - PATH 找不到 node）+ CHANGELOG_44（升级 claude-agent-sdk 0.1.77 → 0.2.118 修 Task 工具会话死）+ CHANGELOG_46（修打包后 summary 全降级根因 - SDK 0.2.x ENOTDIR + summarizer 三处兜底 bug）。一条 SDK 运行时主线：从 0.1.x 时代用 `process.execPath + ELECTRON_RUN_AS_NODE` 兜 PATH，到升级 0.2.x 修 streaming dequeue 致命 bug，再到 0.2.x 时代 native binary spawn 必须 unpack + `pathToClaudeCodeExecutable` 显式传 unpacked 路径。

## 变更内容

### 0.1.x 时代修 PATH 找不到 node（原 CHANGELOG_20）

- 装到 `/Applications` 的 .app 里，间歇总结永远走「最近一条 assistant 文字 / 事件 kind 统计」兜底，LLM 一句话总结从未生效。dev 模式正常
- 根因：`@anthropic-ai/claude-agent-sdk` 默认 `executable: 'node'`（sdk.mjs:8601），spawn 时直接 `spawn('node', ...)`。但 macOS 通过 launchd 启动的 .app 只继承 `/usr/bin:/bin:/usr/sbin:/sbin` 这套最小 PATH —— nvm / homebrew 装的 node 都不在里面，spawn ENOENT，SDK throw，summarizer 的 try/catch 落到第二层降级
- 新增 `src/main/adapters/claude-code/sdk-runtime.ts`：暴露 `getSdkRuntimeOptions()` 返回 `{executable: process.execPath, env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}}` —— 让 SDK 直接用 .app 自己的 Electron 二进制以 Node 模式跑 cli.js；零依赖系统 node
- SDK 的 .d.ts 把 `executable` 限制为 `'bun' | 'deno' | 'node'` 联合，但运行时只是 `spawn(string, args)` —— 集中用 `as unknown as 'node'` 绕过 type
- `summarizer.ts` 的 `summariseViaLlm` + `sdk-bridge.ts` 的 `startSession` 的 `query({options})` 都加 `executable + env` 从 helper 拿

### 升级 claude-agent-sdk 0.1.77 → 0.2.118（原 CHANGELOG_44）

- 修「Claude 调用 Task 工具起 subagent / 跑 local_bash 后台任务，任务完成时整条会话突然出现红色 `⚠ only prompt commands are supported in streaming mode` 然后 `finished {ok:false}` 死掉」的根因 bug
- 双对抗 Agent 共识链路：上游 SDK 0.1.77 的 streaming dequeue 主循环（`cli.js:5037`）只放行 `mode==='prompt'` / `'orphaned-permission'` 两种命令，而 SDK 自己又会在 Task / local_bash 后台任务完成时 `eH({mode:'task-notification'}, ...)` 入到同一个 `queuedCommands`（`cli.js:1820/1829/1977`）—— streaming 主循环根本没有 `task-notification` 分流（`x71` 函数定义了但没在 streaming 路径调用），dequeue 取出直接撞 throw → catch 写 `{type:'result', subtype:'error_during_execution', errors:[...]}` 到 SDK output stream → `sdk-bridge.ts:961-963` 识别 `is_error` 把 errors 拼成红条 + emit `finished {ok:false}` → 会话从 SDK 角度终结
- 升级 0.2.118（最新，跨 41 patch 但 minor 大版本号）后官方完全重写 streaming：`task-notification` 不再走 queuedCommand mode 而变成 `SDKTaskNotificationMessage` 流消息类型；`only prompt commands` 字符串完全消失；`queuedCommands` / `task-notification` mode 关键字在新版 cli.js 0 命中 —— 根因 fix
- 实际改动只有 2 处：(1) `package.json` 版本号 `^0.1.10` → `^0.2.118`（caret 是 0.1.x 内升级必须手动跳 minor）；(2) `sdk-bridge.ts` 30s fallback 诊断文案里 `node node_modules/@anthropic-ai/claude-agent-sdk/cli.js` 在 0.2.x 不存在（包结构整体重构成 sdk.mjs / bridge.mjs / assistant.mjs / browser-sdk.js 四个 entry），改成 `claude -p "hi"`
- API 兼容性核实：4 个核心类型 + `query()` 函数表面 100% 兼容；`msg.type` switch 只处理 `'assistant'/'user'/'result'`，0.2.x 新增的 `SDKTaskNotificationMessage` / `SDKHookStartedMessage` / `SDKAuthStatusMessage` 等十几种新 message 类型会落到现有 ignore 分支，typecheck 不报错

### 0.2.x 时代 ENOTDIR + summarizer 兜底 bug（原 CHANGELOG_46）

用户反馈「summary 总结出问题了，取最近一条 assistant msg 的逻辑也失效了，直接到了事件统计」。直接读真实运行日志（`nohup ".app/Contents/MacOS/Agent Deck" > /tmp/agent-deck.log 2>&1`） + SQLite 实证 + 直接 `child_process.spawn` 实测 100% 锁定根因：

**(1) Layer 1 spawn ENOTDIR（CHANGELOG_15 升级时漏识别的语义变化）**：

- 0.2.x 把 `cli.js` 拆成 platform-specific native binary 包（`@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` 等，约 207MB），SDK 内部 `K7()` 通过 `require.resolve('@anthropic-ai/claude-agent-sdk-${plat}-${arch}/claude')` 拿到的路径在打包后 .app 里是 `app.asar/...` 字符串路径
- Electron fs patch 让 `existsSync` / `statSync` 透明回退到 `app.asar.unpacked/`，但 `child_process.spawn` 走系统 `posix_spawn` syscall **不经过 fs patch** → spawn `app.asar/.../claude` 同步抛 `ENOTDIR`（OS 把 app.asar 普通文件当目录访问失败）
- 与 CHANGELOG_14 修 codex `spawn ENOTDIR` 是同一类问题（codex 当时已用 `PLATFORM_BINARY_MAP` + `resolveBundledCodexBinary` 修了，claude SDK 升级后撞到镜像问题没复刻该套路）

**(2) Layer 1 prompt 两处隐 bug**（双对抗 Agent 评估方案时抓出）：

- (a) `formatEventsForPrompt` 取「最新 40 条」 events（DESC）后 `sort((a,b)=>a.ts-b.ts)` 升序，再 `if (lines.length >= 30) break` —— 升序遍历里 break 早，**实际丢的是最新 10 条而不是最旧 10 条**
- (b) Layer 1 prompt 的 `if (e.kind === 'message')` 完全没过滤 `role: 'user'` / `error: true`，把用户输入和 ⚠ 警告也写成「Claude 说 …」喂给总结 LLM

**(3) Layer 2 兜底四叠加 bug**（SQL 取证：summary 表实例 id=675 content=`⚠`、id=676 content=`Push 成功`、id=677 content=`最近 40 条事件；tool-use-start×21`）：

- (1) 没过滤 role → 拿到 user 输入；(2) 没过滤 error → 拿到 ⚠ 警告；(3) 没时间窗 → 拿到几小时前的旧 assistant 话；(4) `limit=40` 在 tool 密集会话被挤干 → undefined → 落到事件统计

**修复**（一并改 5 处）：

#### Layer 1 spawn ENOTDIR

- `sdk-runtime.ts`：JSDoc 完整重写明确区分 0.1.x（cli.js + node spawn / `executable` 起作用）与 0.2.x（native binary 直接 spawn / `executable` 完全被绕过）；`getSdkRuntimeOptions()` 实现保持不变（保留无害）；新增 `getPathToClaudeCodeExecutable()` 用 `createRequire(__filename)` 复刻 SDK K7 的解析顺序（含 linux musl 优先 + glibc 兜底，darwin/win32 单包，win32 binary `.exe` 后缀），结果用「路径段级 regex」`/([\\/])app\.asar([\\/])/` 替换成 `app.asar.unpacked` 段（前后必须是 `/` 或 `\`，既避免误吃祖先目录恰好含 `app.asar` 子串、也避免把已 unpacked 路径再加一层 `.unpacked`）；dev 模式 `require.resolve` 直接命中 node_modules 真实路径不含 asar，replace 是 no-op
- `sdk-bridge.ts` + `summarizer.ts`：`query({options})` 末尾追加 `...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {})`（conditional spread，undefined 时不传字段让 SDK 走默认 K7）

#### Layer 2 兜底重构

- `event-repo.ts` 新增 `findLatestAssistantMessage(sessionId, sinceTs?)`：单 SQL `WHERE kind='message' AND json_extract(payload_json,'$.role')='assistant' AND (json_extract(payload_json,'$.error') IS NULL OR ...=0) AND ts >= ? ORDER BY ts DESC LIMIT 1`
- `summarizer.ts` Layer 2 改用 `eventRepo.findLatestAssistantMessage(sessionId, sinceTs)`，sinceTs = `lastSummarizedAt.get(sessionId) ?? session.startedAt`（增量语义避免回到旧 assistant 内容重复展示）

#### Layer 1 prompt 修复

- `formatEventsForPrompt`：`const ordered = [...events].sort((a,b) => a.ts - b.ts).slice(-30)`；删 `if (lines.length >= 30) break`；`if (e.kind === 'message')` 分支首行加 `if (p.role === 'user' || p.error === true) continue`

#### 打包配置硬化

- `package.json build.asarUnpack` 追加 `node_modules/@anthropic-ai/claude-agent-sdk-darwin-*/**/*` / `-linux-*/**/*` / `-win32-*/**/*`（electron-builder 当前自动识别但显式声明防 builder 未来变化）

## 备注

- 升级路径 B/C（bridge 层吞红条 / 自动 resume 续活）暂不做：A 路根治，如果实跑出现别的红条再评估止血
- Codex 在评估里另提出「让 Layer 1/3 也吃 sinceTs 统一增量语义」的 design suggestion，未采纳：保持当前「Layer 1 LLM 看最新 30 条全活动 / Layer 2 sinceTs 后最新 assistant / Layer 3 事件统计兜底」三层不同语义
- 调查方法值得记录：stdio 重定向拉真实日志 + SQLite 直读 DB 实证 + 隔离 spawn 实测 + 双 Agent 对抗评估方案
- 0.2.x SDK 不再 fork 独立 CLI 进程，sdk-runtime.ts 的 `process.execPath + ELECTRON_RUN_AS_NODE=1` 兜底（CHANGELOG_15 早期方案）理论上可能不再必要，但保留以防万一
