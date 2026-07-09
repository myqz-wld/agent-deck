# REVIEW_85 — 全项目 deep review 批 F1：MCP spawn_session + 防递归 guard 子系统

- 日期: 2026-05-31
- 类型: Debug / 功能 BUG + 代码优化 + 文字措辞（全项目 deep review 第十五批，Batch F 子批 F1）
- 触发: 用户「deep review 下项目，自主一路推进 + 自主 hand off」授权（plan deep-review-project-20260531）
- 关联: plan deep-review-project-20260531 / REVIEW_32（spawn HIGH-5 sandbox 继承 + fan-out race）/ REVIEW_28（spawn-guards §6.2 移除 + rate-token 顺序）/ CHANGELOG_100（team ensure 前移 + wire format 双锚点）/ REVIEW_71（hand-off baton role）
- 方法: 多轮异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5，**fresh pair dr-project-f-20260531**，E pair 已 closed）+ 三态裁决 + lead 现场验证（grep member-crud TeamInvariantError 多 throw site / grep spawn.ts 副作用 try/catch 不对称 / 读 lifecycle.ts recordCreatedPermissionModeImpl 三可抛点 / rate-limiter 边界算例）+ 5 fix 全 temp-revert 非空验证。
- 收口: R1 单轮 **异构 divergence 互补盲点**（reviewer-codex 3 MED team-transactionality / reviewer-claude 2 MED resource-lifecycle，零重叠）。所有 MED 单方独有走 lead 现场 Grep/Read 验证升 ✅。0 残留 HIGH。

## 范围（批 F1）

MCP `spawn_session` handler + 防递归 guard 子系统 5 文件 ~852 LOC：

| 文件 | LOC | 职责 |
|---|---|---|
| `agent-deck-mcp/tools/handlers/spawn.ts` | 491 | spawn_session 主 handler（防御链 + createSession + team membership + wire prefix + placeholder）|
| `agent-deck-mcp/spawn-guards.ts` | 146 | depth / fan-out / spawn-rate 三道防递归 + handOffMode 跳过 |
| `agent-deck-mcp/rate-limiter.ts` | 108 | 滑动窗口 RateLimiter + per-caller InFlightChildrenCounter |
| `agent-deck-mcp/tools/handlers/_shared/default-impl-deps.ts` | 78 | 4 个 impl 共用 fs/git/process default helper |
| `agent-deck-mcp/tools/handlers/spawn-link-guard.ts` | 28 | hand-off 路径 spawn-link write guard |

> `default-impl-deps.ts` / `spawn-link-guard.ts` 双方均 0 finding（纯 helper + 单判定函数，逻辑直白）。

## 三态裁决结果（R1 异构 divergence — 互补盲点）

**核心**：两 reviewer 零重叠。reviewer-codex 全押 `spawn_session(teamName)` post-create 副作用**非事务化**（team membership / placeholder 任一失败仍返回 ok → teammate 首轮 reply 撞 no-shared-team）；reviewer-claude 全押**资源 lifecycle 不对称**（in-flight 计数泄漏 + 唯一未包 try/catch 的副作用产生孤儿 session）。

### [MED ✅ reviewer-codex 单方 + lead grep 验证] spawn.ts:398 — TeamInvariantError catch 过宽，吞掉 lead-count 失败当幂等成功

reviewer-codex 单方。lead addMember 的 catch `if (!(e instanceof TeamInvariantError)) throw e` 把**所有** `TeamInvariantError` 吞当「caller 已是 lead」幂等成功。但 `member-crud.ts` 该 error type 复用 ≥3 处语义：`:111` 已 active member / `:139` lead-count >= MAX_LEADS_PER_TEAM(10) / rejoin `:119`。当 caller 传已有 active team 且该 team 已满 10 lead 且 caller 非成员 → caller 不被加入 → 继续把新 session 加 teammate → 返回 ok → caller 与新 session **无 shared active team** → 首轮 `send_message` 撞 `send.ts:57` no-shared-team。

```ts
} catch (e) {
  // 已 active 时 invariant 抛错；视为「已是 lead」幂等成功
  if (!(e instanceof TeamInvariantError)) throw e;  // ← 也吞了 lead-count 超
}
```

**lead 验证（grep）**：`member-crud.ts:111/119/139/192` 全抛同一 `TeamInvariantError` class，`:139` 明确是 `lead count ${n} >= ${MAX_LEADS_PER_TEAM}`；`send.ts:57` no-shared-team 固定 reject；grep tools.test.ts 无 lead-count/full-team spawn 分支覆盖。

**修法**：吞之前 `findActiveMembershipIn(teamId, callerSid)` 反查 caller 是否真已是 active **lead**；`role !== 'lead'`（lead-count 超 / 已是 teammate）则 re-throw 让外层 catch（MED-2 修法）走降级。+2 回归 test（caller 非 lead → err / caller 已 lead → 吞幂等成功）。

### [MED ✅ reviewer-codex 单方 + lead grep 验证] spawn.ts:431 — addMember 失败只 warn，spawn 仍返回 dishonest ok + 孤儿

reviewer-codex 单方。outer addMember catch 仅 `logger.warn` 吞掉 lead/teammate 任一 membership 写失败。此时 `teamId` 仍保留 → 下方 placeholder 照插 → 末尾 return ok 带 teamId。teammate membership 写失败 → 新 session 不在 team；lead membership 写失败且 caller 原本不在 team → 双方不共享 team。两路径都让 teammate 按 prompt 调 send_message 后被拒。对照 createSession-catch（spawn.ts:322-336 CHANGELOG_100 R2）有 `teamCreatedNow → hardDelete` 空 team cleanup，但 addMember-catch 完全没有。

```ts
} catch (e) {
  logger.warn(`[mcp spawn_session] addMember failed for "${args.teamName}":`, e);  // ← 仅 warn，无 cleanup，继续返回 ok
}
```

**lead 验证（grep）**：spawn.ts:215-237 wire prefix/lead context 在 membership 落库前生成；spawn.ts:453-465 placeholder 插入只检查 teamId/callerExists/placeholderId 不验证 shared membership；createSession-catch 的 hardDelete cleanup 仅存在于 L324（addMember-catch 无）。

**修法**：team setup 失败 = 整个 team-spawn 失败 → `await sessionManager.close(sid)` 关孤儿 session + cleanup 本次新建空 team（mirror createSession-catch re-verify-empty 防并发抢先）+ return err（hint 指导 caller 修 team 条件后 retry 或 spawn without teamName）。+1 回归 test（teammate addMember 失败 → close 孤儿 + 返 err）。

### [MED ✅ → known follow-up] spawn.ts:455 — placeholder 在 prompt 发出后才创建，reply anchor 无先验保证

reviewer-codex 单方。`promptForSpawn` 已带 `[msg <placeholderId>]` 交 SDK，但 DB placeholder 在 createSession 返回 + setSpawnLink + setTitle + addMember 之后才 insert。receiver 开始处理 prompt 时 anchor row 无先验存在保证；insert 抛错时永久不存在 → send_message 对缺失 anchor 固定拒绝。

**裁决：✅ 真问题但 = 已记 follow-up**（REVIEW_32 §Follow-up MED-2，spawn.ts:446-450 注释已自述）。最小防御已在位（insert 失败时返回 `spawnPromptMessageId=null`，lead 不会等不存在的 anchor）。真修法需 placeholder insert 提到 createSession 之前 + messageRepo `initialStatus='delivered'` / `updateToSessionId` helper（scope 较大）。本批不实施，保留 follow-up（codex 独立复现确认问题真实存在）。

### [MED ✅ reviewer-claude 单方 + lead grep 验证] spawn.ts:72→156 — fanOutSlot inc 早于 try/finally，中间裸 DB read 抛错泄漏 in-flight 计数

reviewer-claude 单方。`applySpawnGuards`（旧 L72）同步 `inFlightChildren.inc()` 拿 fanOutSlot，但保证 release 的 try/finally 到旧 L247 才开始。窗口内旧 L156 `sessionRepo.get(caller)` 是 better-sqlite3 同步查询可抛（SQLITE_BUSY / I/O）。抛出 → 越过 handler（withMcpGuard 不 catch，tools/index.ts:155 也不 catch）→ `fanOutSlot.release()` 永不执行 → 该 caller in-flight 计数 +1 **永久泄漏**（dec 仅 release 一条路径，byParent Map 进程级常驻）→ effective fan-out 预算被幻影占用，反复失败致彻底 spawn 不出。违反本模块自述「in-flight 计数 race 保护」核心不变量。

**lead 验证（grep + Read）**：core-crud.ts:103 `get` 是裸 `prepare().get()` 可抛；spawn.ts guard 与 try 之间唯一 try 是 ensureByName（自带 catch），leadRecord get 在 try 外；rate-limiter.ts dec 仅 release 一条路径。

**修法**：applySpawnGuards 下移到「所有 createSession 前的纯计算 + 可抛 DB 读（leadRecord）+ agentName body resolve」之后、ensureByName 之前。guard 到 createSession-try 之间无裸抛点 → 泄漏窗口归零。**顺带消 LOW-1**（agentName resolve 现在 guard 前，拼错不再消耗 rate token）。+1 回归 test（in-process transport leadRecord get 抛错 → in-flight 零变化；temp-revert guard 上移 → `expected 1 to be +0`）。

### [MED ✅ reviewer-claude 单方 + lead Read 验证] spawn.ts:348 — recordCreatedPermissionMode 是唯一未包 try/catch 的 post-createSession 副作用 → 孤儿 session + 误报失败

reviewer-claude 单方。createSession 成功返回 sid（SDK 子进程已起）后，所有副作用遵循「失败不阻塞 spawn 成功」并包 try/catch：setTitle / addMember / placeholder insert。**唯独 recordCreatedPermissionMode 裸调**。其 impl（manager/lifecycle.ts:248-256）执行 `setPermissionMode`(DB 写) + `sessionRepo.get`(DB 读) + `eventBus.emit('session-upserted')`(同步派发监听器，任一监听器抛会冒泡)。抛出 → 越过 handler（此时 fanOutSlot 已 release）→ caller 收 MCP error 拿不到 sessionId，而 SDK 子进程仍在运行 → **孤儿活 session + caller 可能重试导致重复 spawn**。

**lead 验证（grep + Read）**：grep spawn.ts post-createSession 副作用，setTitle/addMember/placeholder 各自 try/catch+warn，仅 L348-350 无包裹（异构不对称硬证据）；Read lifecycle.ts:248-256 确认含 setPermissionMode + get + emit 三可抛点。

**修法**：包 try/catch + logger.warn（与 sibling 一致），失败仅 warn 不阻塞 spawn 成功（permissionMode 持久化失败最坏 fallback 默认 mode，远比孤儿活 session 轻）。+1 回归 test（recordCreatedPermissionMode 抛错 → spawn 仍返回 sessionId；temp-revert → throw 越过 handler test FAIL）。

### [LOW ✅ reviewer-codex 单方 + lead 算例验证] rate-limiter.ts:60 — 滑动窗口 exact-boundary off-by-one

reviewer-codex 单方。`retryAfterMs()` 在 `now === oldest + windowMs` 返 0，但 `prune()` 用 `< threshold` 不删等于 threshold 的 oldest → 下次 tryConsume 仍因 length >= max 拒 1ms → 「retry after 0ms 但立即 retry 仍失败」。`universal-message-watcher/rate-limiter.ts` PerKeyRateLimiter 同款（双 limiter 共病）。

**lead 验证（算例）**：oldest=0、windowMs=60000、now=60000 → retryAfterMs=`max(0, 60000-(60000-0))`=0，但 `0 < 0` false → 不裁 → length >= max 仍拒。

**修法**：两个 limiter prune/trim 条件 `< threshold` → `<= threshold`（滑动窗口语义是半开区间 (now-windowMs, now]，边界 timestamp 不应计入 → 与 retryAfterMs 边界返 0 一致）。+2 回归 test（spawn-guards.test.ts；exact-boundary retryAfterMs=0 后 tryConsume 立即成功 / 多 quota 边界出窗；temp-revert `<` → 2 test FAIL）。

### [LOW ✅ reviewer-codex 单方，已随 MED-A 修复] spawn.ts:72 — unresolved agentName 消耗 app-wide spawn-rate token

reviewer-codex 单方。旧实现 applySpawnGuards（L72 消耗 rate token）在 agentName body resolve（L108）之前 → 拼错 agentName 提前 `fanOutSlot.release()` 但**不返还 rate token** → 连续拼错占满 app-wide quota 影响合法 spawn。

**裁决：✅，随 MED-A guard 下移一并消除**（guard 现在 agentName resolve 之后，拼错 agentName 在 guard 前就 return err，根本不进 guard / 不消耗 token）。无需独立 fix。

### [INFO ✅ reviewer-claude] spawn.ts:148 — `[caller-scoped]` 注释内联行号漂移

reviewer-claude。caller-scoped 副作用清单注释写「L307/L367/L442/L473」实际已漂移 ~9-12 行（anchor `[caller-scoped #N/4]` 准确，导航不受影响，仅内联数字 doc-rot）。**修法**：删内联行号改引 anchor 名（anchor 是 SSOT，行号随每次编辑漂移反成维护负担）。

### [INFO] 双方已核实无问题项（裁决参考）

- **reviewer-claude**：spawn-guards race fix（setSpawnLink-in-try 先于 release-in-finally）闭合窗口正确 ✓；handOffMode 不 inc/不 setSpawnLink/release no-op 三者对称 ✓；teamCreatedNow re-verify 防并发双 spawn ✓；spawnDepth ok-return fallback ✓；options-builder 继承链 + reviewer-* codexSandbox override warn ✓；spawn.ts 491 行 ≤500 临界（下次加副作用需抽子模块）。
- **reviewer-codex**：spawn-guards 三道顺序（depth O(1) → fan-out → rate consume）+ handOffMode 短路 token 不消耗逻辑正确；default-impl-deps / spawn-link-guard 无问题。

## 修复清单

| # | 文件:行 | 严重度 | 修法 | 验证 |
|---|---|---|---|---|
| 1 | spawn.ts:~408 | MED ✅ | TeamInvariantError 吞前反查 caller 是否真 active lead，非 lead re-throw | codex 单方 + lead grep member-crud + 2 test temp-revert 非空 |
| 2 | spawn.ts:~460 | MED ✅ | addMember 失败 close 孤儿 session + cleanup 空 team + return err | codex 单方 + lead grep cleanup 不对称 + 1 test temp-revert 非空 |
| 3 | spawn.ts guard 下移 | MED ✅ | applySpawnGuards 下移到 leadRecord+agentName 之后 → 泄漏窗口归零 | claude 单方 + lead grep 裸抛点 + 1 test temp-revert `expected 1 to be +0` |
| 4 | spawn.ts:~362 | MED ✅ | recordCreatedPermissionMode 包 try/catch+warn（对齐 sibling）| claude 单方 + lead Read lifecycle 三可抛点 + 1 test temp-revert 非空 |
| 5 | rate-limiter.ts:60 + universal-message-watcher/rate-limiter.ts:28 | LOW ✅ | prune/trim `< threshold` → `<= threshold`（双 limiter）| codex 单方 + lead 算例 + 2 test temp-revert 非空 |
| — | spawn.ts agentName 顺序 | LOW ✅ | 随 #3 guard 下移消除（拼错 agentName 不再消耗 token）| codex 单方，无独立 fix |
| — | spawn.ts:148 注释 | INFO ✅ | 删内联行号引 anchor 名 | claude，doc-only |

## 验证

```
typecheck（双配置 tsconfig.node + tsconfig.web）：PASS
node_modules/.bin/vitest run agent-deck-mcp/__tests__/（全 36 files）：588 passed | 3 skipped
node_modules/.bin/vitest run teams/（message-watcher rate-limiter LOW-2 触及）：24 passed
新增回归 test：tools.test.ts +5（MED-1×2 / MED-2×1 / MED-B×1 / MED-A×1）+ spawn-guards.test.ts +2（LOW-2 边界）= 7 test
temp-revert 全验证非空：
  MED-1 → "team setup failed" 不出现 FAIL
  MED-2 → "team setup failed" 不出现 FAIL
  MED-B → recordPerm throw 越过 handler → ok 断言 FAIL
  MED-A → guard 上移回 leadRecord 前 → inFlight 泄漏 "expected 1 to be +0" FAIL
  LOW-2 → prune `<=`→`<` → 2 boundary test FAIL
```

## 结论

**Batch F 开篇批**。spawn_session 是 7 大 handler 最重的一个（防御链 + createSession + team membership + wire prefix + placeholder 五段），guard 子系统经多轮历史 review（REVIEW_27/28/32/39）已扎实，0 HIGH。本轮挖出 5 真 MED/LOW + 1 known follow-up，全单方独有但全过 lead 现场 Grep/Read 验证升 ✅。

**异构对抗价值**：教科书级互补盲点——reviewer-codex 全押 **team-transactionality**（spawn_session(teamName) post-create 副作用非事务化的三种失败路径都让 teammate 首轮 reply 失败），reviewer-claude 全押 **resource-lifecycle**（in-flight 计数泄漏窗口 + 唯一未包 try/catch 的副作用产生孤儿 session）。两组维度零重叠，单 reviewer 必漏一半。共性主题殊途同归：**spawn 失败/异常路径的清理不彻底**——codex 看 team 数据残留，claude 看 session/计数残留。修法统一为「失败路径要么干净回滚（close 孤儿 + cleanup 空 team + return err）要么 swallow 不阻塞（permissionMode warn）」。

## Follow-up（留用户回来决策）

1. **[MED 已记] placeholder 在 prompt 发出后才创建**（REVIEW_32 §Follow-up MED-2，codex F1 独立复现）——真修法需 placeholder insert 提到 createSession 前 + messageRepo initialStatus='delivered'/updateToSessionId helper（scope 较大），最小防御（insert 失败返 null）已在位。
2. **[INFO] spawn.ts 491 行临界 500 护栏**（reviewer-claude）——下次再加副作用需抽子模块（如 team-membership-setup helper）。
