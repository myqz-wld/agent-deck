# CHANGELOG_274

## 数据 tab 静默读取 provider 额度

### 概要

数据 tab 在没有已打开 Claude / Codex 会话时，重新支持后台读取 provider 额度，但改为独立静默探针：不创建 Agent Deck 会话、不写 session/event/token_usage 记录，也不发送用户消息或模型 turn。

### 变更内容

- Claude 额度读取新增后台 helper：启动 streaming-input SDK Query，输入流不产出任何 user message；初始化后只调用 SDK usage control request，随后关闭 Query。
- Claude helper 监听 auth / user-dialog 类 control request；一旦 provider 要交互授权，立即中止并返回 error snapshot，避免继续推进隐藏流程。
- Codex 额度读取新增后台 helper：启动 transient app-server client，只调用 `account/rateLimits/read`，不调用 `thread/start` / `thread/resume` / `turn/start`。
- Claude / Codex bridge 仍优先复用 live 会话；没有 live 会话时才走静默探针。
- README 同步说明 Data tab 的静默额度读取边界。

### 验证

- `pnpm exec vitest run src/main/adapters/codex-cli/__tests__/background-usage-snapshot.test.ts src/main/adapters/claude-code/__tests__/background-usage-snapshot.test.ts src/main/adapters/codex-cli/__tests__/usage-snapshot.test.ts src/main/adapters/claude-code/__tests__/usage-snapshot.test.ts src/main/ipc/__tests__/provider-usage.test.ts src/main/adapters/__tests__/provider-usage.test.ts src/renderer/components/__tests__/DataPanel.test.tsx`
- `pnpm typecheck`
