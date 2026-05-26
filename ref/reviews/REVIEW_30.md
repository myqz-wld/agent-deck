---
review_id: 30
reviewed_at: 2026-05-13
expired: false
skipped_expired:
heterogeneous_dual_completed: true
---

# REVIEW_30: deep-code-review SKILL 三件套 + 两份 CLAUDE.md 异构对抗 review × 大规模文档减肥

## 触发场景

用户实测 deep-code-review SKILL 时被 `§Step 0.6 spawn 前权限自检`（要求 lead cat ~/.claude/settings.json grep 白名单 + 三选一决策）激怒：「跟权限有个 P 的关系，写这么多代码和权限校验有个脑残用」「起个对抗 review 优化下这个破 skill」。

随后用户继续要求对 `~/.claude/CLAUDE.md` + `resources/claude-config/CLAUDE.md` 两份 CLAUDE.md 一并起异构对抗 review，看有没有同样的过度防御 / 重复 / 文档密度过载问题。

## 方法

**双对抗配对**（见 `~/.claude/CLAUDE.md`「决策对抗」节）：
- **Reviewer A**：reviewer-claude（外部 `claude -p < prompt`，Opus 4.7 xhigh）
- **Reviewer B**：reviewer-codex（外部 `codex exec`，gpt-5.5 xhigh，read-only sandbox）

**实现路径**：双 Bash run_in_background 并发起外部 CLI（**不**走 SKILL teammate —— review SKILL 自身用 SKILL teammate 反讽 + teammate 编排开销大无收益）。两轮 review：
- 轮 1：SKILL.md + reviewer-claude.md + reviewer-codex.md（607 行 doc）
- 轮 2：~/.claude/CLAUDE.md + resources/claude-config/CLAUDE.md（1303 行 doc）

**范围**：5 个 doc 文件，共 1910 行。

```text
Round 1（SKILL 三件套）:
- resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md (282 行)
- resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md (132 行)
- resources/claude-config/agent-deck-plugin/agents/reviewer-codex.md (193 行)

Round 2（CLAUDE.md 双份）:
- ~/.claude/CLAUDE.md (624 行)
- resources/claude-config/CLAUDE.md (679 行)
```

**机器可读范围**（File-level Review Expiry 用）：

```review-scope
CLAUDE.md
changelog/CHANGELOG_79.md
conventions/INDEX.md
conventions/tally.md
resources/claude-config/CLAUDE.md
resources/claude-config/README.md
resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md
resources/claude-config/agent-deck-plugin/agents/reviewer-codex.md
resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md
reviews/REVIEW_30.md
```

> ~/.claude/CLAUDE.md + ~/.claude/templates/ + ~/.claude/SOPs/ 不属本仓库版本控制范围，scope 不收录（修法已落 user scope；本 review frontmatter 仅追踪本仓库内文件）。

**约束**：仅审 doc 设计 / 文档密度 / 同步漂移 / agent 负担；不审实现代码；不允许「换工具 / 重写整套 / 弃用」类建议。

## 三态裁决结果

> 本节遵循全局「决策对抗」节 §Finding 输出契约 验证纪律。两轮 review 双方共识极高（HIGH 几乎全部双方独立提出），无单方独有 HIGH，未触发反驳轮。

### Round 1：SKILL 三件套（17 ✅）

#### ✅ HIGH（5 条，双方独立提出）

| # | 文件:行号 | 问题 | A 视角 | B 视角 | 验证手段 |
|---|---|---|---|---|---|
| H1 | SKILL.md:88-104 §Step 0.6 | spawn 前权限自检：把真人 PendingTab 一键批 Bash 包装成 lead cat ~/.claude/settings.json + grep + 三选一决策 + 失败 fallback 链 | claude H1 | codex H1 | 引用 SKILL.md 17 行整节；reviewer-codex.md:22 已写「Bash 失败时弹给真人审批走自己 session 的 PendingTab」即足够 |
| H2 | SKILL.md:158-182 §Step 2.5 | cold-start 30s 探测：lead 在 wait_reply 之外又起 setTimeout 自己轮询 get_session.lastEventAt — SDK init 慢是真人 / SDK 该处理 | claude H2 | codex H2 | 引用 SKILL.md 25 行整节 |
| H3 | SKILL.md:262-274 §失败兜底 | 7 大类失败里 5 类是 mcp tool schema error / SDK lifecycle / 跨会话 stranded reviewer 救火，不属 review 流程 | claude H3 | codex H3 | 引用 SKILL.md 13 行；mcp tool schema 自描述 error |
| H4 | SKILL.md:113-131/137-152/198-215/222-241 | 4 个 TS 代码块复述 mcp tool schema，lead 是 agent 不是 JS runtime，不会执行这些代码 | claude L3+H4 部分 | codex H4 | 引用 SKILL.md 4 段约 80 行 TS 代码 |
| H5 | 3 文件 607 行 | lead 跑一次 SKILL 之前要读 282 行 SKILL.md 已超「双 Bash CLI 单次决策对抗」成本 — SKILL 反过来劝退用户 | claude H4 | codex H5 | 行数计算 + 内容重叠观测 |

#### ✅ MED（4 条）

| # | 文件:行号 | 问题 | A | B | 验证 |
|---|---|---|---|---|---|
| M1 | SKILL.md:79-86 + reviewer-*.md §核心纪律 | worktree 路径陷阱 4 层防御（教 lead 写 scope / lead 抽样校验 / reviewer-claude 自检 abort / reviewer-codex 自检 abort）—— reviewer 自检 abort + warn 一层就够 | claude M1 | codex M1 | 现场 grep reviewer-{claude,codex}.md:34/36 worktree 自检条已强制 |
| M2 | SKILL.md:55-68 §对话锚点 | wire format 协议同时在 SKILL + reviewer-claude + reviewer-codex + 应用 CLAUDE.md 4 处定义 | claude M2 | codex M2 | grep 4 处定义 |
| M3 | SKILL.md:42-48/254-260 + reviewer-*.md | 三态裁决/输出约束 5 处重复（弱断言 / 不接受没验证 ✅ HIGH 等） | claude L5 + 部分 | codex M3 | grep 5 处出现 |
| M4 | reviewer-codex.md:177-193 反模式表 | 13 行反模式 70% 与 §核心纪律 / §codex CLI 调用模板 / §失败兜底 强约束重复 | claude M4 | codex M4 | 现场对比每条反模式 vs 核心纪律 |

#### ✅ LOW（8 条）

包括：弱断言关键词重复 / §反驳轮反向排除法 / §与决策对抗节关系重复 / list_sessions 反向解释 / mktemp 三处重复 / §核心设计 callout 重复 / subagent 废弃说明 / Fresh session 教学碎片化

### Round 2：两份 CLAUDE.md（15 ✅）

#### ✅ HIGH（4 条，双方独立提出）

| # | 位置 | 问题 | A | B | 验证 |
|---|---|---|---|---|---|
| H1 | A:5（同步约定）+ A:171 已漂移 | 「改一处同步另一处」机器无法执行已发生漂移；A:171 比 user 同节多整段「合规兜底（仍异构）」 | claude H1 | codex H3 | 现场对比两份内容差异 |
| H2 | A:171 | SKILL 「合规兜底」反向爬进 CLAUDE.md，对绝大多数不走 SKILL 的 lead 是噪音 | claude H3 | codex H2 | 该段功能仅 deep-code-review SKILL 用 |
| H3 | U §Agent Teams (~30 行 inbox 协议) vs A §Universal Team Backend (~60 行 mcp 协议) | 同会话两套 backend 协议同时载入 system prompt 语义打架 | claude H2 | codex H4 | 加载顺序 user → project → app 都进同一 system prompt |
| H4 | A:265-277/296/320 | worktree 路径陷阱同节 3 处重复 ~30 行 | claude H4 | codex M2 | grep 3 处累计 30 行重复 |

#### ✅ MED（6 条）

M1 wire/regex/DB invariant 协议 housekeeping (codex H1 单方+现场验证) / M2 6 markdown 模板 222 行 / M3 reviewer 模板 50 行 bash heredoc / M4 大任务拆小批踩坑历史 / M5 项目治理 SOP（File-level Review Expiry 17 行脚本 + 单文件大小护栏 + 反馈 tally）/ M6 顶层「不主动创建 .md」与后文流程冲突

#### ✅ LOW（5 条）

弱断言关键词重复 / §反驳轮排除法 / §与其他机制 meta 解释 / §TeamDelete 异步说明 / 顶部 HTML 注释加载到 system prompt

### ❓ 部分 / 未验证

| 来源 | 内容 | 处置 |
|---|---|---|
| Round 2 Claude U1 | SOP / 模板抽离到外部文件后，agent 真要用时仍需 `Bash: cat` 读一次。如某些 SOP 触发频次高 → 搬走是负收益。建议搬迁前对最大候选做真实使用频次估算 | 用户授权「全做」，决定按建议落地 + 留观察后续频次。如有负反馈再回收 |

### ❌ 反驳

无（双 reviewer 共识高，无 HIGH 单方独有，未触发反驳轮）。

## 修复（CHANGELOG_79 落地）

### Round 1（SKILL 三件套）

- **H1/H2/H3/H4/H5/M1-M4/L1-L8**：SKILL.md 282 → **92 行**（瘦 67%）；reviewer-claude.md 132 → **129 行**；reviewer-codex.md 193 → **184 行**

### Round 2（两份 CLAUDE.md）

- **H1（核心，最大单点收益）**：应用 CLAUDE.md 5 大通用节整段删，头部 1 行覆盖「按 user CLAUDE.md 执行 + 应用专属差异」。CLI user → project → app 加载顺序保证 user 内容已先入 system prompt
- **H2**：A:171「合规兜底」整段删（已剪入 SKILL.md `§失败兜底`）
- **H3**：user `~/.claude/CLAUDE.md` 删 §Agent Teams 节
- **H4**：worktree 路径陷阱 3 处重复合并到 `§Step 1` 末**唯一一处** callout
- **M1**：A `§Universal Team Backend` 内 wire format / regex / DB invariant 缩 3 句，详细协议指向 `docs/agent-deck-mcp-protocol.md`
- **M2/M3/M5（外迁）**：6 markdown 模板 + 2 reviewer bash 模板 → `~/.claude/templates/`；File-level Review Expiry 自检脚本 + 单文件大小护栏 + 拆批教训 → `~/.claude/SOPs/`
- **M4/M6/L1-L5**：CLAUDE 内压缩 / 合并 / 移走 HTML 注释 / 顶层创建 .md 加例外

### 总瘦身

| 文件 | 旧 | 新 | 减幅 |
|---|---|---|---|
| `~/.claude/CLAUDE.md` | 624 | 267 | -57% |
| `resources/claude-config/CLAUDE.md` | 679 | 56 | -92% |
| `SKILL.md` | 282 | 92 | -67% |
| `reviewer-claude.md` | 132 | 129 | -2% |
| `reviewer-codex.md` | 193 | 184 | -5% |
| **总计** | **1910** | **728** | **-62%（1182 行）** |

外迁 11 个文件到 `~/.claude/templates/`（8 个）+ `~/.claude/SOPs/`（3 个）。

### 附加：conventions-tally 隔离 + conventions/ 独立目录（用户中途两次新需求）

第一次：用户要求「不要跟着 claude 走了」→ `git mv .claude/conventions-tally.md ./conventions-tally.md`（项目根单文件）。

第二次：用户要求「跟 plan 一样单独起一个目录吧，升级的东西也放这个目录下，不往 CLAUDE.md 放了，这样解耦一些，CLAUDE.md 尽量是静态的」→ `git mv conventions-tally.md conventions/tally.md` + 新建 `conventions/INDEX.md`（与 changelog/ reviews/ plans/ 同级，git 管理）。**升级流程也改**：count ≥ 3 → 新建 `conventions/<X>-<topic>.md`（X 递增）+ 同步 `conventions/INDEX.md`，**不再**写到项目 CLAUDE.md。

同步改 9 处引用：项目 CLAUDE.md ×4 + user CLAUDE.md ×4 + 3 个 templates（conventions-tally.template.md + project-claude.template.md + review.template.md）。

## 关联 changelog

- [CHANGELOG_79.md](../changelogs/CHANGELOG_79.md)：本次落地

## Agent 踩坑沉淀（如有）

本次 review 提炼出 1 条 agent-pitfall 候选（升 conventions-tally）：

- **doc 把真人 UI 操作转嫁给 agent 前置自检**（典型反例：要求 lead cat 文件检查环境配置 + 三选一决策、起 setTimeout watchdog 监控 SDK 启动、复述协议细节让 agent 解析 wire format）—— 这是把 SDK / mcp / 真人本该处理的事接过来当 agent 流程，过度防御 + 文档密度过载。下次写 SKILL / CLAUDE 约定前自检：「这步是 agent 该自动化的、还是真人 UI 一键就能搞定的？」

后续：观察是否再撞 → tally `count` +1，到 3 走升级。
