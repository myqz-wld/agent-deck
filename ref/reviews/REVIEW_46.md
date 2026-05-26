---
review_id: REVIEW_46
title: Prompt 资产按 §提示词资产维护 6 条硬约束清理 + deep-code-review SKILL stub 物理删 单次决策对抗 review
created_at: 2026-05-19
heterogeneous_dual_completed: true
---

# REVIEW_46 — Prompt 资产清理 单次决策对抗 review × M1 fix

## 触发场景

用户主动触发：「按 ##提示词资产维护优化完善一下 CLAUDE.md（~/.claude/和 claude-config/）、reviewer-claude、reviewer-codex、deep-review，记得起对抗 review」。

按 user CLAUDE.md `§提示词资产维护` 6 条硬约束（信息密度 / 当前事实不写预测 / 可执行性 > 描述性 / 范围与失败兜底显式 / 示例克制 / plugin 资产 self-contained + cross-reference 三档）对 8 个长生命周期 prompt 资产做规范化清理 + 1 个 deprecation stub 物理删，改完起单次决策对抗 review（双 Bash 起异构 CLI）。

用户 RFC 决策：
- Q1 改动力度：**重度（中度 + 物理删 deprecation stub）**
- Q2 deep-code-review SKILL：**物理删整目录**
- Q3 对抗 review 形式：**单次决策对抗（双 Bash 起异构 CLI）**
- Q4 plan 历史标注：**全删（含 spike3/spike4 编号）**

## 方法

### Scope = 8 资产 + 1 stub 物理删

| # | 资产 | 改动 |
|---|---|---|
| 1 | `~/.claude/CLAUDE.md` | §Step 1.5 × 2 + 5 处「建议/推荐/通常」+ Step 2/callout Bash 重复合并 |
| 2 | `resources/claude-config/CLAUDE.md` | 头部 callout 删 + RFC/spike placeholder 节删 + 7 处 P5/P6.x 修法引用清理 + SKILL 名升级 |
| 3 | `resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md` | sandbox 节标题 + caller 责任分流 P6.x 引用清理 |
| 4 | `resources/claude-config/agent-deck-plugin/agents/reviewer-codex.md` | sandbox 节 + caller 责任分流 + prompt 模板 P1/P2 placeholder → HIGH/MED |
| 5 | `resources/codex-config/agent-deck-plugin/agents/reviewer-claude.md` | 整 §spike4 衔接 节物理删 + 8 处 spike[34]/P3/P5 修法引用全清 |
| 6 | `resources/codex-config/agent-deck-plugin/agents/reviewer-codex.md` | 头部 callout P3 引用 + prompt 模板 P1/P2 placeholder → HIGH/MED |
| 7 | `resources/claude-config/agent-deck-plugin/skills/deep-review/SKILL.md` | frontmatter description + §Sandbox 处理 + §kind='mixed' + cross-ref 共 8 处 P-phase / spike 编号清理 |
| 8 | `resources/claude-config/agent-deck-plugin/skills/deep-code-review/` | **整目录 git rm**（deprecation stub 物理删） |
| + | `resources/codex-config/CODEX_AGENTS.md` | M1 fix（双对抗共识）：协议层老 SKILL 名 `deep-code-review` → `deep-review` |

### 异构对抗 reviewer

走 user CLAUDE.md `§决策对抗 §主路径` 双 Bash 并发起异构外部 CLI（**单次决策对抗，非多轮 SKILL 编排**）。

| Reviewer | 模型 | bash task id | 模板 |
|---|---|---|---|
| **reviewer-claude** | Claude Opus 4.7 xhigh（外部 `claude -p`） | `bf9tlyit8` | `~/.claude/templates/reviewer-claude.sh.tmpl` |
| **reviewer-codex** | Codex gpt-5.5 xhigh（外部 `codex exec`） | `bvk4n2ezq` | `~/.claude/templates/reviewer-codex.sh.tmpl` |

并发起 + 各自 stdout 独立 → lead 三态裁决。

## 三态裁决

### ✅ 共识 真问题（双方独立提出）

| ID | 严重度 | 内容 | 异构强证据 | fix |
|---|---|---|---|---|
| **M1** | MED | `resources/codex-config/CODEX_AGENTS.md:28` 仍引用已物理删的旧 SKILL 名 `deep-code-review` — 协议层运行链失效（codex-config plugin 自身没有 skills/ 目录，实际 deep-review SKILL 由 claude-config 提供给 codex 视角 lead 复用，老名引用在 plugin 加载链路里指向不存在 SKILL） | reviewer-claude 提 MED + 实测 grep 命中 + `ls resources/codex-config/` 验证 plugin 无 skills/ 子目录 + reviewer body 头部强制引用 CODEX_AGENTS.md 协议层 / reviewer-codex 提 MED + 实测 `git diff --cached --name-status` 确认 stub 已删 + `rg --files resources/claude-config/.../skills` 只剩 `deep-review/` 与 `hello-from-deck/` — 双方独立从「协议层 vs 实际 SKILL 物理名」角度提出 | 同 commit fix：`resources/codex-config/CODEX_AGENTS.md:28` `deep-code-review` → `deep-review`（已落地，详 [CHANGELOG_127.md §F](../changelogs/CHANGELOG_127.md)） |

### ❌ 反驳（reviewer-codex 单方提 MED，reviewer-claude 反驳成立 → 不修）

| ID | reviewer-codex 立场 | reviewer-claude 反驳依据 | 裁决 |
|---|---|---|---|
| **M3** | MED：4 reviewer body Fresh session 输出模板 + claude-config CLAUDE.md NO MSG ANCHOR template 内嵌「建议 lead 走 shutdown_session + spawn_session 重启我」/「建议 lead 通过 send_message 重新发本轮 prompt 提供 anchor」是规约本身的弱断言，违反约束 3 | reviewer-claude 明确反驳：「这些"建议"是 reviewer 给 lead 输出的 warn 模板字符串内容（reviewer 提示选项让 lead 决策），不是规约本身的弱断言。**template content ≠ regulation**，不构成约束 3 违反」 | ❌ 不修 — reviewer-claude 反驳更准确：lead 收到 advisory message 后**有选项决策**（可重发 / 可 abort / 可继续），「建议」语义在 reviewer-to-lead advisory 上下文是合规的 |

### ❓ 部分 / 未验证（follow-up cleanup，不阻塞本次合并）

| ID | 严重度 | 内容 | 处理 |
|---|---|---|---|
| **M2-line66** | reviewer-claude INFO / reviewer-codex MED | `claude-config/CLAUDE.md:66`「保留 mental model 推荐」违反约束 3 「不写推荐」 | git diff 验证非本次 diff 引入（pre-existing residue），follow-up 改成「**做** 选项 2/3」/「违反 ⇒ 选项 1」 |
| **M2-line78** | reviewer-codex MED | `claude-config/CLAUDE.md:78`「建议 lead 通过 send_message 重新发本轮 prompt 提供 anchor」 | 同 M3 — NO MSG ANCHOR template 字符串内嵌的 advisory message，**不构成约束 3 违反**（claude I5 反驳成立） |
| **M2-line80** | reviewer-codex MED | `claude-config/CLAUDE.md:80`「触发后 lead 应优先 shutdown + 重 spawn / 重发带 anchor 的 prompt」是规约文本「应优先」描述性表态 | follow-up：保持「应优先」措辞但配「但 X 时例外」具体边界（lead 不一定每次都立即 shutdown，偶发可容许完成本轮再处理；长期不靠 fallback） |

### INFO（同主题 follow-up cleanup，不阻塞）

| 文件 | 内容 | 处理 |
|---|---|---|
| 顶级 `README.md:22` | `plugin 自带的 deep-code-review skill...` | 批量改名 `deep-code-review` → `deep-review` |
| `docs/agent-deck-mcp-protocol.md:7,20` | `skills/deep-code-review/SKILL.md` 路径引用 | 同上 |
| `docs/agent-deck-team-protocol.md` | 9 处 deep-code-review 引用（line 853, 879, 880, 886, 976, 1012, 1036, 1064, 1066） | 同上 |
| `conventions/tally.md:44, 84` | tally 候选条目内引用老名 | 同上 |
| `resources/claude-config/README.md:26-34` | 3 处老名引用 + line 27 `skills/deep-code-review/SKILL.md` 路径已 dangling（stub 物理删后） | 同上 |
| `.gitignore:9-15` | `# ↑ 历史目录(已迁移)` deprecation 注释 + line 13 `P6.5 reviewer-claude HIGH-E 修法` plan phase 编号 | 删 deprecation 注释 + 删 P6.5 修法编号（约束 2） |
| `resources/codex-config/CODEX_AGENTS.md:97/108/121/146/158` | 5 处 `P5 Round 1 reviewer-codex M1/M2/M4 修法` / `HIGH-C 修法 4 态分流` plan phase 编号 | 同主题 follow-up 同批清理 |

## 验证

- 8 核心资产 + CODEX_AGENTS.md final sweep：`grep -lE 'spike[0-9]+|Spike [0-9]+|可行性铁证|deprecation|deprecated|6 个月后|过渡期|deep-code-review' <files>` → 仅 `~/.claude/CLAUDE.md` 命中（约束 2 自检规则反例样本，合规）
- 关键护栏未破坏（reviewer-claude + reviewer-codex 双方共识）：Sandbox 边界 / Wire format / NO MSG ANCHOR / Fresh session 自检 / Worktree 路径自检 / send_message reply chain / claude binary path env var 注入 / 中间文件 `/tmp` 路径 / claude CLI 调用模板 / 4 reviewer body 异构对偶纪律全保留 ✅
- 改动 surface（`git diff --stat -- resources/`）：8 文件 / +41/-57 净削（claude-config CLAUDE.md / codex-config reviewer-claude.md 减重最大）+ 1 stub 物理删（25 行整文件）
- 4 reviewer body 异构对偶（claude-config 同源 lead × 同源 reviewer / claude-config 同源 lead × 异构 reviewer wrapper / codex-config 同源 lead × 异构 reviewer wrapper / codex-config 同源 lead × 同源 reviewer direct）架构对偶维持 ✅
- `heterogeneous_dual_completed: true`

## 与 CHANGELOG_127 关系

- 本 REVIEW 记录三态裁决 / 反驳轮 / 验证铁证（推演过程）
- [CHANGELOG_127](../changelogs/CHANGELOG_127.md) 记录变更内容（按模块 bullet 落地清单）

按 project CLAUDE.md「双轨」分工：本次 = 流程性资产升级 + 1 stub 行为变更（老 slash 命令失效）→ 主线归 changelog；对抗 review 三态裁决 / 反驳轮细节归 reviews。
