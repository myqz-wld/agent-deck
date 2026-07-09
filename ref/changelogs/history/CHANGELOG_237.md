# CHANGELOG_237: Codex steer 收敛到主输入框

## 概要

Codex 会话的 mid-turn steering 不再渲染单独「修正」输入框。SessionDetail
保留一个主输入框，且 Codex adapter 的 `sendMessage` 自己做 active-turn 路由：
当前普通 turn 正在运行且无附件时自动发 `turn/steer`；否则仍按普通消息排队下一轮。

## 变更内容

- `ComposerSdk` 删除独立 steer input，统一用主 textarea 承载普通发送和 Codex steer；
  UI 提交也统一走 `sendAdapterMessage`。
- Codex bridge `sendMessage` 增加 active-turn 判定：当前存在 `currentTurnId` 且本条消息
  不带附件时，直接调用 app-server `turn/steer` 并 emit `{ steer: true }` user message。
- busy Codex steer 模式下，发送按钮文案切为「修正」，placeholder 明示当前是修正当前
  turn；steer 失败时把文本回填到同一个输入框。
- steer 模式暂时隐藏图片上传入口，并阻止带图片修正，避免 `turn/steer` 不支持附件时静默丢图。
- 补 renderer 组件测试，覆盖 busy / idle 都统一走 `sendAdapterMessage`，以及失败回填文本。
- 补 Codex bridge 测试，覆盖 active turn 下 `sendMessage` 自动 steer，以及 active turn
  带附件时仍入队以保留附件。
- 更新 `codex-mid-turn-steering-flow.puml` 与 `sdk-bridge-architecture.puml`，把独立
  steer IPC 的旧路径改为 `sendMessage` active-turn 路由。
- 更新 README 的 Codex CLI 输入说明，移除“单独修正输入框”的当前行为描述。

## 验证

- `pnpm exec vitest run src/renderer/components/SessionDetail/__tests__/ComposerSdk.test.tsx`
- `pnpm exec vitest run src/main/adapters/codex-cli/__tests__/wire-prefix-e2e.test.ts`
- `pnpm typecheck`
- `pnpm build`
- `plantuml -checkonly ref/flows/codex-mid-turn-steering-flow.puml ref/architecture/sdk-bridge-architecture.puml`
- `git diff --check`
