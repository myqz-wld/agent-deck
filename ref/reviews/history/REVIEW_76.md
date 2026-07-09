# REVIEW_76 — 全项目 deep review 批 C2：claude-code sdk-bridge recoverer（断连自愈/恢复路径）

- 日期: 2026-05-31
- 类型: Debug / 功能 BUG + 代码优化 + 文字措辞（全项目 deep review 第六批，Batch C 子批 C2）
- 触发: 用户「deep review 下项目，自主一路推进 + 自主 hand off」授权（plan deep-review-project-20260531）
- 关联: plan deep-review-project-20260531 / REVIEW_71-75（A1/A2/B1/B2/C1）
- 方法: 多轮异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5，team dr-project-c-20260531，复用 C1 pair）+ **反驳轮**（codex MED-1 → claude 独立验证）+ 三态裁决 + lead 全链 trace（emit→ingest→ensure / listEventsFn→eventRepo→JSON.parse）。
- 收口: R1 双 reviewer reply（codex 2 MED；claude 0 HIGH/0 MED/3 INFO，结论「子系统功能正确、拆分忠实」）→ **divergence 处理**：claude 未覆盖 codex 的失败边界角度（互补盲点非反驳）→ 对 MED-1 跑反驳轮 → claude ✅ 同意 + 补关键确证（黑名单不对称）→ 三态裁决 2 MED + 1 INFO fix（2 INFO 接受 by-design）。typecheck 双配置 + claude adapter 137 passed（+5 回归 test，2 MED fix temp-revert 非空验证）。

## 范围（批 C2）

claude-code SDK adapter bridge 的断连自愈/恢复子系统，6 文件 ~1230 LOC：

| 文件 | LOC | 职责 |
|---|---|---|
| `sdk-bridge/recoverer.ts` | 211 | SessionRecoverer facade（class shell + ctor 7 thunk + emitFallbackMessage + findFallbackCwd） |
| `sdk-bridge/recoverer-helpers.ts` | 190 | `prependHistorySummary`（fallback 前 LLM 摘要 prepend，6 步算法 + 5 failReason） |
| `sdk-bridge/recoverer-messages.ts` | 174 | 8 个 emit 文案 pure builder（cwd-miss / cwd-fallback / jsonl-missing / restart 各 used/skipped） |
| `sdk-bridge/recoverer/_deps.ts` | 226 | SSOT types（RecovererCtx + 6 thunk type + RecoverAndSendDeps bundle） |
| `sdk-bridge/recoverer/recover-and-send-impl.ts` | 366 | recoverAndSend free fn 主体（inflight 单飞 / cwd fallback / IIFE / jsonl fallback / resume / outer catch） |
| `sdk-bridge/recoverer/jsonl-discovery.ts` | 63 | `defaultResumeJsonlExists` / `defaultCwdExists`（fs 探测 + fail-safe 退化） |

## 结论

**3 finding fix（2 MED ✅ + 1 INFO ✅）+ 2 INFO 接受 by-design**。

### ⚠️ 异构对抗 divergence 处理（本批关键）

两 reviewer 结论分歧：
- **reviewer-codex**：2 MED（recovery 失败前的事件入库副作用 + jsonl fallback 摘要 helper 异常边界）
- **reviewer-claude**：0 HIGH/0 MED/3 INFO，结论「recoverer 子系统功能正确、Step 4.4 拆分忠实」（diff a21f258~1 字节级一致）

**分歧本质**：claude focus 在拆分忠实性 + 单飞 invariant + recovering Map 共享（这些它逐一验证「正确」），**未examine** codex 取的「失败边界副作用」角度 = **互补盲点，非反驳**。按 §三态裁决，codex 2 MED 是单方 → lead 已全链 trace 验证（满足「单方 + 现场验证」→ ✅）。但因 claude 明确下了「正确」结论，对更高影响的 MED-1 **跑反驳轮**：claude 独立验证后 **✅ 同意是真问题**，并补一条 codex 没点出的**关键确证**（黑名单不对称，见下），把「可被 recentlyDeleted 兜住」的反驳空间堵死。

---

### [MED] `recover-and-send-impl.ts:131` — recovery 失败前的 user emit 把 closed 会话复活成 active 不回滚（dead-active 幽灵）（reviewer-codex + reviewer-claude 反驳轮 ✅ + lead 全链 trace）

- **reviewer 来源**：reviewer-codex MED（单方）→ 反驳轮 reviewer-claude ✅ 独立同意 + 补关键确证 → 实质双方共识。lead 全链 trace + mitigation 分析。
- **问题**：recoverAndSend 在 cwd/jsonl/createSession 任何恢复动作**之前**先 `deps.ctx.emit({kind:'message', role:'user', source:'sdk'})`（L131，REVIEW_58 HIGH 把 emit 提前到 cwd precheck 之前以保 user bubble 不丢）。生产 emit 同步 → `sessionManager.ingest` → `ensureRecord` → `ensure`（manager.ts:251）：`if existing.lifecycle === 'closed'` → upsert `lifecycle:'active'` + emit session-upserted（**复活**）。随后两条失败路径都不回滚：① cwd 全 miss → L165 throw；② createSession reject → outer catch rethrow。recoverAndSend 全程不读/不存 `rec.lifecycle`（仅 archivedAt 在 IIFE 内 unarchive）。结果：closed 会话被复活成 active 但无 SDK live session = **dead-active 幽灵**（SessionList 实时面板一条点了发不出消息的死会话）。
- **代码片段（修前 cwd-miss throw 路径）**：
  ```ts
  deps.emitFallbackMessageThunk(sessionId, buildCwdMissingErrorText(rec.cwd), { error: true });
  throw new Error(`session ${sessionId} cwd does not exist and no fallback available: ${rec.cwd}`);
  // ← closed 已被 L131 emit 复活成 active，此处 throw 前不回滚
  ```
- **验证手段（lead 全链 trace）**：
  - `bootstrap-infra.ts:127-129` 生产 emit → `sessionManager.ingest`
  - `dedupOrClaim`（manager-ingest-pipeline.ts:86-159）**所有** skip 分支 gate 在 `source==='hook'` 或 team-* kind → `source:'sdk'` message 全不命中 → `ensureRecord`
  - `ensure`（manager.ts:251-259）closed → upsert active；dormant 走 L261 `return existing` **不复活**（仅 closed 触发）
  - `advanceState`（manager-ingest-pipeline.ts:230）closed/archived short-circuit 是对 **ensure 已复活后**的 active record 判定 → 不 short-circuit → 维持 active（无即时 mitigation）
  - lifecycle scheduler 仅时间衰减（active→dormant→closed）→ dead-active **最终自愈但 user-visible 窗口存在**（非永久）
- **reviewer-claude 反驳轮关键确证（codex 未覆盖）**：两条 close 路径**黑名单状态不对称**，堵死「recentlyDeleted 兜住」的反驳——`markRecentlyDeleted` 唯一调用点是 `pending-cancellation.ts:121`（= `closeSession`→`runCloseSessionCleanup`）；`markClosedImpl`（scheduler dormant→closed）**只** setLifecycle 不调 markRecentlyDeleted（其 jsdoc 自述）。黑名单 TTL=60s ≪ `closeAfterMs` → **scheduler-closed 会话发消息时 recentlyDeleted 必 miss** → L131 emit 必达 ensure 必复活。
- **archived/closed 防护不对称（设计疏漏强信号）**：同函数对 archived 显式对称防护（L160-167 cwd-miss 时**故意不 unarchive**，注释自述「之前 unarchive 在前 → throw 后变 active 但死路」），但 closed 复活发生在更早的 L131 → archived 防了、closed 没防（REVIEW_58 把 emit 提前与 ensure closed-revive 交叠产生的缝）。
- **严重度判断**：触发需 closed（非 dormant）+ 恢复失败（cwd 全删 / createSession reject）双条件叠加，频率低；后果是 UX 幽灵（dead-active 卡片）非数据损坏/安全，且 scheduler 最终自愈 → MED 不上 HIGH。但链路确定、有 archived 对称疏漏佐证、无测试兜底 → 真问题。
- **修法**：`wasClosed = rec.lifecycle === 'closed'` 入口捕获（L131 emit 复活前读）+ 两条失败路径 `if (wasClosed) sessionManager.markClosed(sessionId)` 回滚。**用 markClosed 而非 raw setLifecycle**：REVIEW_56 明确 raw setLifecycle 绕过 markClosed 是「第四入口」反模式（漏 clear cwd_release_marker + leave team membership + UI emit）；且 lead 实测 `sessionRepo.setLifecycle` **不 emit session-upserted**（注释自述「再让上层 emit」）→ raw 改法 UI 不更新残留 active 卡片。markClosed 内聚三副作用 + emit session-upserted 让 UI 自洽。guard `active→closed` 通过（复活后是 active），team-leave 幂等（首次 closed 已 left）。**reviewer-claude 反驳轮补的 outer-catch 顺序坑**：error message emit（source:'sdk'）再过 ingest，但此刻 record 已 active → ensure L261 return existing **不再复活** → markClosed 放 error emit 之后安全。
- **回归 test**：`sdk-bridge.recovery.test.ts` 新增 4 case（closed+cwd-miss → markClosed 调 / closed+createSession-reject → outer catch markClosed 调 / dormant+失败 → 不调 markClosed 边界 / closed+成功 → 不调 markClosed 边界）。**非空验证**：temp-revert 两条 markClosed 回滚 → 2 真问题 case fail（dormant + success 边界 case 仍 pass，证明 guard 精确）。

---

### [MED] `recoverer-helpers.ts:156` — `listEventsFn` 抛错阻断 fresh fallback，违反「永不抛错」契约（reviewer-codex + lead 代码链实测 ✅）

- **reviewer 来源**：reviewer-codex MED（单方）+ lead 代码链实测（满足「单方 + 现场验证」→ ✅）。
- **问题**：`prependHistorySummary` jsdoc + §不变量明确承诺「任何失败封装为 PrependResult 让 caller fall back to originalText 启动 fresh CLI 不阻塞」。但 `listEventsFn(sessionId)`（L156）在 try/catch **之外**（仅 `summariseFn` L163 在 try 内）。生产 thunk = `eventRepo.listForSession`（index.ts:286-287），其内部 `rows.map(rowToEvent)` 走 `JSON.parse(r.payload_json)`（event-repo.ts:21）→ 历史 row payload_json 损坏 / DB 读错时同步抛错 → 穿透 prependHistorySummary → `maybeJsonlFallback` 在 createSession **之前**中断 → recoverer 只 emit「⚠ 自动恢复失败」**不进 fresh CLI reuse-app fallback**（本该能续聊的会话彻底起不来）。
- **代码片段（修前）**：
  ```ts
  const events = listEventsFn(sessionId);  // ← try 外，throw 穿透破坏「永不抛错」契约
  if (!events || events.length === 0) {
    return { prompt: originalText, used: false, failReason: 'no-events' };
  }
  let summary: string | null;
  try { summary = await summariseFn(cwd, events); } catch (err) { /* 仅 summariseFn 受保护 */ }
  ```
- **验证手段**：`grep "listEventsFn\(|thunk-throw|try \{" recoverer-helpers.ts` 显示只有 summariseFn 在 try 内；`event-repo.ts:15-22 rowToEvent` 确含 `JSON.parse(r.payload_json)`（损坏 payload 同步抛）；现有 test 只覆盖 summariseFn throw（sdk-bridge.recovery.test.ts）+ listEventsFn 返回数组/空数组（jsonl-fallback.test.ts），**无 listEventsFn throw case**。
- **修法**：`listEventsFn` 调用纳入 try/catch，复用 `thunk-throw` failReason（caller 已处理：emit CHANGELOG_106「请补背景」+ 继续 fresh CLI fallback 用 originalText），与 summariseFn 同款保护。同步更新 `thunk-throw` failReason jsdoc（覆盖 listEventsFn + summariseFn 双来源）。
- **回归 test**：`jsonl-fallback.test.ts` 新增 case（`listEventsFnThrow` → `maybeJsonlFallback` 不抛 + fellBack=true + createSession 仍调 + 用 originalText 未被摘要 prepend）。**非空验证**：temp-revert try/catch 回 bare call → test fail（throw 穿透 maybeJsonlFallback reject）。

---

### [INFO] `recover-and-send-impl.ts:296-301 + 371-374` — resume-fork 注释描述 renameSdkSession + newRealId 与 reverse-rename 设计矛盾（reviewer-claude + lead grep 确认 ✅）

- **问题**：两处注释声称「resume 路径下 createThunk 仍可能返回不同 sessionId（CLI 隐式 fork: stream-processor.consume **L245** 触发 **renameSdkSession**）… fork 时 === newRealId」。但 reverse-rename-sid-stability §S6 落地后 resume-fork 走 `updateCliSessionId`（**不是** renameSdkSession，applicationSid 冻结），故 createSessionImpl resume 路径**恒**返回 `applicationSid === opts.resume`。注释描述的是 reverse-rename **之前**的行为 + 行号也漂（L245 实为 waitForRealSessionId 传参，真正 fork-detect 在 L365）。
- **验证手段**：`renameSdkSession` 唯一会被调用处 stream-processor.ts:338 仅 `isNewSpawn` 分支（`isNewSpawn = !resumeId && resumeMode !== 'fresh-cli-reuse-app'`，L325）；resume 路径 resumeId 非空 → isNewSpawn=false → L365 → L375 `updateCliSessionId`（不动 sessions.id）。
- **影响**：纯注释 + 行号漂移，`return handle.sessionId` 代码本身正确（恒 === sessionId）。风险：维护者读错误注释会基于错误 mental model 改代码。
- **修法**：改注释为「resume 路径 applicationSid 冻结，handle.sessionId 恒 === sessionId；CLI 隐式 fork 仅改 cli_session_id 列（updateCliSessionId）不 rename」+ L245→L365 + 删「fork 时 === newRealId」误导句。保留 handle.sessionId 写法注明是「防御性正确（自动跟随 createSessionImpl resume 语义）」。

---

## 接受 by-design（reviewer-claude INFO，不改）

- **[INFO] `placeholderEmittedAt` 过期清理 opportunistic**（reviewer-claude）：sweep loop 只在 dedup gate 通过分支跑，某 sessionId 触发一次 placeholder 后再不恢复且全局无新 recovery → entry 驻留。**接受**：不致错误行为（下次该 sid 恢复必 `>5s` 放行）；上界 = 历史「断连过一次且之后无恢复」distinct session 数；任意新 recovery sweep 所有过期 entry（self-healing）；注释已自述「顺手清掉过期 entry 避免 Map 无限涨」。INFO 不上 LOW，ROI 低（closeSession 清理需新增 thunk 跨 facade 层）。
- **[INFO] inflight 等待者路径不在 recoverAndSend 层做长度上限检查**（reviewer-claude）：长度校验在 L105（inflight check L70 之后），inflight 等待者跳过 → 先 await inflight（最长 30s）再由下游 `validateSendMessageOrThrow` 校验 throw。**接受**：功能正确（cap 不被绕过，下游强制 102_400），仅 UX 暴露时机不对称（罕见路径：并发同 session 连发 + 第二条超长 → 白等一次 recovery 才报错）。无安全/正确性问题。

## 未发现新问题的维度（reviewer-claude 全部验证通过）

单飞 invariant（L70 get → L345 set 之间零 await，IIFE 内部 await 不在 set 前让出 → 2 并发同 sid 第二条必命中 inflight 不双 createThunk，REVIEW_60 MED-codex-1 修法完好）/ restart-controller 共享 recovering Map（捕获 Promise 引用，rename Map key 不影响已捕获 await；双方 resolve 均 string 类型一致）/ jsonl 预检用 cliSessionId ?? sessionId（cli sid 维度对齐）/ findFallbackCwd 安全边界（home/祖先/`/` 拒绝 + 32 次 walk 上界）/ Step 4.4 拆分忠实（diff a21f258~1 字节级一致）。

## 验证

- typecheck 双配置（tsconfig.node.json + tsconfig.web.json）✅
- claude adapter 全套 **137 passed**（15 test files，+5 新回归 test：4 MED-1 closed 回滚 + 1 MED-2 listEventsFn throw）✅
- 2 MED fix temp-revert 非空验证（MED-1 双 markClosed revert → 2 真问题 case fail + 2 边界 case 仍 pass / MED-2 try/catch revert → maybeJsonlFallback reject fail）✅
- 单文件 ≤500 LOC 护栏：recover-and-send-impl 修后仍 < 420 LOC，达标 ✅
