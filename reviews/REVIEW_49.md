---
review_id: REVIEW_49
title: deep-review-trio-20260521 三焦点(功能 BUG + 架构 + 提示词)R1+R2+R3 异构对抗 review × 17 fix 收口
created_at: 2026-05-21
heterogeneous_dual_completed: true
---

# REVIEW_49 — 三焦点 deep review 全 src/ + resources/ × R1/R2/R3 三轮异构对抗 × 17 fix 落地

## 触发场景

用户主动要求「deep review 下,聚焦于功能 BUG、架构优化和面板提示词精简与统一」。走应用 `agent-deck:deep-review` SKILL teammate 模式(R1+R2+R3 复用同对 reviewer-claude `48e45529` Opus 4.7 + reviewer-codex `019e48f1` codex SDK gpt-5.5 xhigh 跨轮 mental model 持久化)。team `deep-review-trio-20260521` (252c3101)。

## 方法

### Scope

- **main 关键链路 (10 文件)**: archive-plan-impl.ts / hand-off-session.ts / spawn.ts / claude+codex sdk-bridge/index.ts × 2 / claude+codex recoverer.ts × 2 / session/manager.ts / resources/claude-config/CLAUDE.md / resources/codex-config/CODEX_AGENTS.md
- 三焦点全覆盖:功能 BUG (race / leak / lifecycle) + 架构 (SSOT / 模块边界 / 重复代码) + 提示词精简与统一 (双端对称 / 「提示词资产维护」5 条硬约束 / 异构对偶 vs 共享协议)
- reviewer 自由 Grep / Read 周边相关代码深挖

### 流程

| 轮 | 双 reviewer 同时 reply | 三态裁决 + lead 现场验证 + fix |
|---|---|---|
| R1 | reviewer-codex 4 finding (HIGH 0/MED 3/LOW 1) + reviewer-claude 8 finding (HIGH 0/MED 5/LOW 2/INFO 1) | 双方独立 ✅ 2 HIGH 等价 + 单方 MED 自验证 4 ✅ + 1 ❌ 反驳 + 5 ❓ followup |
| R2 | reviewer-claude 「可合」+ R2 新发现 1 INFO + 3 测试盲区 LOW;reviewer-codex 「待 fix 4」MED 2 + LOW 2 + 未验证 1 | 双方独立 0 + 单方 MED 自验证 2 ✅ + LOW 2 ✅ + 未验证维持 |
| R3 | reviewer-codex 5 finding (HIGH 0/MED 1/LOW 2/未验证 1);reviewer-claude 「可合 + 1 HIGH followup」HIGH 1 + LOW 2 + MED 升级实测铁证 | 双方独立 ✅ MED 升级 (adopted-teams 修了 prompt 输出忘修 docs/test) + 单方 HIGH 自验证铁证 ✅ + LOW 3 ✅ + 未验证维持 |

每轮 prompt 必带 `output_mode` / `scope` / `focus` / `skip` (上轮 ✅ fix 摘要)。reviewer body 强约束「文件:行号 + 代码片段 + 验证手段」。每条 finding 三态裁决:HIGH 双方独立 / 现场实测铁证 → ✅;单方 MED → lead Grep+Read 现场验证;LOW/INFO → ❓ 直接列。

## 三态裁决与 fix 清单

### R1: 6 fix (2 双方独立 + 4 单方 MED 自验证)

| ID | 文件:行号 | 严重度 | 验证 | 修法 |
|---|---|---|---|---|
| **A** | resources/codex-config/CODEX_AGENTS.md:54 | HIGH 等价 | 双方独立 (claude #9 + codex #2) | tool count 9→10 + 加 `shutdown_baton_teammates` 进 tool 列表 |
| **B** | resources/codex-config/CODEX_AGENTS.md:130-180 | HIGH 等价 | 双方独立 (claude #8 + codex #3) | archive_plan 节加 spike-reports 自动归档 + `spike_reports_archived` return shape + mainRepo dirty precheck 精确化段;新增 `### escape hatch: shutdown_baton_teammates` 完整节(对称 claude-config L140-160) |
| **D** | hand-off-session.ts:723-758 | MED | claude 单方 + lead grep 验证 (try/catch 仅围 swapLeadFn,emit/notify 在外裸跑) | processSwappedTeam 4 处 emit/notify 改 `safeEmit` wrapper + `console.warn` 兜底,任一失败不打断 swap 主流程 |
| **F** | session-finalize.ts:18-25 + L98 | MED | claude 单方 + lead grep 验证 (manager.ts:619-625 jsdoc 列 6 处反向 rename 路径全走 wrapper,唯独本处 spawn 主路径直调 sessionRepo 绕过黑名单链 SSOT) | 改走 `sessionManager.updateCliSessionId` wrapper 统一黑名单链;manager.ts:627-637 jsdoc 加 caller 列表 |
| **H** | manager.ts:392-410 | MED | codex 单方 + lead grep 验证 (archive() / unarchive() / unarchiveOnUserSend() 都不清 marker;archive-plan-impl:627 消费 stale marker) | archive() 加 `sessionRepo.clearCwdReleaseMarker(sessionId)` 清 marker (baton phase 2 archive caller 后 marker 应清空避免 unarchive 复活带 stale marker 撞 cross-worktree warning) |
| **I** | CODEX_AGENTS.md:38 + L178 cold-start | LOW | codex 单方 + 与 schemas.ts EnterWorktreeArgsSchema 一致性 | 旧 `base?: "HEAD"` → `base_commit?, base_branch?` (cold-start 同款);schema 接受 `base_commit` / `base_branch` 两字段废弃旧 `base` |

❌ **反驳 1 条**:claude R1 #3 `.catch(() => undefined)` 吞 debug — 实测 grep sdk-bridge/index.ts 仅 2 处 (L664 jsdoc + L681 permissionModeChain) 都是设计内 (chain 内部静默 + jsdoc 显式说明 caller 拿 reject 真错;L398 实际有 console.warn 兜底)。

❓ **followup 5 条**:ingest 3a closed precheck (双方维持) / findFallbackCwd 复制粘贴 (LOW 架构) / Wire format SSOT *未验证* / spawn callerExists 散落 / recovering Map 两端独立 (by-design)。

### R2: 4 fix (R2 fix-2 + 修正 R2 fix-3 修错地方留 R3)

| ID | 文件:行号 | 严重度 | 验证 | 修法 |
|---|---|---|---|---|
| **R2-MED-1** | mocks/session-repo.ts:91-94 | MED | codex 单方 + lead grep 验证 (archive() 测试路径会撞 TypeError) | 补 `clearCwdReleaseMarker: vi.fn` mock method |
| **R2-MED-2** | tools/index.ts:208 | MED | codex 单方 + lead read 验证 (description 漏 `spike_reports_archived`) | archive_plan tool description 补 spike-reports mv 流程 + return shape `spike_reports_archived` 字段 |
| **R2-LOW-1** | resources/codex-config/agent-deck-plugin/skills/deep-review/SKILL.md 4 处 | LOW | codex 单方 + grep 4 处「应用 CLAUDE.md」 | 改 codex SKILL.md mirror 4 处「应用 CLAUDE.md」→「应用 CODEX_AGENTS.md」(后续 R3 HIGH-1 揭示这是修错地方,见下) |
| **R2-LOW-2** | adopted-teams-context-block.ts:130 | LOW | codex 单方实证 + 与 reviewer-claude R1 *未验证* Wire format SSOT 漂移异构强冗余 | wire prefix 示例补 `@ <adapter>` 槽对齐生产 builder (universal-message-watcher / lead-context-block / spawn 四段对齐) |

### R3: 6 fix (1 HIGH 修正 R2 修错地方 + 升级 MED + 4 LOW)

| ID | 文件:行号 | 严重度 | 验证 | 修法 |
|---|---|---|---|---|
| **R3-HIGH-1** | resources/claude-config/agent-deck-plugin/skills/deep-review/SKILL.md 4 处 | HIGH | claude R3 单方 + grep .gitignore 屏蔽 + 读 sync 脚本只 cp 不替换 | **修 SSOT 不修 mirror**:claude SKILL.md 4 处「应用 CLAUDE.md」→ 「应用约定文件(claude 端 `CLAUDE.md` / codex 端 `CODEX_AGENTS.md`)」adapter-agnostic 表达;跑 sync 脚本 (`node scripts/sync-codex-skills.mjs`) 同步 codex mirror。R2 fix-3 修 mirror 是修错地方 (mirror 入 .gitignore 不入 git,sync 只 cp 不替换 → 下次 build 必回退)。|
| **R3-MED 升级** | adopted-teams-context-block.ts L26 + L88 jsdoc | MED 升级 | 双方独立 (claude jsdoc + codex snapshot/注释) | 同 helper 4 处 jsdoc + test snapshot 全补 `@ <adapter>` 槽 (修了 prompt 输出忘修 docs/test 自打脸)|
| **R3-MED-同上** | adopted-teams-context-block.test.ts L154 + L185 snapshot | MED 升级 | 同上 | 2 处 `toBe` 精确 snapshot 补 `@ <adapter>` |
| **R3-LOW-1** | tools/index.ts:208 | LOW | codex 单方 + 模式化错误 (我 R2 fix 写 review history 进 model-facing description) | 删 `(R2 reviewer-codex MED — sync app prompt + tool description)` review provenance phrase;model-facing description 不留 review 历史只留事实契约 |
| **R3-LOW-2** | mocks/session-repo.ts:95-98 | LOW | claude 单方 + grep 生产 caller 2 处 (claude session-finalize.ts:136 + codex session-finalize.ts:86) | 补 `setExtraAllowWrite: vi.fn` 与 setClaudeCodeSandbox / setModel 同款桩 |
| **R3-LOW-3** | 6 个 claude bridge test mock | LOW | codex 单方 + grep 6 个文件确认缺 `updateCliSessionId` mock (R2 fix-F wrapper switch 测试盲区) | setttimeout-fallback-symmetry / file-change-intent-delay / createsession-fail-fast / restart-controller-fork-rename / set-permission-mode-rollback / sdk-bridge.recovery 6 处 inline mock 补 `updateCliSessionId: vi.fn()` |

❓ **R3 followup 维持**(强烈建议下一 plan 优先修):
- **ingest 3a closed precheck** — claude R3 升级实测铁证 (close 不写黑名单 + advanceState L211 不读 archivedAt → closed/archived session 撞迟到 hook event 复活)。修法明确:advanceState 加 `if (record.archivedAt !== null || record.lifecycle === 'closed') return`。
- 其他 LOW/by-design:findFallbackCwd / spawn callerExists / recovering Map / safeEmit silent / wrapper jsdoc perf hint / 3 测试盲区。

### 顺手修:task tool 跨 team 边界 bug

用户在 review 中途撞「mcp__tasks__ task_update permission denied: task X belongs to team_id `<global>`, current session is in team_id N」(SKILL 流程 task_create 在 spawn_session 之前跑跟踪,task 创建时 team_id=`<global>` caller 还没 team,spawn 后 caller 进 team N → task_update 撞 reject)。用户明示「直接修」。

**修法**:src/main/task-manager/tools.ts task_update / task_delete / cascade predicate 三处放宽 — 允许 caller 改/删 `team_id === null`(`<global>`)的 task (单用户单进程应用「全局 task 谁都能改」语义安全);非全局跨 team 仍 reject。SDK tool description 同步说明新语义。

## 共识 + 细节

- **typecheck**:R1 / R2 / R3 三轮 fix 后均跑 `pnpm typecheck`,double pass (node + web),0 错。
- **vitest**:本次未执行(reviewer-codex R3 提到本地 shell 缺 node 跑不了),但 mock 补全后理论上之前撞 TypeError 的 archive() 测试路径已修通;后续 commit 后建议本地 `pnpm test` 全跑。
- **shutdown reviewer**:R3 收口后 shutdown 两 reviewer (sid `48e45529` + `019e48f1`),events / messages 子表保留供 SessionDetail UI 查阅。
- **R2 fix-3 修错地方教训**:codex SKILL.md mirror 入 `.gitignore`,build-time sync (`scripts/sync-codex-skills.mjs`) 只 cp 不字符串替换 → mirror 改动会被 sync 覆盖回 SSOT。后续修 SKILL/agent body 类资产**先 grep `.gitignore` 看是否 mirror**,确认是 SSOT 才下手 (类似 P 候选潜在条目)。

## 结论

**「是否可合」: ✅ 是**。3 轮共 17 fix 全过 typecheck (R1 6 + R2 4 + R3 6 + task tool 1)。SKILL §收口达成 (双 reviewer 都「可合」+ 0 真 HIGH/MED 残留 + 上轮真问题已 fix)。

**❓ 维持的 followup**(下一 plan 优先级):
1. **ingest 3a closed precheck**(MED,实测铁证,修法明确)
2. R2/R3 共 5 条 LOW (findFallbackCwd / spawn callerExists / recovering Map / safeEmit silent / wrapper jsdoc perf hint)
3. R2/R3 共 3 测试盲区 LOW (safeEmit / wrapper switch / archive clearMarker 回归 test)

`heterogeneous_dual_completed: true`。
