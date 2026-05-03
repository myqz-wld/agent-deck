# CHANGELOG_53: deep-code-review skill 引导 lead 走 teammate 通路（修 PendingTab 拿不到 reviewer-codex Bash 审批）

## 概要

用户实测：跑 `agent-deck:deep-code-review` skill 时 `reviewer-codex` 失败，Bash 在 SDK 上游就被 deny，PendingTab 完全没触发。db events 双会话工具调用对比硬证根因：lead 这次只调 `Agent(subagent_type, prompt)`（单参数 = 纯 subagent 通路），没先 `TeamCreate` 也没传 `team_name + name` 字段；而上一次成功的会话明确 `TeamCreate` + `Agent(subagent_type, name, team_name, prompt)` 四件齐（in-process teammate 通路，写 inbox → inbox-watcher → PendingTab）。`Agent` 工具是 SDK 双模工具：带 `team_name + name` 走 teammate；不带退化成纯 subagent，subagent 内部 Bash 不回调 lead 的 canUseTool，直接被 SDK 默认 settings.json 权限策略 deny。

为什么 lead 走错：原 SKILL.md §Step 2 用「自然语言指令 in-process backend」+ 模板示意引导 spawn teammate，但通篇没出现 `TeamCreate` 工具名、没说「必须先建 team」、没列出 `Agent` 工具的四个字段不可缺；反而 §Fallback 节模板齐全（`Task(subagent_type: ..., prompt: ...)`），lead 看不到 §Step 2 的具体姿势就直接套用了 §Fallback 模板，触发降级。

修法仅改文档（plugin 注入路径，已开），不动应用代码（通路本身没坏，上一次同 lead 同 skill 完全工作过）。

## 变更内容

### `resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md`

- §Step 2 整节重写：拆「Step 2.1 先调 `TeamCreate(team_name, description)`」+「Step 2.2 同一 message 并发两次 `Agent(subagent_type, name, team_name, prompt)`」两步走，明确「四个字段缺一不可」+ ❗ 红字标注「不传 `team_name` 退化成纯 subagent，PendingTab 永远不会触发」
- §Step 2 末尾加「自检」段：拿不到 `TeamCreate` 才退 §Fallback，不要自己用 `Agent(subagent_type, prompt)` 单参数硬撑
- §Fallback 节顶部加 ❗ 必读警告：明确「日常 review 默认走 §Step 2；Fallback 仅在 `TeamCreate` 工具确实不可用时用；subagent 模式下 reviewer-codex Bash 必挂 PendingTab 不会触发，这是 SDK 双模设计不是应用 bug」

### `resources/claude-config/agent-deck-plugin/agents/reviewer-codex.md`

- §使用形态表格下加「Bash 权限通路差异」段：明确 A subagent / B teammate 两种形态下 Bash 的不同走向（前者走 SDK 默认 deny；后者走 inbox 协议 → PendingTab）
- 失败兜底方向：第一次 Bash 失败 = 大概率 lead 用了 subagent 模式，不要重试，按 §失败兜底 报「请改用 teammate 模式」让 lead 决策

### `resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md`

- 同样加「Bash 权限通路差异」段（对称维护，reviewer-claude 偶尔也用 Bash 跑 git diff / pnpm test）
- 失败应对方向：subagent 模式 Bash 受限时优先用 Read/Grep/Glob 替代；finding 必须走 Bash 且反复被拒 → 标 *未验证: subagent 模式 Bash 受限* 自降为非 HIGH，结尾建议 lead 切 teammate

## 备注

- 用户 settings 里 `injectAgentDeckClaudeMd: false` —— `resources/claude-config/CLAUDE.md` 没注入到 lead system prompt，所以这次修复唯一生效路径是 plugin 注入（`injectAgentDeckPlugin: true` 当前开着）；CLAUDE.md 不动
- 不改应用代码：通路本身没坏，坏的是 lead 引导文档没说清楚
- 不动 settings.json 默认 allow list 加 `Bash(zsh:*)`：只在 subagent fallback 路径有效，全局放开 zsh 大放权，收益 < 风险，teammate 通路根本不需要
- 不改 reviewer-codex frontmatter `tools: Bash, Read`：已经声明对了，问题不在 frontmatter
- 端到端验证需要重启应用（plugin 注入只在 session 启动时读，已运行 lead 改了 SKILL.md 不生效），用户体验方式：发「跑一轮 deep-code-review」→ 期望 lead 第一动作 `TeamCreate`，第二动作 `Agent` × 2 带 team_name → reviewer-codex 调 codex CLI 时弹 PendingTab
