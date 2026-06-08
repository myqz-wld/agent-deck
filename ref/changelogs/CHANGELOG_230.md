# CHANGELOG_230: Summary / Hand-off 支持 Deepseek + SDK 升级

## 概要

周期性总结和 UI Hand-off 简报的 provider 选择扩展为 Claude / Deepseek /
Codex 三档；Deepseek 走 `deepseek-claude-code` adapter 与独立
`~/.agent_deck/.deepseek/settings.json` 环境覆盖。同步升级 Codex SDK 与
Claude Agent SDK，并按提示词资产维护规则收紧相关 README / prompt 文案。

## 变更内容

- 设置类型与 UI：`summaryProvider` / `handOffProvider` 增加 `deepseek`，
  Settings 的 provider 下拉展示 Claude / Deepseek / Codex，reasoning 控件仍只在
  Codex provider 下生效。
- Summary 路由：`Summarizer` 的 provider 映射从二分支改为三分支，
  `deepseek` 分派到 `deepseek-claude-code` adapter。
- Hand-off 路由：UI 生成 hand-off brief 时同样支持 `deepseek` provider，
  通过 `deepseek-claude-code` adapter 执行。
- Deepseek adapter：新增 `summariseEvents`，summary / hand-off 均复用 Claude
  oneshot runner，并注入 Deepseek 专属 env 覆盖；系统 prompt 的 agent identity
  从 Claude 扩展为 Claude / Deepseek / Agent。
- 依赖升级：
  - `@openai/codex-sdk` `^0.135.0` -> `^0.137.0`
  - `@anthropic-ai/claude-agent-sdk` `^0.3.158` -> `^0.3.168`
- 提示词资产：更新 README / resources 说明与 oneshot prompt builder，去掉本轮命中的
  stale / 模糊词；本地生成 prompt-asset inventory 与备份，补充 base-state 备份记录。
- Review-agent validation 收口：reviewer-codex 发现 Hand-off 节名 / README haiku /
  handoff-runner 行号 3 条非阻塞漂移，reviewer-claude 发现 orphan systemPrompt export；
  均已修复，双 reviewer 均确认 0 CRITICAL/HIGH/MEDIUM。
- 流程图：新增 [summary-handoff-provider-flow.puml](../flows/summary-handoff-provider-flow.puml)，记录
  summary / hand-off provider 分流与 Deepseek env overlay。

## 验证

- `pnpm typecheck`
- `pnpm build`
- `pnpm exec vitest run src/main/adapters/deepseek-claude-code/__tests__/summarise-events.test.ts src/main/session/__tests__/hand-off.test.ts`
- `plantuml --check-syntax ref/flows/summary-handoff-provider-flow.puml`
- prompt 资产关键词自检：stale / 模糊 / 示例重复三组 `rg` 均无命中。
- 本地 markdown 链接检查通过；系统 Ruby 仅输出 `/opt/homebrew` world-writable PATH 警告。
- simple-review 异构验证：reviewer-codex + reviewer-claude 均 0 blocking；LOW/INFO 已处理后重跑
  `pnpm typecheck` / 目标 vitest / `pnpm build`。
