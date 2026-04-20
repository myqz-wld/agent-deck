# CHANGELOG_15: 间歇总结优先用 haiku 模型

## 概要

`summariseViaLlm` 之前没传 `model`，会按 `~/.claude/settings.json` 的 `ANTHROPIC_MODEL`（往往是 sonnet 4.5 / opus 4.7）跑总结。一段一句话总结调最贵的模型不划算，改成优先走 haiku：成本低 15-20 倍，吐字也快，扫描里多个会话排队不会堆积。

模型选取优先级：
1. `process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL` —— 用户 settings.json 里通常已配的 haiku 具体版本（bootstrap 时由 `applyClaudeSettingsEnv()` 注入到 process.env）
2. `process.env.ANTHROPIC_MODEL` —— 没配 haiku 但配了主模型时退而求其次，至少能跑
3. `'haiku'` alias 兜底 —— 让什么都没配的环境也能跑，由 SDK / CLI 自己解析

这样用户在 settings.json 升级 haiku 版本（4.5 → 5.x）时不用改代码。

## 变更内容

### src/main/session/summarizer.ts
- `summariseViaLlm` 的 `sdk.query({ options: ... })` 加 `model: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || process.env.ANTHROPIC_MODEL || 'haiku'`
- 注释说明三层优先级与各自的设计动机

### README.md
- 「间歇 LLM 总结」节降级策略 1 行补充：模型选取链 `ANTHROPIC_DEFAULT_HAIKU_MODEL` → `ANTHROPIC_MODEL` → `'haiku'` alias 兜底


