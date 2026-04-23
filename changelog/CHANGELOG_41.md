# CHANGELOG_41: Codex CLI adapter（@openai/codex-sdk 接入）

## 概要

把 `src/main/adapters/codex-cli/` 从 30 行占位（capabilities 全 false、UI 不可见）填实为可用的 adapter，基于 `@openai/codex-sdk`。"诚实对等"实现：能做的全做（创建会话/发消息/中断/恢复/事件流），SDK 物理不支持的（工具批准回调 / AskUserQuestion / ExitPlanMode / 运行时切权限模式 / hook 安装）capabilities=false，UI 自动隐藏对应控件。

二进制策略：`@openai/codex-sdk` 强制 dependency `@openai/codex`，跟随 npm 装上当前平台 vendored 二进制（darwin-arm64 ≈150MB），随 .app 走。设置面板新增「Codex 二进制路径」字段允许用户覆盖为外部 codex（如自装的更新版本）。

## Codex SDK 真实能力边界（双对抗 Agent 源码核实结果）

事先用两个独立 Agent 各自直接读 `github.com/openai/codex` sdk/typescript 源码核实：

| 能力 | 状态 | 实现路径 |
|---|---|---|
| createSession | ✅ | `Codex.startThread({ workingDirectory, sandboxMode, approvalPolicy })` |
| sendMessage | ✅ | 同 thread 反复 `runStreamed(text, { signal })`，历史由 codex CLI `~/.codex/sessions` 重放 |
| interrupt | ✅ | `Thread` 无实例方法，但 `runStreamed(_, { signal })` 透传到 spawn → SIGTERM |
| resume | ✅ | `codex.resumeThread(id)`，无校验 |
| canUseTool / 工具批准 | ❌ | SDK 单工通道（`exec.ts` `child.stdin.end()` 写完即关），`approvalPolicy` 是字符串枚举一次性配置 |
| AskUserQuestion | ❌ | 无任何反向问询事件（`events.ts` 8 种事件全无 ask 类型） |
| ExitPlanMode / plan mode | ❌ | 最接近的 `TodoListItem` 是被动展示，无暂停状态机 |
| 运行时 setPermissionMode | ❌ | `approvalPolicy` 仅在 startThread 时设一次 |
| installIntegration / hook | ❌ | codex 没有 PreToolUse/PostToolUse 类机制 |

→ codex-cli adapter 最终 capabilities：`canCreateSession=true / canInterrupt=true / canSendMessage=true / canInstallHooks=false / canRespondPermission=false / canSetPermissionMode=false`。

## 变更内容

### Codex CLI adapter（src/main/adapters/codex-cli/）

新建 3 个文件，重写 1 个占位：

- **sdk-loader.ts**（新）：复刻 claude-code 同名文件的 `new Function('s', 'return import(s)')` 模式，绕开 vite 静态分析对 ESM-only 包的 require 转译。单例 `codexSdkPromise` 跨模块共享。
- **translate.ts**（新）：codex `ThreadEvent` / `ThreadItem` → `AgentEvent` 映射纯函数。完整覆盖 8 种事件 + 8 种 item，关键映射：
  - `thread.started` → 不发（sdk-bridge 单独处理 sessionId 同步）
  - `turn.started` / `item.updated` → 不发（噪音）
  - `turn.completed` → `finished({ ok:true, usage })`
  - `turn.failed` / `error` → `message(error)` + `finished({ ok:false })`
  - `item.started{command_execution}` → `tool-use-start({ toolName:'Bash', command })`
  - `item.completed{command_execution}` → `tool-use-end({ aggregated_output, exit_code })`
  - `item.completed{agent_message}` → `message({ text, role:'assistant' })`
  - `item.completed{reasoning}` → `message({ text, role:'assistant', reasoning:true })`
  - `item.completed{file_change}` → `file-changed × N`（codex 不带 before/after 文本，都填 null，metadata 含 changeKind）
  - `item.started/completed{mcp_tool_call}` → 一对 `tool-use-start/end`，toolName=`mcp__${server}__${tool}`
  - `item.completed{web_search}` → 一对 start/end（codex web_search 没有 started 事件）
  - `item.completed{todo_list}` → `message({ text:格式化, role:'assistant', todoList })`
  - `item.completed{error}` → `message(error)`
- **sdk-bridge.ts**（新）：`CodexSdkBridge` 类，对应 claude-code 同形态但显著简化：
  - 无 canUseTool / AskUserQuestion / ExitPlanMode / setPermissionMode
  - 无 hook 通道时序竞争（codex 无 hook），不调 `sessionManager.expectSdkSession`
  - **同 thread 串行 turn**：codex CLI 共享 `~/.codex/sessions` 文件，不能并发 → 用 `pendingMessages: string[]` 队列 + `turnLoopRunning` flag 串行 flush
  - **interrupt 行为**：每个 turn 一个 `AbortController`，按钮触发 `controller.abort()` → SDK 透传 `signal` 到 `child_process.spawn` → SIGTERM → turn 抛 AbortError → emit `finished({ subtype: 'interrupted' })`。**thread.id 不变**，下条 sendMessage 重新 `runStreamed` 续上（codex CLI 冷启动 + resume）
  - **新建路径 thread_id 同步**：`startThread()` 不立即返回 thread_id，要等第一条 `thread.started` 事件 → tempKey 占位 + 30s fallback + `sessionManager.renameSdkSession` 切 key（与 claude-code 同套路）
  - **resume 路径**：`resumeThread(id)` 直接拿到 id，跳过 tempKey
  - 字节/队列上限沿用 claude-code 常量（100KB / 20 条）
- **index.ts**（占位 → 实装）：`CodexCliAdapterImpl implements AgentAdapter`，capabilities 按真实能力填，实现 `createSession / interruptSession / sendMessage / listPending / listAllPending / setCodexCliPath`。**默认安全策略写死** `approvalPolicy='never' + sandboxMode='workspace-write'`（不暴露给 UI），靠 OS sandbox 兜底，不靠批准对话框。

### Adapter 接口扩展（src/main/adapters/types.ts）

- 加可选方法 `setCodexCliPath?(path: string | null): void` —— 与现有 `setPermissionTimeoutMs` 同形态，让 settings 变更即改即生效。

### 类型层（src/shared/types.ts）

- `AppSettings` 加 `codexCliPath: string | null`
- `DEFAULT_SETTINGS.codexCliPath = null`（默认用应用内置 codex）

### IPC 层

- **shared/ipc-channels.ts**：加 `DialogChooseExecutable: 'dialog:choose-executable'`
- **preload/index.ts**：加 `chooseExecutableFile(defaultPath?)` facade
- **main/ipc.ts**：
  - SettingsSet handler 加分发：`if ('codexCliPath' in p) adapterRegistry.get('codex-cli')?.setCodexCliPath?.(next.codexCliPath)`
  - 新增 `DialogChooseExecutable` handler：`dialog.showOpenDialog({ properties:['openFile'], filters:[{name:'所有文件', extensions:['*']}] })`

### Renderer UI

- **SettingsDialog.tsx**：新加 Section「外部工具」，含 `ExecutablePicker` 组件（与 SoundPicker 同形态但简化，按钮只有「选择 / 重置」+ hint 文字「留空 = 用应用内置 codex（推荐）。填路径 = 覆盖为外部 codex」）
- **NewSessionDialog.tsx**：
  - 加 `selectedAdapter` 计算 + `showModel`（仅 claude-code）/ `showPermissionMode`（按 `capabilities.canSetPermissionMode`）
  - 模型 select 与权限模式 select 改成条件渲染
  - submit 时隐藏字段不传给 IPC（避免 codex 收到无意义参数）
- **SessionDetail.tsx** ComposerSdk：
  - 加 `agentDisplayName` (`'Codex'` / `'Claude'`) + `supportsPermissionMode` (`agentId !== 'codex-cli'`)
  - 权限模式 select 改成条件渲染（codex 会话不显示）
  - placeholder 文案按 agent 名变化：`给 ${agentDisplayName} 发消息…`
- **SessionList.tsx** 欢迎文案：补充「点 ＋ 新建会话（可选 Claude / Codex）」+ `agent-deck new --agent codex-cli` 终端示例

### 依赖

- `package.json` dependencies 加 `@openai/codex-sdk@^0.120.0`
  - 强制 dependency `@openai/codex@0.120.0` 自动跟随安装 → 当前平台 vendored 二进制（如 `@openai/codex-darwin-arm64`，~150MB）通过 optionalDependencies 装上
  - electron-builder `extraResources` 不动，二进制随 `node_modules` 一起进 .app

## 不动的东西（明确划界）

- `src/main/session/manager.ts`：`claimAsSdk / renameSdkSession / sdkOwned` 等通用 API 完全复用，不改
- `src/main/session/summarizer.ts`：继续用 claude haiku 总结 codex 会话（codex 也用 claude 跑总结，避免引入二份 LLM 路径）
- `src/main/cli.ts` + `resources/bin/agent-deck` wrapper：`--agent <id>` 已支持，新加 `--agent codex-cli` 自动工作
- `src/main/store/migrations/`：codex thread_id 复用 SessionRecord.id，approvalPolicy/sandboxMode 写死，不持久化任何 codex 特定字段，不动 schema
- `src/main/event-bus.ts` / `src/main/hook-server/`：现有事件总线对 agent 无感；codex 不走 hook
- `src/main/adapters/claude-code/`：完全不动
- `aider` / `generic-pty` 占位：仍占位

## 已知约束 / 风险

1. **`@openai/codex-sdk` 0.x 不稳定**：API 仍在演进，未来可能加 cancellation 实例方法、tool 拦截等。届时升级 capabilities。
2. **同 thread 并发限制**：用户多设备/多窗口同时操作同一会话会撞 `~/.codex/sessions` 文件。MVP 不做防护，agent-deck 单进程内 `pendingMessages` 串行已经够用。
3. **interrupt 杀整个进程树**：SIGTERM codex 子进程会同时杀它正在跑的 shell 命令（`npm install` 等可能留半完成状态）。用户已决定不在 UI 上解释这个语义差异。
4. **file-changed 无 diff**：codex 的 `FileChangeItem` 不暴露文件改动的 before/after，UI 只能显示「修改了 X 文件」+ changeKind。不做 git diff 兜底（开销大、不在 git repo 时无意义）。
5. **codex 鉴权完全外部**：agent-deck 不读不写 `~/.codex/config.toml`。用户首次用 codex 前要在终端跑 `codex auth` 配好。
6. **包体积 +150MB**：darwin-arm64 平台二进制 ~150MB（windows / linux 类似），跟随 .app 打包。后续考虑做按需下载，但 MVP 接受现状。

## 验证

```bash
zsh -i -l -c "pnpm typecheck"   # 通过
zsh -i -l -c "pnpm build"        # 大改动跑

# dev 重启
lsof -ti:47821,5173 2>/dev/null | xargs -r kill -9
pkill -f "electron-vite dev" 2>/dev/null
pkill -f "Electron.app/Contents/MacOS/Electron" 2>/dev/null
zsh -i -l -c "pnpm dev"
```

手动验证（main 改动 + renderer 改动，必须重启 dev）：

| # | 操作 | 预期 |
|---|---|---|
| 1 | 设置面板看到「外部工具」section + 「Codex 二进制路径」字段 | 默认显示「使用应用内置（默认）」+ hint 文案 |
| 2 | ＋ 按钮 → Agent 下拉 | 出现 `Claude Code` 与 `Codex CLI` 两项 |
| 3 | 选 Codex CLI | 「模型」「权限模式」字段消失（只剩 cwd / prompt / 取消 / 创建） |
| 4 | 选 Codex + cwd 选 git repo + prompt「列出当前目录文件」→ 创建 | 活动流出现 user message → tool-use-start (Bash, ls) → tool-use-end (含输出) → assistant message → finished |
| 5 | 看 SessionCard 上的 agent 标签 | 显示 `codex-cli` |
| 6 | 在 codex 会话里看 ComposerSdk | placeholder 写「给 Codex 发消息…」；权限模式 select 不显示；中断按钮显示 |
| 7 | 多轮对话：发第二条「写到 LIST.txt」 | 出现 command_execution（codex 写文件）+ file-changed（path=LIST.txt, before/after null） |
| 8 | 发慢命令「sleep 60 && echo done」立即按中断 | 当前 turn 抛 AbortError → emit `finished({ subtype:'interrupted' })`；子进程被 SIGTERM |
| 9 | 中断后接着发新消息「你好」 | 同 thread 续上（codex 冷启动 + resume），能正常响应 |
| 10 | CLI 路径：`agent-deck new --cwd "$PWD" --agent codex-cli --prompt "ping"` | 拉起 codex 会话，等同 UI 路径 |
| 11 | 设置面板填错 codex 路径（如 `/tmp/nonexistent`）→ 新建会话 | NewSessionDialog 显示友好红条错误 |
| 12 | 历史面板筛 codex 会话 / 归档 / 取消归档 / 删除 | 全部正常工作（与 claude-code 一致，agent_id 列已存在） |
| 13 | 改 codex 路径 → 新建会话 | 用新 path（不需要重启应用：bridge 收到 settings 分发） |
| 14 | 测 claude-code 会话不受影响 | 权限模式 select / AskRow / ExitPlanRow / hook 安装 / 全部正常 |
