# REVIEW_83 — 全项目 deep review 批 E1：session manager 核心子系统（Batch E 开篇）

- 日期: 2026-05-31
- 类型: Debug / 功能 BUG + 代码优化 + 文字措辞（全项目 deep review 第十三批，Batch E 子批 E1）
- 触发: 用户「deep review 下项目，自主一路推进 + 自主 hand off」授权（plan deep-review-project-20260531）
- 关联: plan deep-review-project-20260531 / REVIEW_49（advanceState closed/archived 短路前身）/ REVIEW_56（applyClosedSideEffects 三入口）/ REVIEW_76+81（recover-and-send closed-revival 同源机制）
- 方法: 多轮异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5，**fresh pair** team dr-project-e-20260531；旧 D pair 已 closed）+ 三态裁决 + lead 全链 trace + **un-skip 既有回归 test 实测复现** + git archeology 可达性裁决 + 真 SQLite temp-revert 验证。
- 收口: R1→R3 三轮。R1 双方独立收敛同一 HIGH（closed 复活短路被架空）；R2 双方验证 fix + reviewer-codex 在 store 层（reviewer-claude 互补盲点）抓独立 finding（rename 漏迁 tasks/issues）；R3 reviewer-codex 接受 lead 可达性裁决（HIGH→MED）+ 双方共识 conclude。**0 未修 HIGH/MED**。

## 范围（批 E1）

session manager 核心子系统 8 文件 ~1667 LOC + 连带 manager-ingest-pipeline.ts（advanceState 修法落点）：

| 文件 | LOC | 职责 |
|---|---|---|
| `session/manager.ts` | 446 | SessionManager facade — sdk-claim 5 method + ensure + ingest 入口 4 态分流 + lifecycle/rename thin delegate |
| `session/manager-ingest-pipeline.ts` | 261 | ingest 5 段流水线（dedupOrClaim / ensureRecord / persistEventRow / persistFileChange / advanceState）|
| `session/manager-team-coordinator.ts` | 233 | session×team 联动（leaveTeamsAndAutoArchive / archive/unarchive teams / applyClosedSideEffects）|
| `session/manager/lifecycle.ts` | 337 | lifecycle 8 method + 黑名单 + meta free function |
| `session/manager/rename.ts` | 157 | renameSdkSessionImpl + updateCliSessionIdImpl |
| `session/manager/_deps.ts` | 94 | type SSOT + SessionManagerInternalState + isRecentlyDeletedImpl |
| `session/manager-helpers.ts` | 84 | normalizeCwd / nextActivityState / extractCwd / deriveTitle pure helper |
| `session/manager-enrich.ts` | 55 | teams[] 拼装（单 + 批量）|

> **连带修改**（出 E1 文件清单但同子系统）：`session-repo/rename.ts`（reviewer-codex R2 store 层 finding 落点；renameWithDb 是 renameSdkSession 的 DB 实现）。

## 三态裁决结果

### [HIGH ✅ 双方独立提出 + lead un-skip 回归 test 实测复现] manager.ts:251 — ensure() 复活 closed→active 架空 advanceState 的 REVIEW_49 短路

reviewer-claude + reviewer-codex **双方 R1 独立提出**（codex 还写了一次性 repro test `expected 'active' to be 'closed'`），lead 提前自己也 trace 到。

`ingest()` 5 段顺序 `ensureRecord(L325) → … → advanceState(L328)`。`ensure()`（manager.ts:251）对任何 existing closed record **先一步**复活成 active 并 emit `session-upserted`；等 `advanceState`（pipeline:230）拿到 record 时 `lifecycle` 已是 active → REVIEW_49 R3 HIGH-2 的 `record.lifecycle === 'closed'` 短路恒为 false，**永远拦不到 closed**。后果：closed session（典型 `shutdown_session` 后的 reviewer）收到迟到 hook event（CLI 子进程 buffer 异步飞回）仍假活回实时面板——正是 REVIEW_49 想阻止的「我刚 shutdown 的 reviewer 又活了」。

```ts
// manager.ts:251（修前）
if (existing.lifecycle === 'closed') {
  const revived = { ...existing, lifecycle: 'active', endedAt: null };
  sessionRepo.upsert(revived);
  eventBus.emit('session-upserted', revived);  // ← 假活早于 advanceState 短路
  return revived;
}
```

**lead 验证（三重）**：
1. 代码追踪 ingest 5 段顺序（ensureRecord 在 advanceState 之前）确凿
2. **既有回归 test 自承认**：`manager-ingest.test.ts:267` 该 test 被 `it.skip`，注释 L265-266「pre-existing fail(main HEAD 同款 fail)…本 plan 顺手 skip 让 vitest pass」
3. **lead un-skip 实测**：临时去 `.skip` 跑 → FAIL `expected 'active' to be 'closed'`，确定性复现

**关键 fix 安全性**：不能直接删复活——**legit resume 路径依赖它**（recover-and-send-impl.ts:154 emit `source:'sdk'` user message 触发复活 + REVIEW_76 `wasClosed` 回滚）。修法按 **source 区分**：

```ts
// manager.ts:251（修后）
if (
  existing.lifecycle === 'closed' &&
  existing.archivedAt === null &&   // 同源子问题：归档与 lifecycle 正交，事件流不偷改归档会话 lifecycle
  opts.source === 'sdk'             // 仅 SDK 通道（用户 resume）复活；hook/cli 迟到事件不复活
) { ... }
```

`source==='sdk'` 守卫让 advanceState 短路对非 sdk closed 事件真正生效；`archivedAt===null` 守卫修 reviewer-claude R1 提的「closed+archived 被事件流偷改 lifecycle」**同源子问题**。lead 验证全 legit 复活路径都用 `source:'sdk'`（claude/codex recover-and-send + live events + task ingest 全核），无误挡。

### [MED ✅ reviewer-codex 单方 + lead 代码链验证] manager-ingest-pipeline.ts:230 — archived+active 收 session-end 被整段短路，unarchive 后幽灵 active

reviewer-codex 单方提出（reviewer-claude 互补盲点未审 archived+terminal 角度）。`archiveImpl`（lifecycle.ts:178）只写 `archivedAt` 不动 lifecycle；`advanceState` 对 `archivedAt !== null` 一律 return → archived 的 active 会话收 `session-end` 时 lifecycle 永停 active（endedAt 也不写）。叠加 scheduler `findActiveExpiring`/`findDormantExpiring` 都过滤 `archived_at IS NULL` 不参与衰减 → unarchive 后该会话以幽灵 active 出现在实时面板（实际早已结束）。

**lead 验证**：archiveImpl 只 setArchived（lifecycle.ts:178-183）+ advanceState session-end 分支在 archived return 之前（pipeline:230）+ scheduler SQL 过滤 archived（session-repo/lifecycle.ts:36,46）三者叠加确凿；active session 可被 archive（IPC SessionArchive sessions.ts:53 / hand-off baton）。

**修法**：archived 短路新增 **session-end 终止例外**：

```ts
// pipeline:230（修后）
if (record.lifecycle === 'closed') return;  // closed 终态：任何事件短路
if (record.archivedAt !== null) {
  if (event.kind === 'session-end') {
    const term = event.source === 'sdk' ? 'dormant' : 'closed';
    if (term !== record.lifecycle) {
      sessionRepo.upsert({ ...record, lifecycle: term, endedAt: term === 'closed' ? event.ts : null });
    }
  }
  return;  // 不 emit session-upserted（archived 不实时广播；unarchive 时 unarchiveImpl 读 fresh lifecycle 再 emit）
}
```

reviewer-claude R2 四场景逐态精算自洽（archived+dormant+SDK→noop / archived+dormant+hook→closed / archived+active+SDK→dormant / closed 短路在 archived 检查之前不重复处理）+ 确认「不 emit」不构成 user-visible store 滞后（archived 不在 list()/实时面板，unarchive 时 unarchiveImpl setArchived(null)+get fresh+emit 兜底）。

### [MED ✅ reviewer-codex 单方 R2 + lead 现场验证（HIGH→MED 降级）] session-repo/rename.ts — renameWithDb 漏迁 tasks/issues/issue_appendices，DELETE OLD 触发 CASCADE/SET NULL

reviewer-codex R2 在 store 层（reviewer-claude 未覆盖维度，互补盲点非反驳）提出，初评 HIGH。`renameWithDb` 子表迁移清单（events/file_changes/summaries/team_members/messages×2/spawned_by 共 6 类）**漏了** tasks/issues/issue_appendices。`renameSdkSession` 末尾 `DELETE FROM sessions WHERE id=fromId` 触发：tasks FK `ON DELETE CASCADE`（v023，物理删 OLD 的 task）+ issues/appendix FK `ON DELETE SET NULL`（v026，断 OLD 上报/解决归属 + appendix 快照）。

**lead git archeology**：renameWithDb 最后改于 commit 579f934（v021 reverse-rename plan），**早于** v023(tasks FK)/v026(issues FK)，清单从未补这三表——经典「facade 加表时漏更新迁移清单」latent gap。

**lead 现场验证可达性 → 裁 MED（非 codex 所提 HIGH）**：现两个 live caller 都是 `renameSdkSession(tempKey, realId)` spawn bootstrap（grep runtime 非测试 call 仅 stream-processor.ts:338 + thread-loop.ts:171）：
- **codex**：tempKey 行从未进 sessions 表（thread-loop.ts:168-169 注释「等到 thread.started 才 claim」+ session-start emit 用 realId）→ FK 要求 owner 行存在故无 task/issue 挂 tempKey → rename 是 from-missing noop
- **claude**：applicationSid 在首条 SDK 消息 handler 先切 realId（stream-processor.ts:331）**再** rename（:338），早于 agent 任何 tool_use；callerSidProvider 是 lazy closure 返 `internal.applicationSid`（mcp-server-init.ts:51）→ task_create callerSid 解析为 realId 不挂 tempKey
- **recoverer toExists=true 分支已 dead**：jsonl-missing 早已改 `resumeMode='fresh-cli-reuse-app'` 复用 applicationSid + updateCliSessionId（不删行不 rename，recover-and-send-impl.ts:331-332 明示「**不** renameSdkSession」）

→ 现无 live 数据丢失（故非 HIGH），但「一次重构之差」（任何新 caller rename 一个已积累 task/issue 的长存 session）即 silent 数据损坏 → 按「会话身份迁移」不变量补齐，与 6 表同段迁移对称。reviewer-codex R3 接受降级 + 确认未找到漏掉的 live HIGH 路径。

**修法**：DELETE OLD 之前补 4 条 UPDATE（tasks.owner_session_id / issues.source_session_id / issues.resolution_session_id / issue_appendices.appended_session_id 全迁 fromId→toId）。lead 核 v001-v026 全部 migration 确认 session-FK 表 = events/file_changes/summaries/team_members/messages×2/spawned_by + tasks/issues×2/issue_appendices 共 10 列，fix 后全覆盖。

### [INFO by-design / 已治 / 提示性] 其余 finding

- **reviewer-claude INFO**：dormant 复活（advanceState 任何 source 都复活）vs closed 复活（source==='sdk' 守卫）**不对称 = by-design**：dormant 是可恢复态（外部 CLI 时间衰减进 dormant 后真实 hook 续跑是合理复活），closed 是终态（迟到 hook 是尾包噪声）。lead 同意。
- **reviewer-claude INFO**：pendingSdkCwds 过期 entry 残留（caller 不调 release closure 时）→ 非致命自清（consumePendingSdkClaim 下次同 cwd ingest 清；sdk-bridge createSession finally 调 release）。
- **reviewer-claude INFO**：summarizer inFlight+rename 迁移 / renameSdkSession 6 步原子性 / mcpSessionTokenMap.rename noop 边界 / lifecycle-scheduler 批量+applyClosedSideEffects fire-and-forget race → 复核全部已被 REVIEW_35/56 治过，本轮无新问题。
- **reviewer-claude INFO**：markClosedImpl/markDormantImpl 不写黑名单不 releaseSdkClaim = 设计意图（自然衰减 session 可能仍在跑，区别于 close() 立即终止）；配合 Fix 1 后 closed 即便 sdkOwned 仍 claim，迟到 hook 走 dedupOrClaim hasSdkClaim 拦 + 漏网非 sdk 事件被 ensure source 守卫拦 → 双层防护闭合。
- **reviewer-claude INFO**：Step 4.6 / CHANGELOG_86 facade 拆分正确性 ✅（internalState.recentlyDeleted 同 Map ref 共享 / transferSdkClaim callback 顺序 byte-identical / ingestCtx Object.freeze 闭包封 raw state / renameWithDb 事务原子）。拆分干净未引入新问题也未掩盖 HIGH（保持含 bug 的等价行为）。

## 修复清单

| # | 文件:行 | 严重度 | 修法 | 验证 |
|---|---|---|---|---|
| 1 | manager.ts:251 | HIGH ✅ | ensure() 复活加 `lifecycle==='closed' && archivedAt===null && source==='sdk'` 三守卫 | 双方独立 + un-skip 回归 test 实测 `expected 'active' to be 'closed'` + temp-revert 2 test |
| 2 | manager-ingest-pipeline.ts:230 | MED ✅ | advanceState archived 短路新增 session-end 终止例外（落终态不 emit）| codex 单方 + lead 代码链 + temp-revert 2 test |
| 3 | session-repo/rename.ts | MED ✅（HIGH→MED）| DELETE OLD 前补 4 条 UPDATE 迁 tasks/issues×2/issue_appendices | codex R2 单方 + lead git archeology 可达性裁决 + 真 SQLite temp-revert 2 test |

## 验证

```
typecheck（双配置）：PASS
node_modules/.bin/vitest run src/main/session：7 files / 60 passed（manager-ingest 14 含 un-skip closed + 4 新增）
rename 迁移 test（node 20.18.3 + rebuild better-sqlite3 临时）：2 REVIEW_83 test PASS（23 passed，3 失败均 pre-existing 与本改无关）
  → 跑完已还原 Electron ABI 130 binding（byte-identical 备份）
HIGH temp-revert：移除 source 守卫 → manager-ingest 2 test FAIL（closed hook 复活 / closed+archived 复活）
MED-2 temp-revert：恢复旧 archived 一律短路 → 2 test FAIL（archived+active SDK session-end 不落 dormant / hook 不落 closed）
MED-3 temp-revert：移除 4 条 UPDATE → 2 test FAIL（task undefined=被 CASCADE 删 / issue null=被 SET NULL）
```

## 结论

**Batch E 开篇批**。session manager 核心（ingest 5 段 / dedupOrClaim / ensure / lifecycle 状态机 / rename 跨表迁移 / team 联动 / facade 拆分）扎实，Step 4.6 拆分 byte-identical 干净。本轮挖出 1 HIGH（closed 复活短路架空，双方独立 + 既有 it.skip 回归 test 已埋雷）+ 2 MED（archived session-end 漏终态 + rename 漏迁 tasks/issues），均确定性复现 + temp-revert 验证非空。

**异构对抗价值**：HIGH 双方独立收敛（强冗余）；2 MED 都是单方互补盲点（codex 抓 archived+terminal + store 层迁移完整性，reviewer-claude 未覆盖；reviewer-claude 抓 facade 拆分正确性 + 历史治理项复核，reviewer-codex 未深入）。rename HIGH→MED 降级是 lead 现场可达性验证拦截 over-grading（codex R3 接受）的范例——既不放过真问题（latent gap 仍补齐防未来 footgun），也不盲从严重度。

**收口**：R3 双方共识 conclude，0 未修 HIGH/MED。

## Follow-up（留用户回来决策）

1. **[INFO 跨批] agent-deck-team-repo.test.ts 3 个 pre-existing 失败**（team CRUD unique / list 分页 / findSharedActiveTeams）——baseline（无本改）即 `3 failed`，与 Batch E 无关。疑似 better-sqlite3 ABI 临时 rebuild 环境差异 or 真 pre-existing bug，建议 Batch G（store repos）专项排查。
2. **[已治 by-design] dormant 复活无 source 守卫**（reviewer-claude INFO）——dormant+进程死+残留 hook buffer 误复活 dormant→active 理论边角，危害远小于 closed（dormant 本在实时候选范围），无 user-report，不改。

> Batch E1 ✅ 收口。下一子批 E2（lifecycle-scheduler + issue-lifecycle-scheduler + summarizer + oneshot-llm，除 codex-runner.ts/race-with-timeout.ts 已 D4 审）。
