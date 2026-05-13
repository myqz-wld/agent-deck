# Agent Deck MCP — protocol stub

> 本文件**已降级为 stub**（2026-05-14，CHANGELOG_98）。原 R2 阶段 ADR 完整版（45KB / 13 节）历史价值已耗尽：
> - 真实 wire schema + 字段语义 by `src/main/agent-deck-mcp/tools/schemas.ts` —— 这才是单一信源（SSOT），改 schema 一刀同步 system prompt 给 SDK 看的 tool description
> - 跨进程协议字段约束（wire format / regex / DB invariant）by reviewer-{claude,codex}.md「核心纪律」节
> - lead 角度调用姿势 + spawn_session 首轮锚点 + send_message ack 字段 + wait_reply by message id by 应用 CLAUDE.md（`resources/claude-config/CLAUDE.md`）
> - SKILL 编排范式 by `resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md`
>
> 维护完整 ADR + 5 份运行时文档**长期漂移成本极高，收益接近零**：所有运行时 caller（lead agent / teammate / SKILL）都从 schemas.ts 注入的 tool description 里看真实约束，没人去 fetch 这份 .md。完整版 ADR 已通过 git history 永久保留（commit 5db9844 之前任意 ref 即可拉回，最近一次见 `git log -- docs/agent-deck-mcp-protocol.md`）。

---

## 真实 SSOT 路径表

| 想了解什么 | 看哪 |
|---|---|
| 全部 10 个 mcp tool 的 input/output schema + 每个字段的实际语义 | `src/main/agent-deck-mcp/tools/schemas.ts` |
| lead agent 怎么调（spawn / send / wait / shutdown / archive_plan / start_next_session 三件套姿势 + 首轮锚点 + 跨会话救火 + ack 字段） | `resources/claude-config/CLAUDE.md` §Agent Deck Universal Team Backend |
| teammate 端协议约束（wire format `[msg <id>] from <Lead-NN>` 注入 / reply_message regex 抓 messageId / DB messages.body 不含 wire prefix invariant / id charset 不变量 / NO MSG ANCHOR fallback） | `resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md` 与 `reviewer-codex.md` 各自的「核心纪律」节 |
| 多轮 deep code review 的 SKILL 编排（teammate 模式 7 步 / 异构对抗 / 三态裁决 / R2 fix 回路 / R3 反驳轮 / timer fallback / 失败兜底） | `resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md` |
| 单次决策对抗（Bash 起外部 CLI 双对抗）的姿势 | `~/.claude/CLAUDE.md` §决策对抗 |
| 跨会话 hand off / worktree 隔离 / archive_plan / start_next_session 在通用流程中的定位 | `~/.claude/CLAUDE.md` §复杂 plan |

## 为什么 stub 而不是删除

文件被多处历史 commit message / changelog / 老 plan 引用为锚点（典型 `docs/agent-deck-mcp-protocol.md §X.Y`）；保留文件名 + 留指针避免 dead link，新增协议层细节不再往这里堆。

如有 ADR-style 决策记录需求（边界 / trade-off / 已知争议）请走 `reviews/REVIEW_X.md` 形态走「决策对抗」流程沉淀。
