# CHANGELOG_7: 命令行新建会话 `agent-deck new`

## 概要

支持从终端通过 `agent-deck new --cwd ... --prompt "..."` 拉起 / 复用 Agent Deck 实例新建一个 SDK 会话，等价于在 ＋ 弹窗里点确定。复用 Electron 已有的 `requestSingleInstanceLock()`，首启与 second-instance 共用同一段 argv 解析。

## 变更内容

### CLI 解析（src/main/cli.ts，新文件）

- `parseCliInvocation(argv)`：扫描 `'new'` 子命令位置（不能按 index，因为 dev / 打包 / second-instance 三种入口的 leading 段不一样），后续 token 走 `parseFlags` 转 Map
- 支持 `--key value` / `--key=value` / `--no-key`（布尔反向）/ 裸 `--key`（视为 true）；不实现 short flag
- `new` 子命令字段：`--cwd`（缺省回落 `$PWD`/wrapper、最终 `homedir()`） / `--prompt`（缺省 `'你好'`） / `--agent`（默认 `claude-code`） / `--model` / `--permission-mode`（白名单 default/acceptEdits/plan/bypassPermissions） / `--system-prompt` / `--resume` / `--no-focus`
- `applyCliInvocation`：通过 `adapterRegistry.get(agent).createSession(...)` 走 SDK 通道；focus=true 时 `win.show()+focus()` + macOS `app.focus({steal:true})` + emit `'session-focus-request'`

### 主进程接线（src/main/index.ts）

- `bootstrap()` 末尾 `setImmediate(() => handleCliArgv(process.argv))` 处理首启 argv
- `app.on('second-instance', (_e, argv) => ...)` 改造：除原 show/focus 已存在窗口外再调一次 `handleCliArgv(argv)`
- 加 `eventBus.on('session-focus-request', sid => win.webContents.send(IpcEvent.SessionFocusRequest, sid))`

### 事件 + IPC（src/main/event-bus.ts、src/shared/ipc-channels.ts）

- `EventMap` 加 `'session-focus-request': [string]`；`IpcEvent.SessionFocusRequest`
- `preload`：`onSessionFocusRequest(cb)`
- `App.tsx` 挂 `window.api.onSessionFocusRequest(sid => { setView('live'); select(sid); })`

### macOS shell wrapper（resources/bin/agent-deck，新文件 + chmod +x）

- 默认查 `/Applications/Agent Deck.app/Contents/MacOS/Agent Deck`，`AGENT_DECK_APP` 环境变量可覆盖
- 把 `--cwd` 的相对路径在 shell 端转成绝对（含 `--cwd=val` 形式）；如果是 `new` 但没传 `--cwd`，自动补 `--cwd "$PWD"`（必须 shell 端转：second-instance 转发后主实例的 `process.cwd()` 是 .app 安装目录或 `/`，不是用户 PWD）
- `$# == 0` → `set -- new`（裸调用 `agent-deck` 等价于 `new --cwd "$PWD"`）；首参以 `--` 开头 → `set -- new "$@"`（自动补 `new`）
- `exec` 二进制把剩余参数原样传，single-instance lock 决定是新启动还是 second-instance 转发

### 默认 prompt = "你好"

- `cli.ts` 把 `CliNewSession.prompt` 从 `?: string` 改成必选 `string`，缺省值 `'你好'`（`asString(...) ?? '你好'`）
- 之前裸跑 `agent-deck` 时 SDK 拿不到首条 user message 会卡 30s fallback；改后立刻发起对话
- 显式 `--prompt ''` 仍尊重为空（asString 返 `''`，`??` 不触发），保留 escape hatch

## 备注

- renderer 接收 focus event 时机：主进程在 `createSession` resolve 后才 emit，SDK createSession 一般要等几秒，listener 已注册；只有 `--resume` 等极快路径理论可能丢事件（可接受）
