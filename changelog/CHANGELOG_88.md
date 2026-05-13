# CHANGELOG_88: main 端 backlog cleanup C/E/G/H 4 项

**plan**: mcp-bug-and-feature-batch-20260513 Phase 2（H1 Step 2.1-2.5）

## 概要

低风险 main 端 backlog cleanup 4 项各 1 atomic commit：

- **C MED-D7**：`TeamEventDispatcher.start()` 预填 `lastArchivedAt` cache 防首次 archive transition 被吞
- **E LOW**：`team-lifecycle-scheduler.scan()` 加 while-loop pagination 防 long-running 实例 team > 200 时漏扫
- **G MED-A7**：`makeAgentDeckTeamRepoMock` 补全所有 18 个 method（用 `AgentDeckTeamRepo` 强类型 import 兜底，未来 repo 加 method 编译期强制提示）
- **H HIGH-B2**：新建 `manager-team-coordinator.test.ts` 5 it 覆盖 `leaveTeamsAndAutoArchive` 的 closed/deleted reason 分支 + 0-lead/多 membership/orphan 边界（H4 dup 消除当时只靠代码 diff 验证）

4 commit + 全 34 session tests + 5 watcher tests + 5 coordinator tests 全过。typecheck 双端通过。

> Plan §H5 §Step 5.6 backlog 5 项中：D（lazy import 不是空操作）+ F（markDormant/markClosed 不存在 已被 setLifecycle 取代）已经在 Phase 1 调研时确认从 backlog 移除（不是真 bug）。本 phase 只处理 C/E/G/H 4 真 backlog。

## 变更内容

### C MED-D7：TeamEventDispatcher 首次 archive transition 不再被吞

**根因**：`universal-message-watcher.ts:215 lastArchivedAt = new Map<string, number | null>()` 初始空 → line 234 `if (prev === undefined) return` 把首次见到的 team 任何 transition（含 active→archived）都吞掉。常见触发：lead session archive 联动 → countActiveLeads=0 → team archive → emit team-updated → dispatcher 第一次见到该 team → prev=undefined → 吞 → active member 收不到 team-archived event。

**修法**：`dispatcher.start()` 时分页 listAll team（含 archived）预填 `archivedAt` 真值。pagination 与 E 同款（`PAGE_SIZE = 200` while-loop offset += 200 直到 batch < PAGE_SIZE），防 long-running 实例 team > 200 时漏扫。修后首次 emit team-updated 时 prev 已是真值，能正确 detect transition。

**单测**（universal-message-watcher.test.ts 加 2 it）：
- start() 调 `agentDeckTeamRepo.list({ activeOnly: false, limit: 200, offset: 0 })`，pagination loop batch < PAGE_SIZE 后 break
- start() 后 `lastArchivedAt` cache 已 preseed 真值（reflection 访问 private field 验证）

**文件**：
- `src/main/teams/universal-message-watcher.ts` — `start()` 加预填 try/catch 块（30 行）
- `src/main/teams/__tests__/universal-message-watcher.test.ts` — 加 `describe('TeamEventDispatcher - C MED-D7 fix')` + 2 it + mock list/listActiveMembers + import teamEventDispatcher

### E LOW：scheduler 无分页 → while-loop pagination

**根因**：`team-lifecycle-scheduler.ts:81 list({ activeOnly: true, limit: 200 })` 没 offset，长期使用后超出 200 的 team 永远不被扫到 → 永远不 archive 即使是 ghost team。

**修法**：改 while-loop pagination，`offset += 200` 直到 batch < PAGE_SIZE break。`agentDeckTeamRepo.list` 的 signature 已支持 offset（team-crud.ts:138-141），直接用即可。

**dev smoke 覆盖**（无 dedicated 单测）：scheduler.scan 跑时自然会触发新 loop，dev 验证 ghost team 数 > 200 场景。

**文件**：
- `src/main/teams/team-lifecycle-scheduler.ts` — `scan()` 改 while-loop pagination

### G MED-A7：mock 缺 14 method → 补全 18 method 接口面对齐

**根因**：`manager-test-setup.ts:210-223 makeAgentDeckTeamRepoMock` 只暴露 5 method（CHANGELOG_31 Bug 5 历史欠债）。靠 short-circuit 不暴露 — 一旦未来 lead session 关联真实 membership 触发未 mock 的 method（如 `.get` / `.unarchive` 在 H1 archive/unarchive 联动路径），test 直接挂在「is not a function」。

**修法**：用 `import type { AgentDeckTeamRepo }` 强类型作 mock 返回类型，补全所有 18 method（return null / [] / 0 / Map / dummy 对象）。未来真 repo 加 method 编译期强制提示需要更新 mock，避免 mock 漂移。

**回归保护**：跑全 34 session tests（5 file）全过 — mock 补全没破坏现有 manager-helpers / manager-delete / manager-public-api / manager-ingest 4 个 test 文件路径。

**文件**：
- `src/main/session/__tests__/manager-test-setup.ts` — `makeAgentDeckTeamRepoMock` 返回类型从 inline interface 改 `AgentDeckTeamRepo` strict + 补 13 method stub + 顶部加 `import type { AgentDeckTeamRepo }`

### H HIGH-B2：leaveTeamsAndAutoArchive characterization test

**根因**：H4 把 `_leaveAllActiveTeams` (close/markClosed) + `delete()` 段 1 (delete) dup 合并成 `leaveTeamsAndAutoArchive(sid, reason)`，archive reason 由 satisfies map explicit 区分。验证当时只靠代码 diff，缺一个独立 characterization test。

**修法**：新建 `manager-team-coordinator.test.ts` 5 it：
1. `reason="closed"` 走 `archive_reason="last-lead-closed"` + emit team-updated（验证完整 leave→count→archive 链 + emit member-changed）
2. `reason="deleted"` 走 `archive_reason="last-lead-deleted"`（关键差异：reason 区分）
3. 剩余 active lead > 0 时不 archive（仅 leave + emit member-changed）
4. 多 membership 各自分别处理（map → leave → count → archive 链）
5. 无 membership 时立即返回（短路保护）

**文件**：
- `src/main/session/__tests__/manager-team-coordinator.test.ts`（新文件，~180 LOC）

## 验证

- `pnpm typecheck` 双端通过
- `pnpm test src/main/teams/__tests__/ src/main/session/__tests__/manager-team-coordinator.test.ts` — **10 tests 全过**（5 watcher + 5 coordinator）
- `pnpm test src/main/session/__tests__/` — **34 tests 全过**（5 file: manager-helpers/team-coordinator/delete/public-api/ingest），G mock 补全无回归
- E 无 dedicated 单测，dev smoke 覆盖（scheduler.scan 跑时触发新 pagination loop）

## H5 §Step 5.6 backlog 推进状态

完成本 phase 后 H5 backlog 5 项剩 2 项：
- ✅ C MED-D7 done
- ✅ E LOW pagination done
- ✅ G mock 补全 done
- ✅ H characterization test done
- ⏳ I `#sdkOwned` 真私有 — 留 Phase 3
- ⏳ K1/K2/K3 hand off mcp + UI button — 留 Phase 4a/4b/4c
- ⏳ A HIGH 10 + L 卡片增强 + M 透明置顶解耦 — 留 Phase 5
- ⏳ J/B 已 Phase 1 done（CHANGELOG_87）
