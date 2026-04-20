# CHANGELOG_13: 命令行新建应用内会话

## 概要

支持从终端通过 `agent-deck new --cwd ... --prompt "..."` 拉起 / 复用 Agent Deck 实例新建一个 SDK 会话，等价于在 ＋ 弹窗里点确定。复用 Electron 已有的 `requestSingleInstanceLock()` 通路，首启与 second-instance 共用同一段 argv 解析。新建后默认聚焦窗口 + 选中新会话。

## 变更内容

### CLI 解析与执行（src/main/cli.ts，新文件）
- `parseCliInvocation(argv)` 纯函数：扫描 `'new'` 子命令位置（不能按 index，因为 dev / 打包 / second-instance 三种入口的 leading 段不一样），后续 token 走 `parseFlags` 转 Map
- 支持 `--key value` / `--key=value` / `--no-key`（布尔反向）/ 裸 `--key`（视为 true）；不实现 short flag
- `new` 子命令字段：`--cwd`（必填）/ `--prompt` / `--agent`（默认 claude-code）/ `--model` / `--permission-mode`（白名单：default | acceptEdits | plan | bypassPermissions）/ `--system-prompt` / `--resume` / `--no-focus`
- `applyCliInvocation`：
  - 通过 `adapterRegistry.get(agent).createSession(...)` 走 SDK 通道（capabilities 不支持 createSession 直接报错）
  - cwd 用 `realpath` 兜底解析（相对路径会按主进程 cwd 解析，wrapper 已在 shell 端转绝对，这里只是再保险）
  - focus=true 时：`win.show()+focus()`、macOS 上 `app.focus({steal:true})`、emit 新事件 `'session-focus-request'`
- `handleCliArgv(argv)` 包了 try/catch 给两个入口共用，错误走 `dialog.showErrorBox` 弹框（dev 早期 dialog 没就绪时静默吞掉）

### 主进程入口接线（src/main/index.ts）
- `bootstrap()` 末尾加 `setImmediate(() => handleCliArgv(process.argv))`：处理首启命令行参数。放 setImmediate 是为了让 bootstrap 函数本身能尽快返回，CLI 错误只走弹框不阻塞启动流程
- `app.on('second-instance', (_e, argv) => ...)` 改造：除了原来的 show/focus 已存在窗口，再调一次 `handleCliArgv(argv)`
- 9. 事件接线段加 `eventBus.on('session-focus-request', sid => win.webContents.send(IpcEvent.SessionFocusRequest, sid))`

### 事件总线 + IPC 通道（src/main/event-bus.ts、src/shared/ipc-channels.ts）
- `EventMap` 加 `'session-focus-request': [string]`
- `IpcEvent.SessionFocusRequest = 'event:session-focus-request'`

### preload 暴露（src/preload/index.ts）
- 加 `onSessionFocusRequest(cb)` 订阅 API，与既有 onPinToggled / onSessionRenamed 同结构

### renderer 跳转（src/renderer/App.tsx）
- 新 useEffect 挂 `window.api.onSessionFocusRequest(sid => { setView('live'); select(sid); })`
- 时机说明：主进程在 `createSession` resolve 后才 emit，而 SDK createSession 一般要等 SDK CLI 子进程启动 + 第一条 SDKMessage（数秒），所以 renderer 此时一般已 mount，listener 已注册；只有 `--resume` 等极快返回的路径理论可能丢事件（可接受，用户回到列表手动点也行）

### macOS shell wrapper（resources/bin/agent-deck，新文件 + chmod +x）
- 默认查 `/Applications/Agent Deck.app/Contents/MacOS/Agent Deck`，`AGENT_DECK_APP` 环境变量可覆盖
- 把 `--cwd` 的相对路径在 shell 端转成绝对（含 `--cwd=val` 形式）；如果是 `new` 但没传 `--cwd`，自动补 `--cwd "$PWD"`
- 为什么必须在 shell 端转：second-instance 转发到主实例后，主实例的 `process.cwd()` 是 .app 安装目录或 `/`，不是用户 shell 的 PWD，相对路径会解析错
- `exec` 原始二进制把剩余参数原样传过去，single-instance lock 决定是新启动还是 second-instance 转发

### README（README.md）
- 新增「命令行新建会话（macOS）」节，列出全部 flag、安装软链命令、聚焦行为、报错通道、平台覆盖范围
- 项目结构补 `src/main/cli.ts` 一行，`resources/` 树新加完整列出含 `bin/agent-deck`

## 追加：参数全默认的简单形式

wrapper 进一步做减法，让用户敲最短的命令也能新建会话：

### resources/bin/agent-deck
- 在 `chmod` 检查之后、cwd 重写之前加一段：
  - `$# == 0` → `set -- new`（裸调用 `agent-deck` 等价于 `new --cwd "$PWD"`）
  - 首参以 `--` 开头 → `set -- new "$@"`（`agent-deck --prompt "..."` 自动补 `new` 子命令）
- 显式带子命令的写法（`agent-deck new ...`）保持原状不变

### README.md
- 「命令行新建会话」节顶部新增「最简用法（参数全默认）」示例，再保留完整 flag 列表
- 提示：没传 `--prompt` 时 SDK 会卡到 30s fallback 才显出会话，用户可以等会话出现后在 UI 输第一条消息

## 追加：默认 prompt = "你好"

- `cli.ts` 把 `CliNewSession.prompt` 从 `?: string` 改成必选 `string`，缺省值 `'你好'`（`asString(...) ?? '你好'`）
- 之前裸跑 `agent-deck` 时 SDK 拿不到首条 user message，会卡 30s fallback 才显出会话；改后立刻发起对话
- 显式 `--prompt ''` 仍尊重为空（asString 返回 `''`，`??` 不触发），保留 escape hatch
- README 同步：默认值表与 flag 列表里的 `--prompt` 注释都标明 `缺省 "你好"`
