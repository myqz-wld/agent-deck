# CHANGELOG_265: AskUserQuestion 支持用户备注

## 概要

Agent Deck 的 Claude Code / Deepseek AskUserQuestion 卡片新增独立「备注」输入。用户选择选项后可补充自由文本备注，主进程会把备注随同选项和「其他」答案一起拼进现有 SDK bridge 回答文本，确保 Claude 能在稳定的 `deny.message` 通路里收到备注。

## 变更

- `AskUserQuestionAnswer.answers[]` 新增 `note?: string` 字段，保持原 `selected` / `other` 兼容。
- `AskRow` 新增每题备注 textarea，提交时按 question 带回主进程。
- `formatAskAnswers()` 输出新增 `备注：...` 段，并 trim 空白备注。
- 新增 formatter 单测覆盖「选项 + 其他 + 备注」共存和空白备注省略。

## 验证

- `pnpm vitest run src/main/adapters/claude-code/sdk-bridge/__tests__/sdk-bridge-helpers.test.ts`
- `pnpm typecheck`
