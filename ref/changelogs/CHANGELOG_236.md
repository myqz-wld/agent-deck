# CHANGELOG_236: Codex app-server mid-turn steering

## 概要

Codex live adapter 从 `codex exec --experimental-json` / `@openai/codex-sdk`
streamed turn path 迁到 `codex app-server --stdio` JSON-RPC 长连接，新增 active
turn mid-turn steering：Codex 忙碌时 SessionDetail 显示单独「修正」输入框，Enter 发送
`turn/steer` 注入当前 turn，而不是排队下一轮普通消息。

## 变更内容

- 新增 `src/main/adapters/codex-cli/app-server/`：
  - `client.ts` spawn `codex app-server --stdio`，管理 JSON-RPC request id、
    initialize、notification dispatch、`thread/start` / `thread/resume`、
    `turn/start` / `turn/steer` / `turn/interrupt`。
  - `translate.ts` 将 app-server notification 翻译成现有 `AgentEvent`，并保留
    token usage / command output / item completed 等事件语义。
- Codex bridge 改为 per-session app-server client，`InternalSession` 增加
  `currentTurnId`；`turn/started` 捕获 active turn id，`turn/completed` / fatal
  error 清理，`steerTurn(sessionId,text)` 以 `expectedTurnId` 调 `turn/steer`。
- adapter capability / IPC / preload / renderer 全链路新增 steering：
  `canSteerTurn`、`adapter:steer-turn`、`window.api.steerAdapterTurn`、busy Codex
  composer 的独立「修正」输入。
- app-server 参数按生成协议校正：普通 `turn/start` 带 `cwd`、`approvalPolicy`、
  `sandboxPolicy`、`model`；`turn/steer` 不带 turn-level override。
- app-server 子进程异常退出后清理 process / initialize 状态并 bump generation；后续 turn
  会先 `thread/resume` 重新加载 thread，再继续 `turn/start`。
- Codex live token-rate 支持 app-server delta / completed / token usage
  notification。
- 更新 `README.md`、`resources/codex-config/CODEX_AGENTS.md`、
  `resources/claude-config/CLAUDE.md`，说明 active 普通 turn 可 steer，review /
  compact 不可 steer，steer 不是 teammate 等待机制。
- 更新 PlantUML SSOT：
  - `ref/architecture/sdk-bridge-architecture.puml`
  - `ref/flows/codex-mid-turn-steering-flow.puml`

## 验证

- `pnpm typecheck`
- `pnpm build`
- `pnpm test:node src/main/adapters/codex-cli/sdk-bridge/__tests__/live-token-rate.test.ts src/main/adapters/codex-cli/sdk-bridge/__tests__/thread-options-builder.test.ts src/main/adapters/codex-cli/__tests__/per-session-codex-env.test.ts src/main/adapters/codex-cli/__tests__/sdk-bridge.consume-fork.test.ts src/main/adapters/codex-cli/__tests__/wire-prefix-e2e.test.ts`（47 tests）
- `plantuml -checkonly ref/architecture/sdk-bridge-architecture.puml ref/flows/codex-mid-turn-steering-flow.puml`
- `git diff --check`
