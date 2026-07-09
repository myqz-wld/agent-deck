# CHANGELOG_184 — Phase E 续：codex 契约节 α（CODEX_AGENTS.md 补 §决策对抗/§三态裁决/§Finding 输出契约）

> plan deep-review-and-asset-polish-20260530 §Phase E §Phase-D-遗留（Q3 决策对抗结论 = α）。CHANGELOG_183 决策对抗 Q3 双 reviewer（claude Opus 4.7 + codex）一致裁决 α，本 changelog 落地实施。

## 背景（Q3 决策对抗结论）

claude-config/CLAUDE.md **自包含** §决策对抗 / §三态裁决 / §Finding 输出契约；但 CODEX_AGENTS.md **缺这三节**。codex SDK 会话只加载 `~/.codex/AGENTS.md`（= CODEX_AGENTS.md），**不**加载 claude-config/CLAUDE.md（CODEX_AGENTS.md 自陈「codex 端无 ~/.claude/CLAUDE.md 自动加载机制」）。两个真断链：

- **codex 普通会话「下结论前决策对抗」零覆盖**：claude 侧此规则被双覆盖（claude-config baseline + user ~/.claude/CLAUDE.md），codex 侧 CODEX_AGENTS.md 无 §决策对抗 + codex 无 user-global 机制 + deep-review SKILL 是 multi-round 错工具 → 一个没 invoke SKILL 的 codex lead 做定性判断/plan 时无任何决策对抗指引（claude reviewer 决定性论据）
- **codex deep-review SKILL + reviewer-codex 4 处 cross-ref 指向 `resources/claude-config/CLAUDE.md`「完整契约 SSOT」**：该裸 repo-relative 路径无 `{{AGENT_DECK_RESOURCES}}` 占位不参与打包替换，打到别项目时 codex 既不能 cat、内容也不在 context → 断链

fact①（两端独立 SSOT 不 sync）本身支持 α：CODEX_AGENTS.md §plantUML / §task / §plan cold-start 已各写 codex 风格副本，这三节是唯一漏补的（属 gap 不属设计）。fact③（adapter 相关）坐实：claude-config §决策对抗 主路径写死 `claude -p / Bash run_in_background / AskUserQuestion`，codex 必须有 adapter-flavored 版本（`shell` / 无 AskUserQuestion / shell 后台 wait）。

## 变更内容

### CODEX_AGENTS.md 补 §决策对抗 节（codex 风格，插在 §应用环境特有能力 与 §核心流程必走 plantUML 之间，镜像 claude-config 顺序）

非照抄 claude 版，按 codex adapter 改写：
- **§主路径：双 shell 起异构外部 CLI**：codex lead 用 `shell` 起两个外部 CLI（reviewer-claude `claude -p` + reviewer-codex `codex exec`），异构由两路 reviewer 物理保证，lead adapter 无关
- **§外部 CLI 对抗通用姿势（codex 端）**：登录式 shell / 非交互+只读约束（claude 用 `--permission-mode default` + `--disallowedTools ExitPlanMode` 非 plan-mode，完整 flag 以 `.sh.tmpl` 模板为准）/ 绝对路径 / 分离答案与日志 / reasoning 最高档 / stdin / **codex shell 并发用 `&`+`wait`（codex 无 run_in_background task-notification）** / **命令体内绝不写 `timeout`/`gtimeout`** / 大 scope 拆批
- **§反驳轮 + 三态裁决**：忠实 port（lead 替 claude 的「主 agent」措辞）
- **§Finding 输出契约**：忠实 port（文件:行号 + 验证手段 + 5 档严重度 + 弱断言只许 *未验证* 条目）
- **§reviewer 失败兜底**：「严禁同源双 reviewer」对称 enforce + cross-ref §应用环境特有能力 合规兜底节

### 4 处 cross-ref 改指向 CODEX_AGENTS.md 同文件（不再断链到 claude-config）

- `skills/deep-review/SKILL.md:120`「完整契约 SSOT：resources/claude-config/CLAUDE.md §决策对抗 §三态裁决 + §Finding 输出契约」→「应用 CODEX_AGENTS.md §决策对抗 §三态裁决 + §Finding 输出契约（codex 端 baseline，已注入 system prompt）」
- `skills/deep-review/SKILL.md:197`「…§Finding 输出契约」→ 应用 CODEX_AGENTS.md §Finding 输出契约
- `skills/deep-review/SKILL.md:215`「详 …§决策对抗 主路径」→ 应用 CODEX_AGENTS.md §决策对抗 主路径
- `agents/reviewer-codex.md:80`「与 …§Finding 输出契约 节一致」→ 与 应用 CODEX_AGENTS.md §Finding 输出契约 节一致

## 验证

- 纯 .md 资产改动无 TS delta → typecheck N/A
- α 内容是 claude-config 已建立/在用的 §决策对抗 三节的 adapter-port（Q3 决策对抗已审「写 codex 版 shell/exec/turn 边界」approach，codex reviewer 原话）：逐节比对 claude-config 源保真 + adapter 调整正确（双 shell / shell &+wait 并发 / read-only flag 引模板避 drift / 无 timeout 命令体）
- grep 自检：codex SKILL/reviewer 零残留指向 claude-config 契约三节 cross-ref；新节 5 约束（兼容/预测/弱可执行）干净；§决策对抗 节 headings 完整
- ⚠️ 建议用户 spot-check 新 §决策对抗 节的 adapter 措辞（codex shell 并发/超时语义）

## 未纳入 α（仍 follow-up）

- **CODEX_AGENTS.md:213/235 §复杂 plan workflow §Step 4 §中止 手工归档 cross-ref**：codex 读不到 claude-config §复杂 plan workflow（~250 行大节），但 archive_plan 工具自动化常见路径、manual archive 是罕见 fallback → 不照搬整节进 codex（避免大量重复）；归 F5 同族 follow-up 评估
- **F5 广义内部名残留清理**（CHANGELOG_183 已记）：两文件 class.method/内部编号/DB 列名等纯实现符号清理，需 careful pass 单独 follow-up
