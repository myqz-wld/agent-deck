# CHANGELOG_79: deep-code-review SKILL + 两份 CLAUDE.md 大规模文档减肥

## 概要

承 REVIEW_30 落地：5 个核心 doc 文件 1910 → 728 行（瘦 62%），把项目治理 SOP / markdown 模板 / reviewer bash 模板共 11 个文件外迁到 `~/.claude/{templates,SOPs}/`；废弃应用 CLAUDE.md 与 user CLAUDE.md 间的人工同步约定（机器无法执行已漂移），改为 user CLAUDE.md SSOT + 应用 CLAUDE.md 只放 Δ 应用专属差异。

核心动机：用户实测 deep-code-review SKILL 时被「Step 0.6 spawn 前权限自检」（要求 lead 提前 cat settings.json + grep 白名单 + 三选一决策）激怒 → 异构对抗 review 系统揭露这套文档体系的 4 类病：(1) 把真人 UI 操作转嫁给 agent 前置自检；(2) 同主题多处重复→维护漂移风险；(3) 文档密度过载，agent 学习成本超过手动操作成本；(4) 把 SDK / mcp / 真人本该处理的事接过来当 agent 流程。

## 变更内容

### resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md（282 → 92 行）

- 删 §Step 0.5 worktree 适配整节（reviewer 端 abort + warn 已强约束足够）
- 删 §Step 0.6 spawn 前权限自检整节（真人 PendingTab 一键批 Bash 即可）
- 删 §Step 2.5 cold-start 30s 探测整节（SDK init 慢是真人 / SDK 该处理）
- 删 §对话锚点 messageId + wire format 表（lead 不解析 wire format，只用返回值 messageId）
- 4 个 TS 代码块（Step 1/2/4/5）改成 6 步流程 checklist 表（lead 是 agent 不是 JS runtime）
- §失败兜底 7 大类表 → 4 行（reviewer-codex 失败 / FRESH SESSION / SCOPE PATH MISMATCH / wait_reply 超时；其余 mcp error 走 schema 自描述）
- §与决策对抗节的关系 缩到 1 段
- §核心设计「不要两个 Claude」反白删（与 §失败兜底 重复）

### resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md（132 → 129 行）

- 删 subagent 废弃 callout（缩到 1 句）
- §核心纪律 第 9 条 wire format 详节指向应用 CLAUDE.md SSOT
- §反模式 后 3 行（裸 message reply / 主动调 send_message / 没扫 wire prefix）合并到 1 行

### resources/claude-config/agent-deck-plugin/agents/reviewer-codex.md（193 → 184 行）

- 删 subagent 废弃 callout（缩到 1 句）
- §反模式表 13 → 5 行（仅保留 §核心纪律 / §codex CLI 调用模板 / §失败兜底 没显式覆盖的边界）
- mktemp $TMPDIR 3 处重复合一（核心纪律 11 + 模板注释 + 反模式表 → 仅模板注释保留，反模式表删除该行）
- §大 scope 拆批 简化（明确「拆批职责：默认调用方拆」）

### resources/claude-config/CLAUDE.md（679 → 56 行）

- **删 5 大通用节**（输出 / 运行时 / 决策对抗 / 复杂 plan / 工程地基 / 模板）—— CLI 加载顺序 user → project → app 保证 user CLAUDE.md 内容已先入 system prompt，无须复制
- 头部 HTML 注释从「同步约定」改为「只放应用专属差异，不复制」（详细维护说明挪 `resources/claude-config/README.md`）
- §决策对抗 §reviewer-codex 失败兜底「合规兜底（仍异构）」整段删（剪到 SKILL.md `§失败兜底`）
- §Agent Deck Universal Team Backend 节缩：wire format 协议表 / regex / DB invariant 详细描述指向 `docs/agent-deck-mcp-protocol.md`（lead 不需关心）
- 留 2 节：§应用环境差异（Δ user CLAUDE.md）+ §Agent Deck Universal Team Backend

### resources/claude-config/README.md（新建）

新建维护说明文档，吸收原 HTML 注释里的同步约定 + 设计原则解释：

- 应用环境约定的设计原则（只放 Δ 不复制 user CLAUDE.md）
- 历史「人工同步约定已废弃」的决议来源（REVIEW_30 H1）
- 改动维护流程（改通用约定走 user CLAUDE.md / 改应用差异走本仓库）

### ~/.claude/CLAUDE.md（624 → 267 行）

- 顶层「不主动创建 .md 文件」加例外说明：CLAUDE 流程触发的 plan / changelog / review / conventions-tally 除外
- §决策对抗 → §主路径 reviewer-{claude,codex} bash 模板（~50 行 heredoc）外迁到 `~/.claude/templates/reviewer-{claude,codex}.sh.tmpl`，正文留模板路径指针
- §决策对抗 §大任务必须拆小批 6 条 bullet 缩到 1 句并入 §通用姿势（详细教训外迁 `~/.claude/SOPs/codex-cli-stuck-lessons.md`）
- §决策对抗 §反驳轮 + §三态裁决 + §强制约束 合并为 §Finding 输出契约（弱断言关键词只在这里定义一次）
- §决策对抗 §反驳轮「不触发 5 种情形」反向排除法删（直接推断三态定义即可）
- 删 §Agent Teams 整节（应用 CLAUDE.md 已有 §Universal Team Backend 覆盖，user 全局不该承载应用专属协议）
- §复杂 plan §Step 1 worktree 路径陷阱合并为**唯一一处** callout（`§Step 2 / §Step 3` 引用此处，删 2 处重复约 20 行）
- §与其他机制的关系 删「区分 plan 一词两种用法」 callout
- §模板节 6 份 markdown 模板（~220 行）外迁到 `~/.claude/templates/`，正文 1 句指针
- §新项目工程地基 §已审文件过期 自检脚本 17 行外迁到 `~/.claude/SOPs/file-level-review-expiry.sh`，正文摘要规则
- §新项目工程地基 §单文件大小护栏 详细外迁到 `~/.claude/SOPs/file-size-guardrail.md`，正文 1 句

### ~/.claude/templates/（新建，8 个文件）

- `project-claude.template.md` —— 项目 CLAUDE.md 模板
- `changelog-index.template.md` / `reviews-index.template.md` —— INDEX 模板
- `conventions-tally.template.md` —— tally 模板
- `changelog.template.md` / `review.template.md` —— 单条 CHANGELOG / REVIEW 模板
- `reviewer-claude.sh.tmpl` / `reviewer-codex.sh.tmpl` —— 单次决策对抗用的 reviewer bash 模板（双 Bash 起外部 CLI）

### ~/.claude/SOPs/（新建，3 个文件）

- `file-level-review-expiry.sh` —— Agent 在「下一轮 review」第一步必跑的 expiry 自检脚本
- `file-size-guardrail.md` —— 500 行护栏 + 3 档拆分 + 不动文件保护清单
- `codex-cli-stuck-lessons.md` —— 大任务 stuck 踩坑教训完整版

### 附加：conventions-tally 隔离 + conventions/ 独立目录（用户中途两次新需求）

第一次：用户要求「不要跟着 claude 走了」→ `git mv .claude/conventions-tally.md ./conventions-tally.md`（项目根单文件）。

第二次：用户要求「跟 plan 一样单独起一个目录吧，升级的东西也放这个目录下，不往 CLAUDE.md 放了，这样解耦一些，CLAUDE.md 尽量是静态的」→ `git mv conventions-tally.md conventions/tally.md` + 新建 `conventions/INDEX.md`（与 changelog/ reviews/ plans/ 同级 git 管理）。**升级流程也改**：`conventions/tally.md` count ≥ 3 → 新建 `conventions/<X>-<topic>.md`（X 递增整数）+ 同步 `conventions/INDEX.md` + 从 tally 删该条；**不再**写到项目 CLAUDE.md「项目特定约定」节，让 CLAUDE.md 保持静态。

同步改 9 处引用：项目 CLAUDE.md ×4（tally 路径 ×2 + 升级目的地表格 + 流程 step 2）+ user CLAUDE.md ×4（目录骨架 + 候选位置 + 流程 step 2 + 表格 SSOT）+ 3 个 templates（conventions-tally.template.md / project-claude.template.md / review.template.md）。

## 备注

- **应用打包验证（待用户跑）**：H1 改动后需重启应用走一遍验证 user CLAUDE.md 通用约定能正确入 SDK 会话 system prompt。流程：`pnpm dist` → 装新 .app → 起会话验证日常约定（中文回复 / 决策对抗触发 / worktree 等）依然生效
- **❓ 待观察**：M2/M3/M5 模板 / SOP 外迁后，agent 真要用时仍需 `Bash: cat` 读一次。如典型 SDK 会话以「短任务 / 一次性查询」为主则收益正；如以「长 review / 多次新建 CHANGELOG」为主可能负收益。后续观察使用频次决定是否回收
- 应用 CLAUDE.md 与 user CLAUDE.md 同步漂移风险**根因消除**（从机器无法执行的「人工同步约定」改为 user SSOT + app Δ）
- 详细 review 决议见 [REVIEW_30.md](../reviews/REVIEW_30.md)
