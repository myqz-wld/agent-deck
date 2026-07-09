---
review_id: 50
reviewed_at: 2026-05-21
expired: false
---

# REVIEW_50: codex spawn 主路径 applicationSid 漏切到 realId — split-brain 双 row + spawn-link 静默漏写

## 触发场景

用户主动反馈:「spawn codex cli session 显示有问题,在「活跃」section 顶级平铺,没作为 reviewer-claude 同款 child 嵌到 lead 下面」。SessionList 按 `spawnedBy` 树形分组(CHANGELOG_77 Phase C),codex teammate 不嵌套 = `spawned_by` 字段是 NULL。

## 方法

**双对抗配对**(单轮异构,详 `~/.claude/CLAUDE.md`「决策对抗」§主路径):
- reviewer-claude:Claude Opus 4.7,xhigh reasoning,本仓库 SDK `claude -p` oneshot,timeout 600000
- reviewer-codex:Codex gpt-5.5,xhigh reasoning,`codex exec --sandbox read-only --skip-git-repo-check`,timeout 600000

**范围**:8 文件 / spawn-link 写入 + codex bridge spawn 主路径 + ingest 4 态分流 + reverse-rename plan 锚点

```text
src/main/agent-deck-mcp/tools/handlers/spawn.ts                          (spawn_session handler L249-323)
src/main/agent-deck-mcp/tools/handlers/spawn-link-guard.ts               (shouldWriteSpawnLink helper)
src/main/adapters/codex-cli/sdk-bridge/index.ts                          (bridge.createSession 新建路径 L595-690)
src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts                    (startNewThreadAndAwaitId + runTurnLoop firstIdCb)
src/main/adapters/codex-cli/sdk-bridge/types.ts                          (InternalSession applicationSid 注释)
src/main/session/manager.ts                                              (ingest 4 态分流)
src/main/store/session-repo/spawn-chain.ts                               (setSpawnLink 实现)
plans/reverse-rename-sid-stability-20260520.md                           (反向 rename plan 锚点)
```

```review-scope
plans/reverse-rename-sid-stability-20260520.md
src/main/adapters/codex-cli/sdk-bridge/index.ts
src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts
src/main/adapters/codex-cli/sdk-bridge/types.ts
src/main/agent-deck-mcp/tools/handlers/spawn-link-guard.ts
src/main/agent-deck-mcp/tools/handlers/spawn.ts
src/main/session/manager.ts
src/main/store/session-repo/spawn-chain.ts
```

**现场 SQL ground truth**(sqlite3 实测,作为预测对账锚点):

| 字段 | reviewer-claude (46248fed) | reviewer-codex tempKey (2af17d51 / UUIDv4) | reviewer-codex realId companion (019e4961 / UUIDv7) |
|---|---|---|---|
| agent_id | claude-code | codex-cli | codex-cli |
| cwd | `/Users/apple/Repository/personal/agent-deck` | **空字符串** | `/Users/apple/Repository/personal/agent-deck` |
| title | reviewer-claude · plan-review | **sid 自身** | agent-deck |
| spawned_by | 8586626b...(lead ✓) | **NULL ✗** | **NULL ✗** |
| spawn_depth | 1 | 0 | 0 |
| source | sdk | sdk | sdk |
| events session-start | (n/a) | **0 条** | (未独立查) |
| events 总数 | (n/a) | 38 tool-use / 6 message / 3 finished(全 tempKey 行) | (未独立查) |

**约束**:reviewer-codex H1+H2 + reviewer-claude HIGH-1 完全独立同款结论(异构强冗余) + 现场 SQL 6/6 命中预测 → ✅ 真 HIGH。

## 三态裁决结果

### ✅ 真问题(双方独立提出 + 现场实践验证铁证)

| # | 严重度 | 文件:行号 | 问题 | A(claude) | B(codex) | 验证手段 |
|---|---|---|---|---|---|---|
| 1 | HIGH | `src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts:243-262` | codex spawn 主路径 case 1 漏 `internal.applicationSid = ev.thread_id;` 这行 assignment(注释承诺切但代码没切),导致 `bridge.createSession` 返 tempKey 不是 realId,setSpawnLink(tempKey, ...) UPDATE 撞 sessions 表无 row(rename.ts:57 fromRow 不存在直接 noop)→ changes=0 静默失败 → spawned_by 永远 NULL;后续 runTurnLoop 用 `internal.applicationSid=tempKey` emit message → ingest 兜底 ensureRecord 建 tempKey 行(cwd=''/title=sid 自身) | ✅ HIGH-1 | ✅ HIGH-1 + HIGH-2 | ① grep `internal.applicationSid =` 在 codex-cli 0 处生产代码 + claude-code 2 处真实赋值(stream-processor.ts:197 / 328)② SQL 实测 reviewer-codex sid=2af17d51(UUIDv4 = randomUUID 即 tempKey)+ 同时间窗 019e4961(UUIDv7-like = codex realId)双 row 共存 ③ 6 项指标全命中预测(spawned_by=NULL / spawn_depth=0 / cwd='' / title=sid / source=sdk / session-start=0)|
| 2 | MED | `src/main/store/session-repo/spawn-chain.ts:30-34` | `setSpawnLink` SQL UPDATE 撞 0 row 完全静默,任何 sid mismatch 类 bug(本次 HIGH-1 是典型)永久淹没无 log,future regression 无 early signal | ✅ LOW-2 | ✅ MED-1 | 现场 reviewer-codex spawned_by=NULL 反推 setSpawnLink 调用走完没报错;jsdoc 注释明文知道会 changes=0 静默失败但没加防御 |
| 3 | LOW(确认现存) | sessions 表 split-brain 双 row | 同一 codex thread 在 sessions 表里产生**两条 row**:realId 行(firstIdCb emit session-start 建,cwd 正确)+ tempKey 行(runTurnLoop translate-driven emit 建,cwd='')— 违反 plan §不变量 1「sessions.id = applicationSid 应用稳定身份」 | ✅(claude 预测) | ✅(codex 未明 LOW 但路径 trace 一致) | SQL 实测同时间窗 codex-cli 2 条 row 并存,UUIDv4 vs UUIDv7 格式区分 |

### ❓ 部分 / 未验证(留 follow-up)

| 现场 | A 视角(claude) | B 视角(codex) | 是否已验证 | 结论 |
|---|---|---|---|---|
| firstIdCb emit session-start hard-code `sessionId: realId` 与 runTurnLoop emit 用 `internal.applicationSid` 隐式契约 | LOW-1 *未验证* — fix HIGH-1 后两者同源,但 ordering 没显式保证 | (未提) | 否 | ⏸ HIGH-1 fix 后 future case 自然同源,follow-up 可加注释统一 |
| `manager.ts:209` ensure() 新建外部 CLI / session-start record 默认 `cli_session_id=sessionId` plan 实施漏 | (未提) | MED-3 plan §A.4-pre §不变量 1 实施漏 | 否 | ⏸ 不直接撞本 bug,但破坏 reverse-rename plan ingest 反查锚点;follow-up |
| split-brain stale 双 row migration 清理 | LOW-3 *未验证* — 修法只 fix 未来路径,旧 DB 仍 stale | (未提) | 否 | ⏸ 用户主诉是「修不再产生」(确认 ✓);现存 stale row 不在本 fix scope,可手动归档 |
| `sdk-bridge.consume-fork.test.ts` case 1 没断言 applicationSid 切 tempKey → realId | (未提) | LOW-1 测试盲区 | 否 | ⏸ 配套加单测验回归,follow-up |

### ❌ 反驳(双方一致排除)

| 报告方 | 报项 | 反驳依据 |
|---|---|---|
| 用户初步推测 | 「ingest 4 态分流跟 spawn 主路径 race」 | 双方 trace 都指向 codex spawn 主路径 ctor 时 applicationSid 漏切到 realId,ingest 4 态分流(findByCliSessionId / 黑名单 / pendingSdkCwds / ensureRecord 兜底)在反向 rename 设计下行为正确,本 bug 是 plan §A.4-pre S3 codex 端 thread-loop case 1 实施漏(claude 端正确),ingest 只是受害者 |
| 用户初步推测 | 「shouldWriteSpawnLink/callerExists 失效」 | shouldWriteSpawnLink 在普通 spawn(batonMode=undefined)返 true,callerExists=true(lead 在 sessions 表),条件分支正确 enter setSpawnLink 调用,本 bug 不在条件 guard 而在 sid 值本身错 |

## 修复(CHANGELOG_139 落地)

### HIGH-1(thread-loop.ts case 1 加 1 行 assignment)

```ts
// src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts case 1(spawn 主路径 first thread.started)
internal.applicationSid = ev.thread_id;  // ← 加这行
internal.threadId = ev.thread_id;
```

修法对称 claude 端 `stream-processor.ts:328`「`internal.applicationSid = realId`」。fix 后链路:
- `bridge.createSession` line 689 return `{sessionId: internal.applicationSid}` 返 realId(不再是 tempKey)
- spawn handler 拿到 sid = realId
- spawn.ts:320 `setSpawnLink(realId, caller, depth)` 命中 realId row(firstIdCb emit session-start 已建)→ spawned_by 正确写入
- runTurnLoop emit 用 `internal.applicationSid = realId` → 全部 events 写到 realId 行,**split-brain 消失**

### MED(spawn-chain.ts setSpawnLink 加 changes=0 warn)

```ts
const info = ...prepare(...).run(spawnedBy, depth, id);
if (info.changes === 0) {
  console.warn(`[setSpawnLink] UPDATE 0 rows for id=${id} ...`);
}
```

future regression early signal,不静默淹没。

### LOW(留 follow-up)

- LOW-1 firstIdCb emit hard-code realId 隐式契约 → HIGH-1 fix 后自然同源,可加注释明示
- LOW-3 split-brain stale 双 row migration → 用户当前 DB 里残留 2af17d51(tempKey 行)+ 019e4961(realId 行)双条,fix 后**新**起的 codex teammate 不会再撞;旧 stale row 用户可手动归档,不在本 fix scope
- 测试盲区(reviewer-codex LOW-1):`sdk-bridge.consume-fork.test.ts` case 1 加 `expect(internal.applicationSid).toBe('NEW_ID')` 断言 → 锁定不变量

### ensure() 默认 cli_session_id=sessionId(reviewer-codex MED-3)

留 follow-up:plan reverse-rename §A.4-pre §不变量 1 列出但实施漏,不直接撞本 bug 但破坏 ingest 反查锚点。下次 plan 实施 closure 时一并补。

## 验证

- typecheck ✓ 0 errors
- vitest `src/main/adapters/codex-cli + src/main/store/session-repo` 82 pass / 7 skip / 0 fail
- 现场 SQL 6/6 命中根因预测(双 reviewer 独立同款 trace + grep `internal.applicationSid =` codex 0 处)

**用户实测路径**:重启 dev / 重装 .app → lead spawn 一个 codex teammate(如再起 reviewer-codex)→ SessionList 应嵌套显示在 lead 下面(↳ teammate badge,与 reviewer-claude 同款)。

## 触发对照

reviewer-claude finding 文件:`/var/folders/sr/.../reviewer_claude_out.bH0oFN`
reviewer-codex finding 文件:`/var/folders/sr/.../reviewer_codex_out.bnrswr`
