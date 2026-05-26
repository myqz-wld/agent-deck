---
review_id: 23
reviewed_at: 2026-05-11
expired: false
skipped_expired:
---

# REVIEW_23: R3 PR-A E0 ADR reviewer 双对抗（已在 ADR §13 闭环）+ PR-B 验证

## 触发场景

R3 Universal Team Backend 硬切的设计阶段（PR-A E0 ADR）+ 实施阶段（PR-B ~3000 LOC churn）。

PR-A 阶段：reviewer 双对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5 xhigh）+ 反驳轮在 ADR 内闭环；本 REVIEW 文件只**引用** ADR 已闭环的 finding 列表，不重复列。

PR-B 阶段：未单独跑全量代码 review —— 因为 ADR §6 删除清单 + §8 PR 拆分约束已经把「破坏性范围」提前限定死，typecheck + vitest 233 passed 是机械验证而非 review。

## 方法

**双对抗配对**（PR-A E0 ADR 阶段）：
- Agent A：reviewer-claude（Opus 4.7 xhigh）teammate
- Agent B：reviewer-codex（claude-code wrapper，内部 Bash 跑外部 codex CLI gpt-5.5 xhigh）teammate

3 轮 review + 反驳轮 + 三态裁决，详见 [docs/agent-deck-team-protocol.md](../docs/agent-deck-team-protocol.md) §13。

**范围**（ADR + PR-A 5 commit）：

```text
docs/agent-deck-team-protocol.md (1151 LOC ADR)
src/shared/types/agent-deck-team.ts (新增)
src/main/store/migrations/v010_agent_deck_teams.sql (新增)
src/main/store/migrations/v011_tasks_team_id.sql (新增)
src/main/store/agent-deck-team-repo.ts (新增 561 LOC)
src/main/store/agent-deck-message-repo.ts (新增 422 LOC)
src/main/store/__tests__/agent-deck-team-repo.test.ts (新增 29 tests)
src/main/store/__tests__/agent-deck-message-repo.test.ts (新增)
src/main/adapters/types.ts (扩 canCollaborate / receiveTeammateMessage / notifyTeammateEvent)
src/main/adapters/{claude-code,codex-cli,aider,generic-pty}/index.ts (capability + receiveTeammateMessage 实现)
src/main/teams/team-fs.ts (新增 exportLegacyTeams / hasLegacyTeamData)
src/main/ipc/legacy-teams.ts (新增 IPC handler)
src/renderer/components/settings/sections/LegacyTeamExportSection.tsx (新增 UI)
src/shared/types/settings.ts (加 r3LegacyExportNoticeAcked)
```

**机器可读范围**：

```review-scope
docs/agent-deck-team-protocol.md
src/main/adapters/aider/index.ts
src/main/adapters/claude-code/index.ts
src/main/adapters/codex-cli/index.ts
src/main/adapters/generic-pty/index.ts
src/main/adapters/types.ts
src/main/ipc/legacy-teams.ts
src/main/store/agent-deck-message-repo.ts
src/main/store/agent-deck-team-repo.ts
src/main/store/migrations/v010_agent_deck_teams.sql
src/main/store/migrations/v011_tasks_team_id.sql
src/main/teams/team-fs.ts
src/renderer/components/settings/sections/LegacyTeamExportSection.tsx
src/shared/types/agent-deck-team.ts
src/shared/types/settings.ts
```

> ADR 文件本身首次加入 git 的 commit (04d2d71) 视为该批文件的覆盖基线。

**约束**：仅 ADR + PR-A 新增/修订文件；老 backend 删除（PR-B 阶段）已在 ADR §6 锁定，不重复 review。

## 三态裁决结果（ADR §13 镜像，详见原文）

### ✅ HIGH（双方独立提出 / 反驳证实，ADR 已修订）

| # | 严重度 | ADR 章节 | 问题 | 修订 |
|---|---|---|---|---|
| HIGH-1 | HIGH | §2.2 / §4.1 / §4.5 | watcher backoff schema 缺 `last_attempt_at` | 加 last_attempt_at 字段 + retry SQL 重写 |
| HIGH-2 | HIGH | §2.2 / §2.5 | CASCADE on team_members.session_id 与 hard-delete 冲突 | 改 RESTRICT + sessionManager.delete 加 pre-check |
| HIGH-3 | HIGH | §6.1 / §6.2 / §6.6 | 删除清单不完整 | 详细行号补全（1671 LOC + tests + 50 处 renderer） |
| HIGH-4 (codex) | HIGH | §5.2 | `send_message` 缺 team selector | 加 optional team_id + multi-team handler 校验 |
| HIGH-5 (codex) | HIGH | §5.4 | Task Manager 仍依赖 sessions.team_name | task-manager 迁移到 teamIdProvider + v011 |

### ❓ → MED（反驳轮证伪 HIGH 严重度，仍需修订）

| # | 严重度 | ADR 章节 | 问题 | 修订 |
|---|---|---|---|---|
| MED-降级 1 | HIGH→MED | §2.2 | spawn_session ensure-team-by-name 设计层面需 partial unique 索引 | partial unique 索引落地 |
| MED-降级 2 | HIGH→MED | §3.2 / §8 | canJoinTeam 删除时机 | 删除推到 PR-B / E6 |
| MED-降级 3 | HIGH→MED | §4.8 | wait_reply 不监听 lifecycle closed | coordinator 加 session-upserted 监听（PR-B E5 同 PR 落地） |

### ✅ MED 其他（双方覆盖不同角度，ADR 已修订）

7 项 MED 修订（详见 ADR §13.4）：wire format 前缀字符串不一致 / notifyTeammateEvent dispatcher 缺失 / per-team 60/min 限流实施位置 / task:list-by-team 重名歧义 / renderer 删除清单遗漏 50 处 / inbox-protocol.test.ts 漏列 / crash recovery `attempt_count++` 体验差 / wait_reply since_ts race / spawn_session 必带 prompt / R2 ADR §12 路线图作废 / schema 不变量。

### ❌ 反驳证伪条目

4 项被反驳（详见 ADR §13.5）：migration v010 编号错误 / REMOVED_KEYS 机制不可用 / sessions.upsert 写 team_name=null 方案不可行 / session 多 team 设计应砍。

### INFO（设计澄清）

4 项已落地（详见 ADR §13.6）：caller 自动 lead role / PR-A 后启动一次性 dialog / metadata type-guard / sdk-bridge env 注入行号定位。

## 修复（CHANGELOG_65 落地）

### HIGH

PR-A 5 commit 已落地（reviewer 修订全部进 ADR）：

1. **04d2d71** docs(adr): R3.E0 ADR ACCEPTED（含全部反驳轮收敛后 finding 修订）
2. **2b1da70** feat(r3): E1 + E2 types + migration v010/v011（落地 §2 schema + §5.4 task-manager 迁移）
3. **0676788** feat(r3): E3 repo + 29 tests（落地 §3 invariant + §4.5 retry/退避 + §4.6 crash recovery）
4. **2fd53dc** feat(r3): E4 AgentAdapter 接口扩展（落地 §3.1 / §3.2 + canJoinTeam 推到 PR-B 删）
5. **a23cd7d** feat(r3): E12 Legacy team data export + 启动 dialog（落地 §11.4 兜底）

PR-B 同 PR 落地（详见 CHANGELOG_65）：E5 universal-message-watcher / E6 老 backend 删 / E7 UI 重写 / E8 IPC 重写 + task-manager 迁移 / E9 event-bus / E10 CLI / E11 SKILL + reviewer agent body 重写。

## 关联 changelog

- [CHANGELOG_65.md](../changelogs/CHANGELOG_65.md)：R3 PR-A + PR-B 整体落地

## Agent 踩坑沉淀（如有）

无新增。本 review 全部 finding 已在 ADR §13 闭环，未提炼出新的 agent-pitfall 候选。
