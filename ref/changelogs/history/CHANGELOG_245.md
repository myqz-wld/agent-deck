# CHANGELOG_245

## Claude Fable alias support

## 概要

Claude Code 官方已支持 `fable` alias 与 `ANTHROPIC_DEFAULT_FABLE_MODEL`。本次检查项目内现有模型链路，补齐当前会影响 Fable 识别 / 配置的窄口径改造。

## 变更内容

- `normalizeModel` 识别 `claude-fable-5` / `fable`，token 统计 bucket 从未知模型归一为 `fable-5` / `Fable 5`。
- 用户自定义 Claude agent 资产编辑器模型下拉加入 `fable`，并同步相关共享类型注释。
- Deepseek Claude-compatible profile 默认注入 `ANTHROPIC_DEFAULT_FABLE_MODEL=deepseek-v4-pro[1m]`，并支持顶层 `fableModel` 覆盖字段；README 同步说明默认 alias 映射。
- 确认 MCP `spawn_session` schema / adapter-scoped model 校验已经支持 Claude `fable`，无需再改 tool schema。

## 验证

- `pnpm vitest run src/shared/__tests__/model-normalize.test.ts src/main/adapters/deepseek-claude-code/__tests__/summarise-events.test.ts`
