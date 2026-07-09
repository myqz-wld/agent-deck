# CHANGELOG 152 — SessionList hand_off teammate role badge + 视觉缩进显示修复

`session-list-handoff-role-badge-20260526` plan 收口。

## 修复

`hand_off_session({adopt_teammates:true})` 过继 teammate 后，SessionList 实时面板显示三大症状：
1. 新 session (newSid) 不显示 👑 lead badge
2. 原 teammate 不显示 ↳ teammate badge
3. teammate 视觉缩进关系完全丢失（与 newSid 同 root 平铺）

**根因**：`SessionList.tsx:42-55` 旧 `teamRole` 推断完全基于 `spawnedBy` 树形分组，但 `handoff-no-spawn-guards-20260526` plan（CHANGELOG_151）已硬定「hand-off 永不写 spawn-link」（`sessions.spawned_by/spawn_depth` 保持 null/0）→ hand-off 路径完全失去 badge + 缩进数据源。PendingTab / TeamDetail 用 `session.teams[*].role`（universal team backend DB SSOT）已正确，SessionList 是最后一个漏洞。

**修法**：双源 fallback —— universal team backend (DB 权威) 优先 + spawn-link 退化（仅纯 spawn 链场景）。

## 主要改动

**新建文件 (2)**：
- `src/renderer/lib/derive-team-role.ts` (38 行): shared util，SessionList + PendingTab 共用。优先级 1 universal team「任一 lead 优先」(D5)，优先级 2 spawn-link 退化（仅 `pureSpawnChain=true` 时；HIGH-2 修法阻断 `archive_caller:false` adopt 后 caller 已 left team 但 spawnedBy 仍指向 stale caller 时错标 lead）。
- `src/renderer/components/session-list-tree.ts` (108 行): `computeChildrenByOwner` 双 phase 算法 (Phase 1 spawn-link primary 有条件收编 + Phase 2 universal team 收编 fallback) + `isPureSpawnChain` helper。抽离让 vitest node env 单测绕开 React JSX。

**修改文件 (3)**：
- `src/renderer/components/SessionList.tsx`: 接 shared util + import 双 phase 树形分组。原 inline childrenByOwner 算法 + teamRole 推断改委托。mid-tier dual-role 注释更新。
- `src/renderer/components/SessionCard.tsx`: jsdoc 同步新优先级逻辑；hover title 复用已有 `teamHoverTitle` 复用 PendingTab 风格 multi-team 详列。
- `src/renderer/components/PendingTab.tsx`: `teamRole` 改走 `deriveTeamRole(session, false, 0, true)` 与 SessionList 对齐「任一 lead 优先」（HIGH-1 修法消除 PendingTab/SessionList 同 session 显示不同 badge 的不一致）。

**测试文件 (2 新建，21 tests)**：
- `src/renderer/lib/__tests__/derive-team-role.test.ts` (11 corner): 覆盖 teams 字段缺失/空数组/单 team/全 lead/全 teammate/mixed nested spawn 可达/纯 spawn 链 owner 视角/HIGH-2 反例 owner 视角/hasOwner=true 子节点 fallback/HIGH-2 反例 hasOwner 视角 mirror。
- `src/renderer/components/__tests__/session-list-tree.test.ts` (10 corner): 5 isPureSpawnChain (self/child/owner teams 不空 / 跨 section silent return true / 全空) + 5 Phase 1 conditional (基础锁 / HIGH-A 反例 archive_caller:false 不锁 + Phase 2 reparent / 纯 spawn 锁 / mixed role nested spawn `ownerLeadsSomeTeamOfS` 嵌套 some 命中 / teamId 不匹配 confusion case 不锁防 some 早 return 漏判)。

## Plan deep-review × 3 轮闭环

通过 `/agent-deck:deep-review` SKILL 跑 reviewer-claude (Opus 4.7) + reviewer-codex (gpt-5.5) 异构对抗，共 34 finding 全部接受（1 ❌ 否决: claude INFO-1 unknown role jsdoc，codex 否决「不扩 plan scope」）。

- **R1** (v1→v2, 13 finding, 升 2 HIGH): D1 抽 shared util / D4 反转加 universal team 收编 fallback / D7 grep 证据 / 11 unit test corner / Step 4.3 实测序列重写 / 测试矩阵 dormant + closed + multi-team mixed corner 补
- **R2** (v2→v3, 13 finding, 升 2 HIGH): HIGH-A D2 Phase 1 加 universal team 条件检查阻断 archive_caller:false 反例 (codex 推演实证) / HIGH-B isPureSpawnChain 自身独立单测 (双方独立强冗余) / D7 mixed role nested spawn 当前可达 / Step 5.4 重组 4 独立 caller
- **R3** (v3→v4, 8 finding, 升 2 HIGH 级): HIGH-α 移除 hand_off 不存在的 `display_name` 字段 (codex grep 实证 strict safeParse 拦实测) / HIGH-β 场景 4 期望视觉重写 D→B(lead)→C2 + 重命名避同名 (双方独立)

**验证**：21 单测 pass / typecheck (tsconfig.node + tsconfig.web) GREEN。dev UI 实测推迟到 .app 新版本发布后视觉验证（plan §不变量 6 dev 实测要求由用户决定跳过）。

详 [`plans/session-list-handoff-role-badge-20260526.md`](../../plans/history/session-list-handoff-role-badge-20260526.md)。
