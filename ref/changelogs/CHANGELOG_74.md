# CHANGELOG_74: claudeCodeSandbox per-session 覆盖 + 运行时切档（与 codex 对称三件套）+ 抽 restart-controller sub-module

## 概要

把 Claude Code OS 沙盒（macOS Seatbelt / Linux bubblewrap）补齐到与 Codex 沙盒同等用户工程姿势 — **三件套**：① 全局默认（设置面板，已有）+ ② 新建会话覆盖（NewSessionDialog 4 档下拉，新增）+ ③ 会话内运行时冷切（ComposerSdk 下拉，新增）。复用 codex `restartWithCodexSandbox` 整套模板字面镜像（DB / IPC / adapter / preload / channel / UI），ConfirmDialog 策略反向（codex 切到 `danger-full-access` 才弹，claude 切到 `off` 才弹，两者都是「关闭沙盒约束 = 放宽」）。

顺带抽 `RestartController` sub-module（与 CHANGELOG_52 PermissionResponder / SessionRecoverer / StreamProcessor 同模式 helper）含 `restartWithPermissionMode` + `restartWithClaudeCodeSandbox` 两个语义同构的冷切方法，sdk-bridge/index.ts 净 -50 LOC（866 → 816）朝 ≤500 行护栏方向走。

## 变更内容

### DB / 持久化

- 新建 `src/main/store/migrations/v013_sessions_claude_code_sandbox.sql` — `ALTER TABLE sessions ADD COLUMN claude_code_sandbox TEXT`，与 v008 codex_sandbox 同模式
- `migrations/index.ts` 加 v013 import + 数组项
- `main/store/session-repo.ts` 多处镜像 codex setter 模式：
  - `Row` interface 加 `claude_code_sandbox: string | null` 字段（紧挨 codex_sandbox）
  - `rowToRecord` 映射 `claudeCodeSandbox`（带 union 字面量 cast）
  - `upsert` SQL：列清单 17 → 18 列 / VALUES 加 `@claude_code_sandbox` / ON CONFLICT UPDATE SET 加 / `.run({})` 加；同步注释里「17 列 = 17 个 ?」更新为「18 列 = 18 个 ?」
  - 新方法 `setClaudeCodeSandbox(id, sandbox)`，紧挨 setCodexSandbox
  - `rename`：列清单 17 → 18 列 + ? 占位 17 → 18 + `.run` 顺序加 + spawn-chain dup block 加 codex_sandbox 同款的 claude_code_sandbox 复制（CHANGELOG_35 `14 values for 13 columns` 教训严守 ? 数 = 列数）

### shared 类型

- `shared/types/session.ts`：`SessionRecord` 加 `claudeCodeSandbox?: 'off' | 'workspace-write' | 'strict' | null` 字段（紧挨 codexSandbox）
- `shared/ipc-channels.ts`：加 `AdapterRestartWithClaudeCodeSandbox: 'adapter:restart-with-claude-code-sandbox'`

### IPC 层

- `main/ipc/adapters.ts`：
  - import `parseSandboxMode`（**已存在** `_helpers.ts:91`，零新增校验函数）
  - `AdapterCreateSession` handler 加 `const claudeCodeSandbox = parseSandboxMode(raw.claudeCodeSandbox)` + spread 透传
  - 新 handler `AdapterRestartWithClaudeCodeSandbox` 完整镜像 `RestartWithCodexSandbox`：校验 capability + 三档 union + 委托 `adapter.restartWithClaudeCodeSandbox(sid, sb, prompt)`
- `preload/index.ts`：加 `restartWithClaudeCodeSandbox` facade（4 参数，与 codex 字面镜像）

### Adapter capability + 接口

- `main/adapters/types.ts`：
  - `CreateSessionOptions` 加 `claudeCodeSandbox?: 'off' | 'workspace-write' | 'strict'` 字段（紧挨 codexSandbox）
  - `AdapterCapabilities` 加 `canRestartWithClaudeCodeSandbox: boolean` 字段（紧挨 canRestartWithCodexSandbox）
  - `AgentAdapter` 接口加 `restartWithClaudeCodeSandbox?(sessionId, sandbox, handoffPrompt): Promise<string>` 方法签名
- `claude-code/index.ts`：capability 加 `canRestartWithClaudeCodeSandbox: true` + createSession opts 加 `claudeCodeSandbox?` 字段透传 + 加 `restartWithClaudeCodeSandbox` 方法委托 bridge
- `codex-cli/index.ts` / `aider/index.ts` / `generic-pty/index.ts`：capability 同步加 `canRestartWithClaudeCodeSandbox: false`（接口 `AdapterCapabilities` required 字段）

### claude-code sdk-bridge 改造（含拆分）

- **新建 `claude-code/sdk-bridge/restart-controller.ts`**（279 LOC sub-module）：
  - 导出 `RestartController` class + `RestartCtx` 接口
  - 持 `restartWithPermissionMode`（从 sdk-bridge/index.ts 整体搬过来）+ `restartWithClaudeCodeSandbox`（新写，模仿 codex `restartWithCodexSandbox` 6 步骨架：emit 占位 → close → 写 DB → createSession resume → 失败回滚 + emit error）
  - ctx 注入 facade 共享 `recovering` Map（与 SessionRecoverer 同 ref，单飞 Map 跨多个 sub-module 共享）
  - thunk 反调 facade 的 `closeSession` / `createSession`，避免循环引用
- `claude-code/sdk-bridge/index.ts`（866 → 816 LOC，**净 -50**）：
  - 加 `import { RestartController, RestartCtx } from './restart-controller'`；删 `eventBus` import（restart 实现搬走后不再用）
  - 加 `private restartController: RestartController` field
  - 构造函数 init：先 init RestartController（PermissionResponder wrapper 需要拿 ctx thunk），ctx 注入 `recovering` / `emit` / closeSession thunk / createSession thunk
  - PermissionResponder wrapper 改为 `(sid, mode, prompt) => this.restartController.restartWithPermissionMode(sid, mode, prompt)`（CHANGELOG_52 Step 3f「拆 lifecycle 时改成 ctx thunk」终于落地）
  - createSession opts 加 `claudeCodeSandbox?` 字段
  - **sandbox 读取改 fallback 链**：原 `settingsStore.get('claudeCodeSandbox') ?? 'off'` 改为 `opts.claudeCodeSandbox ?? sessionRepo.get(opts.resume)?.claudeCodeSandbox ?? settingsStore.get('claudeCodeSandbox') ?? 'off'`（与 codex 模式字面对齐）；变量提到 try 块外让后面 setClaudeCodeSandbox 能引用
  - emit session-start 之后加 `sessionRepo.setClaudeCodeSandbox(realId, claudeSandboxMode)` try/catch（与 codex setCodexSandbox 同款持久化）
  - 删原 `restartWithPermissionMode` 实现（~100 LOC），替换为 thin delegate
  - 加 `restartWithClaudeCodeSandbox` thin delegate

### Renderer UI

- `NewSessionDialog.tsx`：
  - 加 `ClaudeSandboxChoice` type + `CLAUDE_SANDBOX_OPTIONS` 4 档
  - useState `claudeCodeSandbox`
  - `showClaudeCodeSandbox = agentId === 'claude-code'` 条件
  - submit 时透传 `claudeCodeSandbox: showClaudeCodeSandbox && claudeCodeSandbox ? claudeCodeSandbox : undefined`
  - 新 Field「OS 沙盒（macOS Seatbelt / Linux bubblewrap）」紧挨 codex sandbox Field
- `SessionDetail/ComposerSdk.tsx`：
  - 加 `claudeCodeSandbox` state 读 session.claudeCodeSandbox（默认 `'off'`）+ `csClaudeBusy` / `csClaudeError` state
  - `supportsClaudeCodeSandbox = agentId === 'claude-code'` 条件
  - `changeClaudeCodeSandbox(next)` 方法：confirm 策略反向（切到 `'off'` 才弹「关闭 OS 沙盒 = 放宽 = 与 codex `danger-full-access` 同性质」），调 `window.api.restartWithClaudeCodeSandbox`
  - 加 sandbox 下拉 UI 紧挨 codex sandbox 块（label「沙盒」与 codex 同标签，靠 `agentId` 区分）
  - 加 `csClaudeError` display block 紧挨 csError 块

### README

- 「OS 级沙盒」一节改为「三件套对称」描述：① 全局默认 ② 新建会话覆盖 ③ 会话内运行时切档（5-10s 冷切重启 SDK 子进程，切到 `off` 弹 confirm）
- 「实验功能」节 Claude Code 沙盒条改「全局默认 + per-session 覆盖 + 运行时切档（CHANGELOG_74，与 Codex 对称三件套）」

## 不动文件保护清单

- `src/main/adapters/claude-code/sdk-bridge/index.ts`（**仍 816 行超 500 行护栏**）
  - 本次抽 restart-controller 已朝拆分方向走（净 -50 LOC），剩下大方法 `createSession`（~280 LOC）+ `closeSession` + `sendMessage` + `interrupt` + `setPermissionMode` + 5 个 respond/list 方法
  - **真不能立刻拆**：剩下方法都依赖 facade class state（`sessions: Map<string, InternalSession>` / `recovering: Map<string, Promise<unknown>>` / `permissionTimeoutMs`）+ 5 个 sub-module 注入 ctx（PermissionResponder / SessionRecoverer / StreamProcessor / RestartController），强行再拆 = 拆 class（CLAUDE.md 风险升序第 3 档），需独立 plan + 异构对抗
  - 下次拆分轮可考虑：`createSession` 方法体大约 280 LOC，可抽出 `SessionFactory` sub-module（与 RestartController 同模式 helper），拆完后 sdk-bridge facade 应到 ~530 LOC

## 验证步骤

1. **typecheck**：`pnpm typecheck` 必须通过 ✅
2. **DB migration v013 自检**：dev 启动后 `sqlite3 ~/Library/Application\ Support/agent-deck/agent-deck.db "PRAGMA user_version; .schema sessions"` 应看到 user_version=13 + `claude_code_sandbox TEXT` 列
3. **NewSessionDialog 实测**：新建 claude 会话选 `strict` → SessionDetail 看 `[sandbox] mode=strict → enabled (top-level)` log + 试 `cat /etc/passwd` 应被 OS 沙盒拒
4. **ComposerSdk 切档实测**：claude 会话内切到 `off` → confirm 弹框 → 同意 → SDK 重启 → handoff prompt 触发首条 turn → log 显示 `mode=off → disabled (no field)`；切回 `workspace-write` 不 confirm
5. **持久化实测**：切档后重启 dev → resume 会话下拉值还原原档位（持久化到 DB v013）
6. **新建 codex 会话回归**：「跟随设置（默认）」/ 三档全档位仍工作（不破坏既有）
7. **重新打包 .app + ad-hoc 重签 + xattr** 走完整生效流程（按项目 CLAUDE.md「打包与本地安装」节）
