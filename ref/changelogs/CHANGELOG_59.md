# CHANGELOG_59: NewSessionDialog 删模型下拉 + Codex 新增 per-session 沙盒下拉

## 概要

新建会话弹框两个对称改动：(1) 彻底删除「模型」入口——UI 下拉、CLI `--model` flag、
IPC `raw.model` 解析、各 adapter / sdk-bridge 入参、SDK `query({ model })` 透传一次性
全删，让 Claude Code CLI 子进程自己读 `~/.claude/settings.json` 的 model 字段；
(2) Codex CLI 新增「权限模式 (sandbox)」per-session 下拉，三档直接映射 codex SDK
原生 SandboxMode（workspace-write / read-only / danger-full-access），覆盖
`settings.codexSandbox` 全局值。Codex SDK 不支持 canUseTool 等价回调，sandboxMode
才是真正能起作用的「权限」旋钮，approvalPolicy 暴露反而误导用户。

## 变更内容

### `src/renderer/components/NewSessionDialog.tsx`

- 删 `MODEL_OPTIONS` 常量、`model` state、`showModel` 计算、模型 select Field
- submit 时不再传 `model` 参数
- 加 `CodexSandboxChoice` 类型 + `CODEX_SANDBOX_OPTIONS` 常量（含「跟随设置」+ 三档）
- 加 `codexSandbox` state + `showCodexSandbox = agentId === 'codex-cli'` 计算
- 加新 Field「权限模式 (sandbox)」，仅 codex-cli adapter 时显示
  （与 `showPermissionMode` 天然互斥：codex `canSetPermissionMode=false`）
- submit 按需透传 `codexSandbox`（空字符串 = 跟随设置 = 不传）

### `src/main/cli.ts`

- 删 `CliNewSession.model?` 字段
- `VALUE_REQUIRED_FLAGS` 删 `'model'`
- `parseCliInvocation` 删 `asString(f.get('model'))` 解析
- `applyCliInvocation` 删 `model: inv.model` 透传

### `src/main/ipc/adapters.ts`

- import `parseCodexSandboxMode`（已有 helper，复用 `CODEX_SANDBOX_MODE_VALUES` 白名单）
- `AdapterCreateSession` handler 删 `raw.model` 解析与 `model` 透传
- 加解析 `raw.codexSandbox`，按需透传给 `adapter.createSession`
- `null` = 不传字段 → adapter 用 settings.codexSandbox 全局值

### `src/main/adapters/types.ts`

- `CreateSessionOptions` 删 `model?` 字段
- 加 `codexSandbox?: 'workspace-write' | 'read-only' | 'danger-full-access'` 字段，
  注释标明「仅 codex-cli adapter 接收并起效；其它 adapter 忽略」（与 teamName 同模式 —
  通用接口兜，adapter 自行决定是否实现）

### `src/main/adapters/claude-code/{index,sdk-bridge/index,sdk-bridge/recoverer}.ts` + `__tests__/sdk-bridge.test.ts`

- `createSession opts` 删 `model?` 字段（4 处签名同步）
- SDK `query({ options })` 删 `model: opts.model` 透传，Claude CLI 子进程自己读
  ~/.claude/settings.json 默认 model

### `src/main/adapters/codex-cli/{index,sdk-bridge/index}.ts`

- `createSession opts` 删 `model?` 字段（2 处签名同步）
- `codex.startThread()` 删 `model: opts.model` 透传，codex CLI 子进程自己读
  ~/.codex/config.toml 默认 model
- bridge `createSession` 加 `codexSandbox?` 参数
- 解析 `effectiveSandboxMode = opts.codexSandbox ?? this.currentSandboxMode`
  （per-session 覆盖优先；undefined 走全局）
- 仅新建路径（`startThread`）透传；resume 路径不传（resumeThread 不接 sandboxMode，
  老 thread 沙盒 spawn 时已锁死）

### `README.md`

- CLI 用法表删 `[--model <name>]` 行

## 备注

- **彻底删 `model` 入参**：UI / CLI / IPC / adapter / SDK 五层全删，不留兼容口子。
  Claude / Codex 各自的 CLI 子进程会读各自配置文件（~/.claude/settings.json /
  ~/.codex/config.toml）的 model 字段——应用层不再有任何"默认模型"概念
- **设计取舍：为什么不暴露 codex `approvalPolicy`**：codex SDK 是单工通道，
  不支持 canUseTool 等价回调（capabilities.canRespondPermission=false 已表明），
  应用层无法接收/响应审批事件——选 `on-request` / `on-failure` / `untrusted`
  在我们的应用里跟 `never` 没行为差别（codex 子进程内部弹的 TUI 审批 UI 不可达）。
  暴露反而误导。sandboxMode 是 OS 级真隔离，是对用户负责的「权限」旋钮
- **typecheck 通过**：`pnpm typecheck` ✅
