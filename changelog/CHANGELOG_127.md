# CHANGELOG_127 — Prompt 资产按 §提示词资产维护 6 条硬约束清理 + deep-code-review SKILL stub 物理删

## 概要

按 user CLAUDE.md `§提示词资产维护` 6 条硬约束（信息密度 / 当前事实不写预测 / 可执行性 > 描述性 / 范围与失败兜底显式 / 示例克制 / plugin 资产 self-contained + cross-reference 三档）对 8 个长生命周期 prompt 资产做规范化清理 + 1 个 deprecation stub 物理删 + 1 处协议层老 SKILL 名修复（M1 双对抗共识 fix）。

涉及资产：user CLAUDE.md / app CLAUDE.md / 4 reviewer body（claude-config × 2 + codex-config × 2）/ deep-review/SKILL.md / codex-config CODEX_AGENTS.md。本次双对抗 review 三态裁决 + 反驳轮 + 1 ✅ M1 fix + 1 ❌ M3 反驳 + follow-up cleanup 见 [REVIEW_46.md](../reviews/REVIEW_46.md)。

## 变更内容

### A. user CLAUDE.md（~/.claude/CLAUDE.md，单独维护不在本 repo）

- **§Step 1.5 Deep-Review × 2 处**：删 `plan codex-handoff-team-alignment-20260518 P6.7 改名,老名 6 个月 deprecation stub` 时间窗口预测语，直接说「invoke 应用环境提供的 deep-review SKILL」（约束 2）
- **§Step 1 plan 文件位置 × 2 处**：「**项目内 git 归档版（推荐 completed 落此）**」→「**项目内 git 归档版（completed 落此）**」；「**强烈建议** `.gitignore` 加 `.claude/plans/`」→「`.gitignore` 必加」（约束 3）
- **§Step 1 plan-id 命名**：「`<plan-id>` 命名建议 `<topic>-<YYYYMMDD>`」→「`<plan-id>` 命名 `<topic>-<YYYYMMDD>`」（约束 3）
- **§Step 2 stale base bug callout 主路径 (b) Bash 块合并**：与 §Step 2 主体（行 211-219）重复，callout 改成 reference §Step 2 主体节（约束 1 信息密度）
- **§Step 2 主体 P6.5 reviewer-codex MED-1 修法引用**：删（约束 2）
- **§stale base bug 追溯**：「上游 bug 跟踪建议报...」→「上游 bug 跟踪走... GitHub issue」（约束 3）
- **§选项 B 自动接力 tool**：「应用 build 时通常把工具 description 注入...」→ 删「通常」（约束 3）
- **§选项 B cold start prompt 加载**：「应用 SDK 会话通常通过 `settingSources: ['user', ...]` 自动满足」→ 删「通常」（约束 3）

### B. 应用 CLAUDE.md（resources/claude-config/CLAUDE.md）

- **头部第 3 段 callout 整删**：「**复杂 plan 流程（v2 RFC + spike + Deep-Review 前置）详 user CLAUDE.md ...**（plan codex-handoff-team-alignment-20260518 P6 升级，2026-05-19）」整段 callout 删除（约束 1 + 约束 2 时间窗口预测）
- **§应用环境 RFC / spike 差异 整 placeholder section 删**：「当前与 user CLAUDE.md §RFC 前置 / §spike 前置 同款,本应用环境无 SDK 会话专属差异。」是 0 信息密度空话节（约束 1）
- **§reviewer-codex 失败兜底 SKILL 名升级**：`deep-code-review` → `deep-review`
- **§NO MSG ANCHOR 退化路径 P5 Round 1 reviewer-claude INFO 修法引用**：删（约束 2）；同步删尾巴「不是 bug」防御性自辩（约束 3）
- **§enter_worktree / exit_worktree 节**：删「P1 加的」/「P6.5 reviewer-codex MED-D 修法 — schema 实际字段是 `base_commit / base_branch` 两字段而非旧 `base?`」/「archive_plan 4 态预检场景 C 必需 — 见 plan §不变量 5」3 处历史标注（约束 2）
- **§archive_plan 调用签名**：删「P6.5 reviewer-codex LOW-1 修法 — base_branch 默认值非简单 main」尾巴（约束 2）
- **§hand_off_session archive 默认 true**：删「P5 Round 1 reviewer-codex M2 修法 — 文档与 schema 对齐」（约束 2）
- **§hand_off_session opt-out 选项**：删「P6.5 reviewer-codex MED-3 修法 — 旧"baton 强归档不可关"已被 archive_caller 字段废除」（约束 2）

### C. 4 reviewer body sandbox 限制说明 + caller 责任分流（claude-config × 2 + codex-config × 2）

**claude-config × 2**：
- §Sandbox 限制说明节标题删「（P6.5 reviewer-claude HIGH-D 修法 — 实测 SDK 边界）」尾巴
- caller 责任分流删「plan codex-handoff-team-alignment-20260518 P6.7 改名;老名 `/agent-deck:deep-code-review` 仍作 6 个月 deprecation stub」时间窗口预测
- reviewer-codex.md prompt 模板内嵌「上一轮已修的 P1/P2 / 历史 review 结论」placeholder → 改成「HIGH/MED finding」对齐 §输出格式 严重度 invariant

**codex-config × 2**（异构对偶同款污染同步清理）：
- 头部 callout「两份 file `name` 同名(adapter 字段消歧,详 P3 Step 3.5 D7 信号源)」→ 删 P3 引用尾巴
- reviewer-claude.md（codex 视角 wrapper）整 §spike4 衔接 节物理删（含 spike3/spike4 编号 + 49.4s 数字 + spike-reports/ 路径）
- reviewer-claude.md 内嵌 8 处 spike4 / P3 / P5 修法引用全清（核心纪律 / sandbox 节 / claude binary path / claude CLI 调用模板 / 失败兜底 / 反模式表内）
- reviewer-codex.md 头部 callout 同款删 P3 引用 + prompt 模板 P1/P2 placeholder → HIGH/MED 同步

### D. deep-review/SKILL.md

- **frontmatter description**：删「**注**:本 SKILL 由 `deep-code-review` 改名(plan codex-handoff-team-alignment-20260518 P6.7,2026-05-19)。老名仍保留作 deprecation stub(6 个月后版本移除)。」整段时间窗口预测（约束 2）
- **§Sandbox 处理 节标题**：「（auto cp + manifest，P6 新加，P6.5 review 后加固）」→ 删修法标注（约束 2）
- **§Sandbox 处理 step 2/4/6/7 + .gitignore 兜底**：删 5 处 P6.5 reviewer-claude HIGH-B/MED-C/MED-E/HIGH-E 修法引用（约束 2）
- **§kind='mixed' 成本与失败兜底 节标题 + 成本明示段**：删「P6 新加，P6.5 review 后澄清」+「P6.5 reviewer-claude HIGH-C 修法 — 选 (a)」修法引用（约束 2）
- **§何时用 kind='mixed' 例子**：「P5/P6 多 phase plan 完成后 meta-review 收尾」→「多 phase plan 完成后 meta-review 收尾」删 plan phase 编号（约束 2）
- **§与决策对抗节的关系 cross-ref**：删「（plan codex-handoff-team-alignment-20260518 P6.4 §SKILL 改造 + §已知踩坑 13）」尾巴（约束 2）

### E. deep-code-review/ deprecation stub 物理删（git rm 整目录）

- **`resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md` git rm 整目录**：按用户重度清理决策（Q2 物理删 stub）+ 约束 2「废弃功能/字段/方法直接删不留 deprecated 注释」精神。trade-off：破坏老 slash 命令 backward-compat（用户读老 plan / 历史 changelog 调老名 → 直接报 unknown skill），消除时间窗口性预测语
- 老名引用 follow-up cleanup（不阻塞本次 commit）：README.md / docs/agent-deck-{mcp,team}-protocol.md / conventions/tally.md / .gitignore（含 P6.5 修法编号）/ resources/claude-config/README.md 仍引用 `deep-code-review`，REVIEW_46 §INFO follow-up 列出待批量改名

### F. M1 fix（双对抗共识修法）

- **codex-config CODEX_AGENTS.md:28 老 SKILL 名漂移**：双 reviewer 独立提出 [MED] M1 — 应用环境总协议层引用「应用环境跑 `deep-code-review` SKILL 时若 reviewer-claude wrapper teammate 失败...」与改后 SKILL 物理名 `deep-review` 不一致，stub 已物理删后协议层指向不存在 SKILL → 改为 `deep-review`（同 commit fix）

## 验证

- 8 个核心资产 final sweep grep `spike[0-9]+|Spike [0-9]+|可行性铁证|deprecation|deprecated|6 个月后|过渡期|deep-code-review` 全清干净（user CLAUDE.md 唯一命中是约束 2 自检规则反例样本，合规）
- 双对抗 review 三态裁决：✅ M1 必修（已 fix）/ ❌ M3 反驳不修（reviewer template content ≠ regulation）/ ❓ M2 大部分非本次 diff 引入 follow-up
- 改动未破坏关键护栏：Sandbox / Wire format / NO MSG ANCHOR / Fresh session / Worktree 路径自检 / send_message reply chain / 异构对偶纪律全保留 ✅
- `heterogeneous_dual_completed: true`

## Follow-up（不阻塞本次合并）

- 顶级 README.md / docs/agent-deck-{mcp,team}-protocol.md (9 处) / conventions/tally.md / resources/claude-config/README.md：批量 `deep-code-review` → `deep-review` 改名
- .gitignore line 9-15：deprecation 注释 + P6.5 修法编号清理
- codex-config CODEX_AGENTS.md 5 处 P5 修法编号（line 97/108/121/146/158）：同主题 follow-up
- claude-config CLAUDE.md line 66/78/80：3 处「推荐 / 建议 / 应优先」非本次 diff 引入残留（reviewer-claude line 78 反驳 = template 字符串合规；line 66/80 描述性表态 follow-up）
