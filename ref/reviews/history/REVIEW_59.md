# REVIEW_59 — Deep-Review 批 A: agent-deck-mcp tools 核心 handler

> 触发：用户请求 deep code review，聚焦于「架构/代码优化（大文件拆分）/ 功能 BUG / 提示词资产优化 / 核心架构图和流程图补全」。本 review 为 **批 A**（mcp tools 核心 handler），后续批 B（sdk-bridge 双端）/ 批 C（剩余 8 文件）/ 提示词资产 / plantUML 图独立批次。
>
> 工具链：agent-deck:deep-review SKILL（多轮异构对抗 reviewer-claude + reviewer-codex 跨 adapter spawn）+ 反驳轮 + 三态裁决。
>
> 关联 fix：[CHANGELOG_169.md](../../changelogs/history/CHANGELOG_169.md)。

## Scope

| 文件 | LOC | 角色 |
|---|---|---|
| `src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts` | 1488 | plan 收口 14 phase 实施（ff-merge / mv plan / spike-reports 归档 / INDEX update / commit / worktree remove + baton-cleanup phase 1+2） |
| `src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts` | 1249 | baton 接力实施（plan-driven / generic 双模式 + cwd resilience + adopt_teammates / archive_caller / team_task_policy 三态 + task 自动过继） |
| `src/main/agent-deck-mcp/tools/schemas.ts` | 1215 | 15 个 mcp tool 的 zod input schema + tool description（应用 build 时把 description 注入 SDK system prompt） |

合计 3952 LOC + 关联调用方（baton-cleanup.ts / spawn.ts / shutdown-teammates-on-baton.ts）。

## 流程

### Round 1 — 全量 review（kind='code'）

并发 spawn 跨 adapter 异构对：
- reviewer-claude（claude-code adapter，Opus 4.7 default thinking）
- reviewer-codex（codex-cli adapter，gpt-5.5 xhigh）

prompt 含 3 个 focus 维度：① 大文件拆分（按 file-size-guardrail.md 三档）② 功能 BUG（race / TOCTOU / 边界 / 错误处理 / 状态一致性 / 资源清理）③ 架构与设计一致性（API 契约 / schema-handler 漂移 / 死代码 / 无意义降级 / 测试盲区）。

**reviewer-codex 输出**（5 条）：1 HIGH + 3 MED + 1 INFO。
**reviewer-claude 输出**（8 条）：2 HIGH + 4 MED + 2 LOW + 1 INFO。

合计 13 条独立 finding。

### Round 2 — 反驳轮（HIGH 单方独有）

主 agent 三态裁决发现 2 条 HIGH 单方独有，分别 send_message 让对方反驳：

- **C-HIGH-1（reviewer-codex 提出，reviewer-claude 没提）**：archive_plan 不校验 fm.worktree_path / fm.plan_id → silent corruption。**reviewer-claude 反驳轮判定 ✅ 成立 HIGH**：grep `fm.worktree_path` / `fm.plan_id` 0 命中 + branch 命名约束缺失 + 现场推演 silent corruption 后果（plan-A 错标 completed + plan-B 工作整片丢失 + ff-merge commit 错合）+ 主路径 claude builtin EnterWorktree 不写 marker 兜底也漏。承认 R1 遗漏。
- **L-HIGH-2（reviewer-claude 提出，reviewer-codex 没提）**：INDEX read-modify-write 无文件锁，并发 archive 写丢失。**reviewer-codex 反驳轮判定 部分成立 → 降 MED**：grep 无锁是真，但 git index lock / dirty precheck / ff-only fail 让多数并发组合提前失败，不是稳定复现；两条线性 ff worktree 同时到 RMW 阶段才触发；修法仍 `Map<indexPath, Promise>` 单飞锁。

### Round 3 — 主 agent 现场验证（MED 单方独有）

5 条 MED 单方独有由主 agent 自己 Read + Grep 验证（≤ 5min / ≤ 5 grep / ≤ 1 test 内成立）：

- C-MED-1（hand-off-session:388 worktree-missing 允许任意 cwd）✅ 真 MED：line 395 条件未约束 finalCwd === mainRepo
- C-MED-2（hand-off-session:1166 archive_caller=false 仍 shutdown teammates）✅ 真 MED：baton-cleanup:219 phase 1 仅看 adoptTeammates，与 archiveCaller 独立；schema 文案承诺与代码相反
- C-MED-3（hand-off-session:1130 preserve-team 信任 spawnData.teamId）✅ 真 MED：spawn.ts:428 addMember catch 不置 null teamId
- L-MED-1（archive-plan-impl:1044 spike-reports rmdir 静默 swallow）✅ 真 MED：sibling artifacts 残留 caller 不知情
- L-MED-2（archive-plan-impl:1033 srcSpikeDir==dstSpikeDir）✅ 真 MED：step 12 (line 1008) 有 path.resolve guard，step 12.5 漏；plan 已在 ref/plans/ 时 mv same + 误返 spikeReportsArchived non-null
- L-MED-3（4 处 DEFAULT_DEPS 重复）✅ 真 MED：tier-1 抽 _shared/default-impl-deps.ts
- L-MED-4（archive-plan-impl:1187 marker release partial cleanup）✅ 真 MED：step 14a/14b 失败时 marker 不 release，caller 无法重试

## 三态裁决总表

| # | 文件:行 | 严重度 | 裁决 | 验证依据 |
|---|---|---|---|---|
| F1 | 三大文件 1488/1249/1215 LOC | HIGH | ✅ 双方独立提出 | wc 实证违反 SOP §500 行护栏 |
| F2 | archive-plan-impl:471 plan_id↔worktree_path 不绑 | HIGH | ✅ 反驳后成立（C 提，L 反驳确认） | grep 0 命中 fm.worktree_path + silent corruption 推演 |
| F3 | hand-off:388 worktree-missing 允许任意 cwd | MED | ✅ lead 验证 | line 395 条件未约束 finalCwd===mainRepo，注释 vs 代码 drift |
| F4 | hand-off:1166 archive_caller=false 仍 shutdown teammates | MED | ✅ lead 验证 | baton-cleanup:219 phase 1 仅看 adoptTeammates |
| F5 | hand-off:1130 preserve-team 信任 spawnData.teamId | MED | ✅ lead 验证 | spawn.ts:428 addMember catch 不置 null |
| F6 | archive-plan-impl:986 INDEX TOCTOU | MED | ✅ 反驳后降级（L 提 HIGH，C 反驳降 MED） | reviewer-codex 反驳：git 上游兜底约束触发概率，仍是真问题 |
| F7 | archive-plan-impl:1044 spike-reports rmdir 静默 | MED | ✅ lead 验证 | sibling artifacts 残留 caller 不知情 |
| F8 | archive-plan-impl:1033 srcSpikeDir==dstSpikeDir | MED | ✅ lead 验证 | step 12 有 path.resolve guard，12.5 漏 |
| F9 | 4 处 DEFAULT_DEPS 重复 | MED | ✅ lead 验证 | tier-1 抽 _shared/default-impl-deps.ts |
| F10 | archive-plan-impl:1187 marker release partial cleanup | MED | ✅ lead 验证 | step 14a/14b 失败时 marker 不 release |
| F11 | hand-off:451 N2.c 注释 drift | LOW | ❓ | 文档注释问题，不影响行为 |
| F12 | schemas.ts directorize tradeoff | LOW | ❓ | 设计取舍走「真不能拆」保护清单 |
| F13 | hand-off:1036 emit task-changed 在 tx 外 | INFO | ❓ | 显式设计选择，非缺陷 |

**结论**：2 HIGH + 8 MED = 10 条必修 → 全部 fix（详 CHANGELOG_169.md）；3 LOW/INFO 不修。

## reviewer-claude / reviewer-codex 独立 finding 对比

| Finding | reviewer-codex | reviewer-claude |
|---|:---:|:---:|
| 三大文件触发 500 行护栏 | INFO（具体抽法清单） | HIGH（实测 LOC + 抽法可行） |
| archive_plan plan_id 不绑 worktree_path | HIGH ✅ | 漏（反驳轮承认） |
| INDEX TOCTOU 写丢失 | 漏（反驳轮认为 git 上游兜底） | HIGH（反驳后降 MED） |
| hand-off worktree-missing 允许任意 cwd | MED | 漏 |
| archive_caller=false 仍 shutdown teammates | MED | 漏 |
| preserve-team 信任 spawnData.teamId | MED | 漏 |
| spike-reports rmdir 静默 | 漏 | MED |
| srcSpikeDir==dstSpikeDir 边界 | 漏 | MED |
| DEFAULT_DEPS 三重重复 | 漏 | MED |
| marker release partial cleanup | 漏 | MED |
| N2.c 注释 drift | 漏 | LOW |
| schemas.ts directorize tradeoff | 漏 | LOW |
| emit 在 tx 外 | 漏 | INFO |

异构互补显著：reviewer-codex 抓「契约语义漂移」（plan_id 绑定、archive_caller 文案 vs 代码、preserve-team 信任）；reviewer-claude 抓「fs 边界 / 资源清理 / 模式重复」（spike-reports / DEFAULT_DEPS / marker release / INDEX TOCTOU）。零交叉 finding 的部分（reviewer-codex 5 条 vs reviewer-claude 8 条）反映双 reviewer 视角差异，符合异构对抗设计意图。

## SKILL 学习点

- **反驳轮升级 HIGH 的关键**：反驳方实际跑 grep + 现场推演 silent corruption 后果，不是单纯文本评审。reviewer-claude 反驳 C-HIGH-1 时主动 grep `fm.worktree_path` / `fm.plan_id` 0 命中 + 写 silent corruption 推演链（plan-A 错标 + plan-B 工作丢 + ff-merge 错合），把 reviewer-codex 的初判从中位 HIGH 升级到强 HIGH。
- **反驳轮降级 MED 的关键**：reviewer-codex 反驳 L-HIGH-2 时不否认无锁是真，但补全威胁模型（git index lock / ff-only fail / dirty precheck 让多数并发提前失败）让 HIGH 降为「真问题但触发难」MED。三态裁决「部分成立」分类合理。
- **多轮迭代 reviewer 不 shutdown**：本批 fix loop 期间双 reviewer 始终保持 active 复用 mental model，反驳轮 reviewer-codex 引用「自己 Round 1 没提的理由」做反驳判定（continuity dependency），符合 SKILL §Step 5「迭代期间绝不 shutdown」invariant（CHANGELOG_166 修订）。
- **lead 自己验证 MED 节省 reviewer 反驳轮**：5 条 MED 都由主 agent 自己 Read + Grep 验证（≤ 5min / 单 finding），避免 reviewer 反驳轮被淹没在低 severity finding 中。

## 验证

- 拆分前后 archive_plan / hand_off_session 行为零回归（504 mcp tests passed / 全套 968 tests pass / 0 failed / 0 errors）
- typecheck + build 全过
- 8 处契约变更对应的 test 期望同步更新（worktree branch 名 / spike-reports rmdir 边界 / archive_caller=false phase 1 / preserve-team isActiveMember 等）
