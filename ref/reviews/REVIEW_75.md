# REVIEW_75 — 全项目 deep review 批 C1：claude-code sdk-bridge entry + create-session + options builder

- 日期: 2026-05-31
- 类型: Debug / 功能 BUG + 代码优化 + 文字措辞（全项目 deep review 第五批，Batch C 子批 C1）
- 触发: 用户「deep review 下项目，自主一路推进 + 自主 hand off」授权（plan deep-review-project-20260531）
- 关联: plan deep-review-project-20260531 / REVIEW_71（A1）/ REVIEW_72（A2）/ REVIEW_73（B1）/ REVIEW_74（B2）
- 方法: 多轮异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5，team dr-project-c-20260531）+ 三态裁决。lead pre-read 全 10 文件 + 代码链实测（emit→ingest→dedupOrClaim 全链 trace + node skip 验证 + diff a21f258~1 回归判定）。
- 收口: R1 双 reviewer reply（codex 2 finding：1 HIGH + 1 MED；claude 4 finding：1 MED + 3 INFO）→ 三态裁决 → 8 finding 全 fix（1 HIGH + 2 MED + 5 INFO）+ 5 回归 test（3 真问题 fix 全 temp-revert 非空验证）。typecheck 双配置 + sdk-bridge 全套 72 passed + 广域 session/adapters 308 passed/1 skipped。

## 范围（批 C1）

claude-code SDK adapter bridge 子系统的 entry facade + 会话创建路径 + options builder，10 文件 ~1644 LOC：

| 文件 | LOC | 职责 |
|---|---|---|
| `sdk-bridge/index.ts` | 470 | facade class shell + ctor（11 sub-module 装配）+ sendMessage / closeSession / setPermissionMode / 2 restart delegate |
| `sdk-bridge/create-session/create-session-impl.ts` | 205 | createSession orchestrator（validate / prepare / sdk-query / finalize 四阶段） |
| `sdk-bridge/create-session/create-session-sdk-query.ts` | 221 | SDK query 段（loadSdk / query 构造 / waitForRealSessionId / try-catch 失败 cleanup） |
| `sdk-bridge/create-session/_deps.ts` | 167 | createSession SSOT types（CreateSessionOpts / Deps / PreparedSessionContext / SdkQueryResult） |
| `sdk-bridge/query-options-builder.ts` | 161 | SDK query() options pure builder |
| `sdk-bridge/mcp-server-init.ts` | 59 | Agent Deck MCP server 拼装（lazy provider） |
| `sdk-bridge/types.ts` | 237 | InternalSession + 6 interface + makeInternalSession factory |
| `sdk-bridge/model-resolve.ts` | 31 | model fallback 链 |
| `sdk-bridge/sandbox-resolve.ts` | 35 | sandbox mode fallback 链 |
| `sdk-bridge/constants.ts` | 58 | AGENT_ID / MAX_MESSAGE_LENGTH / MAX_PENDING_MESSAGES / READ_ONLY_TOOLS re-export |

skip（Batch C 后续子批）：recoverer*（C2）/ stream-processor / sdk-message-translate / session-finalize / jsonl-fallback / send-validation（C3）/ can-use-tool / permission-responder / restart-controller / pending-cancellation（C4）。

> **注**：F1 + F3 fix 落点在 stream-processor.ts（C3 scope）+ create-session-sdk-query.ts（C1 scope），因 finding 根因横跨 createSession 失败/结束边界，C1 评审中一并修。C3 评审 stream-processor 时复查本批改动。

## 结论

**8 finding：1 HIGH ✅ + 2 MED ✅ + 5 INFO ✅，全部 fix + 3 真问题回归 test 非空验证**。

**异构对抗收敛点**：两 reviewer 从互补角度独立指向**同一结构性弱点 —— createSession 失败/结束边界 cleanup 不完整**：
- reviewer-codex 从 **DB-row / sdkOwned 泄漏**角度（下游 emit→ingest 后果 + claim 不对称释放）
- reviewer-claude 从 **orchestrator 无 try/catch**角度（上游 resolver 抛错漏清，runCreateSessionSdkQuery 子模块 try 之前）

两个 reviewer 都不是「双方独立提同一条」，而是同一弱点的**两段独立 gap**。lead 对三个真问题全部做了独立代码链实测取证（满足 §三态裁决 单方 + 现场验证 → ✅）。

---

### [HIGH] `create-session-sdk-query.ts:170` / `stream-processor.ts:219+446` — createSession 失败路径落下孤儿 tempKey DB row（reviewer-codex + lead 代码链实测三重确认 ✅）

- **reviewer 来源**：reviewer-codex HIGH（单方）+ lead 全链 trace + node skip 实测 + diff 回归判定（满足「单方 + 现场验证」→ ✅）。
- **问题**：createSession 失败时（30s timeout / fast-fail no-first-id），catch 只清 in-memory `sessions` Map + release claim，**从不删孤儿 DB row** → SessionList 永久残留一条无 jsonl / 无 SDK live state 的幽灵 dormant 会话。
- **根因链（lead 实测）**：
  1. bridge `emit` → `sessionManager.ingest`（实证 `bootstrap-infra.ts:128`）
  2. consume() 在 try 内必经两处 sdk-source emit：① 30s timeout 的「⚠ SDK 30 秒」error message（`stream-processor.ts:219`）② consume `finally` **必发**的 session-end（`stream-processor.ts:446`，**所有失败路径都走**，不止 30s timeout）
  3. `dedupOrClaim`（`manager-ingest-pipeline.ts:86-160`）5 个 skip 分支**全部要求 `event.source === 'hook'`** → sdk-source event 一个都不命中 → `ensureRecord` **必建** `id=tempKey / source='sdk'` 的 DB row（随后 session-end 经 `advanceState` 推成 dormant）
  4. `create-session-sdk-query.ts:211-216` catch 只 `deps.sessions.delete()`（Map）+ `releasePending` + `releaseSdkClaim`，**无 `sessionRepo.delete`**
- **代码片段（修前 catch）**：
  ```ts
  deps.sessions.delete(internal.applicationSid);
  deps.sessions.delete(tempKey);
  releasePending();
  if (opts.resume) sessionManager.releaseSdkClaim(opts.resume);
  throw err;  // ← 孤儿 DB row id=tempKey 从未删除
  ```
- **验证手段**：
  - `bootstrap-infra.ts:128` 实证 bridge emit → `sessionManager.ingest`
  - node 脚本验证 `dedupOrClaim` 对 sdk-source 事件 `skip=false`（5 分支全 `source==='hook'` 守卫 → fall through → `ensureRecord` 建 row）
  - `grep` 确认 `lifecycle-scheduler.ts` 只按 `historyRetentionDays` 时间清理，**无 session-less/no-jsonl 专门 purge** → 孤儿 row 不会被自动清（默认 retention 可能永不清）
  - `createsession-fail-fast.test.ts` 全 mock `sessionManager`（L60-69）→ ingest/ensureRecord/DB 从不被触发 → 既有 test 结构上漏掉本 bug
- **为何 A1-HIGH-1 没堵住**：A1-HIGH-1（`realId === tempKey` throw）只挡住 `finalizeSessionStart` 这一条创建源，挡不住更早的 consume emit 链路（finally session-end / 30s error message）。
- **影响面**：每次 createSession 失败（SDK 鉴权失败 / 代理超限 / CLI 起不来 / stream 卡死）→ SessionList 多一条无法 resume 的幽灵 dormant；用户点它走 hard-fail recovery（jsonl 不在）。**确定性触发非概率**。
- **修法**：sdk-query catch + orchestrator catch（见 MED-F2）都补 `sessionRepo.delete(tempKey)`（events 子表 `ON DELETE CASCADE` 自动级联）。**只删 tempKey 不删 applicationSid/opts.resume** 的安全边界：spawn 路径孤儿 row id===tempKey（安全）；resume 路径 `opts.resume` 是预先存在的合法历史 row（绝不能删），且 resume 路径 fallback 用 `fallbackId=resumeId≠tempKey` → realId≠tempKey 永不进 A1-HIGH-1 throw。tempKey 是 randomUUID，删不存在的 row 是无害 no-op（DELETE 命中 0 行）。
- **回归 test**：`createsession-failure-cleanup.test.ts` non-resume fast-fail 断言 `sessionRepo.delete` 被调且 id 为 UUID 形态 + resume 路径断言绝不删 `OLD-ID`。**非空验证**：temp-revert sdk-query + orchestrator 双 catch 的 `sessionRepo.delete(tempKey)` → test fail（`expected "spy" to be called at least once`）。

---

### [MED] `create-session-impl.ts:60-204` — orchestrator prepare→finalize 整段无 try/catch，resolver 抛错漏清 cleanup（reviewer-claude + lead grep/diff 实测 ✅）

- **reviewer 来源**：reviewer-claude MED（单方）+ lead grep（0 try in impl）+ diff a21f258~1（非回归判定）（满足「单方 + 现场验证」→ ✅）。
- **问题**：orchestrator 全函数零 try/catch（仅 `runCreateSessionSdkQuery` 子模块内部 L73 自带 try）。prepare 段两个 resolver（`resolveClaudeSandboxMode` L133 / `resolveClaudeModel` L136）走 `sessionRepo.get`（better-sqlite3 同步 `.get()`，SQLITE_BUSY/corrupt 会抛）+ `settingsStore.get`，位置在 `runCreateSessionSdkQuery` 调用**之前**（子模块 try 外）。若 resolver 抛错 → 异常直冒 caller → `releasePending()`（L151）+ `releaseSdkClaim(opts.resume)`（仅子模块 catch 内）**都不执行**。
- **后果**：(a) `pendingSdkCwds` 卡 60s ttl → 同 cwd 真实外部 hook 会话被误吞（CHANGELOG_47 修过的同款 bug）；(b) resume 路径下 `opts.resume` 永留 `sdkOwned` → OLD_ID 后续 hook 事件永久静默丢弃（REVIEW_5 H4 修过的同款 leak）。
- **代码片段（修前，全函数无 try）**：
  ```ts
  const releasePending = sessionManager.expectSdkSession(opts.cwd);  // L70
  if (opts.resume) sessionManager.claimAsSdk(opts.resume);           // L82
  const claudeSandboxMode = resolveClaudeSandboxMode(opts);  // L133 ← 可抛
  const claudeModel = resolveClaudeModel(opts);              // L136 ← 可抛
  const { realId } = await runCreateSessionSdkQuery(...);    // L148 子模块才有 try
  releasePending();                                          // L151 ← 抛了到不了
  ```
- **验证手段**：① `grep -nE "try \{|catch" create-session-impl.ts` → 0（orchestrator 确无 try）；② 子模块 try 在 sdk-query L73；③ `sessionRepo.get = core-crud.ts getDb().prepare().get()` 同步可抛；④ **diff `a21f258~1`**：原单体 createSession 的 `expectSdkSession`(L273) + `claimAsSdk`(L285) + 两 resolver(L340/343) 全在 `try {`(L344) **之前** → 确认是被忠实搬运的既有潜伏 gap，**非本次拆分回归**；⑤ `create-session-impl.ts:69` 注释「整段 createSession 用 try/catch 包，catch 里清掉 sessions map 并 release」与实际结构矛盾（误导后续维护者）。
- **严重度判断**：触发概率低（app bootstrap 后 settingsStore/sessionRepo 抛错少见）+ 非回归 → MED 不上 HIGH。但漏清链结构上确定（已验证），命中 focus「资源 lifecycle / try-finally / 漏清理」。
- **修法**：orchestrator prepare→finalize 整段包 try/catch，catch 幂等清理 `releasePending()` + `releaseSdkClaim(opts.resume)` + `sessions.delete(tempKey)` + `sessionRepo.delete(tempKey)`（与 sdk-query 子模块 catch 同款，幂等 no-op-safe：sdk-query throw rethrow 后本 catch 再跑一遍无害 — `releasePending` 内部 expiresAt identity check / `releaseSdkClaim` Set.delete / `sessionRepo.delete` DELETE 命中 0 行）。同步修 L69 误导注释。
- **回归 test**：`createsession-failure-cleanup.test.ts` 让 `settingsStore.get('claudeCodeSandbox')` 抛 SQLITE_BUSY（驱动 resolver throw），断言 `releasePending` + `releaseSdkClaim('RESUME-F2')` 仍调。**非空验证**：temp-revert orchestrator catch 清理 → test fail。

---

### [MED] `create-session-sdk-query.ts:179` / `stream-processor.ts:454` — CLI realId claim 在自然 stream end 漏释放（reviewer-codex + lead 代码链实测 ✅）

- **reviewer 来源**：reviewer-codex MED（单方）+ lead 代码链 trace（满足「单方 + 现场验证」→ ✅）。
- **问题**：`runCreateSessionSdkQuery` 拿到 CLI `realId` 后无条件 `claimAsSdk(realId)`（L179）。resume fork / fresh-cli-reuse-app 路径下 `realId` 是 CLI sid 维度，`internal.applicationSid` 保持应用稳定 sid（反向 rename 不动 applicationSid）→ **realId !== applicationSid**。修前 consume `finally`（`stream-processor.ts:456`）只 `releaseSdkClaim(applicationSid)`，CLI sid 的 claim 永留 `#sdkOwned`。
- **后果**：SDK 流自然结束（`sdk-stream-ended`，不走 closeSession）后，后续同 CLI sid 的迟到 hook event 在 `dedupOrClaim` 第 2 分支 `source==='hook' && hasSdkClaim(sid)` 命中被静默丢弃，且 Set 条目泄漏到应用重启。三面 id 释放只存在于 `pending-cancellation.ts:113`（`runCloseSessionCleanup`），仅 `closeSession` 调用 — 自然 `sdk-stream-ended` 路径覆盖不到。
- **代码片段**：
  ```ts
  // create-session-sdk-query.ts:179
  sessionManager.claimAsSdk(realId);  // realId = CLI sid（fork 时 ≠ applicationSid）
  // stream-processor.ts finally（修前）
  const sid = internal.applicationSid;
  sessionManager.releaseSdkClaim(sid);  // ← 只释放 applicationSid，CLI sid 漏
  ```
- **验证手段**：`grep "claimAsSdk\(|releaseSdkClaim\(" sdk-bridge session` → create path `sdk-query:179` claim realId；自然 finally 仅 `stream-processor:456` release app sid；三面释放只在 `pending-cancellation:109-114`（由 `index.ts:379` closeSession 调）。`stream-processor.ts:365-375` 实证 resume fork 时只 `updateCliSessionId(applicationSid, realId)`，applicationSid 不变。
- **修法**：consume finally mirror `runCloseSessionCleanup` 三面释放语义 — `cliSessionId && cliSessionId !== sid && cliSessionId !== tempKey` 时额外 `releaseSdkClaim(cliSid)`。
- **回归 test**：`createsession-failure-cleanup.test.ts` resume fork（first id `CLI-FORK-ID` ≠ resume `APP-SID`）自然 endStream，断言 finally 释放 `APP-SID` + `CLI-FORK-ID` 两个 claim + spawn 主路径（realId===applicationSid）guard 跳过不重复释放。**非空验证**：temp-revert finally 的 CLI-sid 释放 → test fail（`['APP-SID']` 缺 `'CLI-FORK-ID'`）。

---

### INFO（5 条，全 ✅ fix）

1. **`create-session-impl.ts:69` 注释误导**（reviewer-claude）：「整段 createSession 用 try/catch 包」与实际 orchestrator 无 try 矛盾 → 随 MED-F2 修法重写注释（说明既有 gap + 幂等 catch 设计）。
2. **`session-finalize.ts:37/103-106` jsdoc 漂移**（reviewer-claude + lead 实测）：jsdoc 称「仅 spawn 主路径调 / resume 不调」，但 `create-session-impl.ts:178` 是 `if (opts.resumeMode !== 'fresh-cli-reuse-app')` → **normal resume 也满足**（`recover-and-send-impl.ts:302` 不传 resumeMode → 默认 `'resume-cli'` → finalize 被调，带 `skipFirstUserEmit=true`）。改为「spawn 主路径 + normal resume 调；仅 fresh-cli-reuse-app 跳过」。
3. **`types.ts:215` 残留字段名 `realSessionId`**（reviewer-claude）：makeInternalSession jsdoc 引用的 `realSessionId` 已在 R7 HIGH-R7-1 重命名为 `applicationSid` / `cliSessionId` 双轨 → 改写为双阶段描述。
4. **`mcp-server-init.ts:46` 死参 `_tempKey`**（reviewer-claude + lead pre-read）：`buildMcpServersForSession(internal, _tempKey)` 第二参从不使用（R4 HIGH-H 后 lazy provider 改用 `() => internal.applicationSid`）→ 删该参 + caller（`create-session-sdk-query.ts:97`）实参精简。
5. **`constants.ts:46` 字面占位符 `CHANGELOG_<X>`**（lead pre-read）：read-only-tools shared 抽取的 changelog 占位符未填 → 实证 CHANGELOG_56 落地，改为 `CHANGELOG_56`。

> **同款残留（C1 scope 外，留对应批次）**：`can-use-tool.ts:43`「internal.realSessionId 还没拿到」同款 realSessionId 残留（C4 scope）；`core-crud.ts:199` 同款 `CHANGELOG_<X>` 占位符（Batch G store scope）。reviewer-claude 已 adjacent flag，留对应批次一并修（避免跨 scope 改动污染本批 diff）。

## 未发现新问题的维度

`query-options-builder.ts`（pure builder，sandbox/model/resume 字段拼装与原 inline 字节级一致）/ `model-resolve.ts` + `sandbox-resolve.ts`（fallback 链正确）/ `_deps.ts`（纯 type SSOT）/ `effectiveResumeCliSid` 三分支 guard（sdk-query L107-110 不 short-circuit）/ catch 双 key delete（REVIEW_60 R2 HIGH-1 保留）/ A1-HIGH-1 realId===tempKey throw（保留）/ index.ts setPermissionMode chain 串行化（R3 fix-3 保留）/ MAX_MESSAGE_LENGTH 与 messageRepo 对齐 — 本轮均未发现新问题。

## 验证

- typecheck 双配置（tsconfig.node.json + tsconfig.web.json）✅
- sdk-bridge 全套 **72 passed**（10 test files，+5 新回归 test）✅
- 广域回归 session + adapters **308 passed / 1 skipped**（32 test files）✅
- 3 真问题 fix 全部 temp-revert 非空验证（F1 双 catch revert → spy 未调 fail / F2 orchestrator catch revert → releaseSpy 未调 fail / F3 finally CLI-sid revert → CLI-FORK-ID 缺失 fail）✅
- 单文件 ≤500 LOC 护栏：impl 236 / sdk-query 245 / stream-processor 474 / 新 test 286 全部达标 ✅
