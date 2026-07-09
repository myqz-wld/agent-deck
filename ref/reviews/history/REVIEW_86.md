# REVIEW_86 — 全项目 deep review 批 F2：send + universal-message-watcher dispatch 子系统

- 日期: 2026-05-31
- 类型: Debug / 功能 BUG + 代码优化 + 文字措辞（全项目 deep review 第十六批，Batch F 子批 F2）
- 触发: 用户「deep review 下项目，自主一路推进 + 自主 hand off」授权（plan deep-review-project-20260531）
- 关联: plan deep-review-project-20260531 / REVIEW_35（backpressure 死锁 + 饿死 + dispatcher preseed）/ REVIEW_56（cross-target 二阶段公平 + deliver 5 项 invariant 重验）/ REVIEW_61（retryAfterFail 单条 UPDATE）/ CHANGELOG_100（删 reply_message/wait_reply + 双锚点 wire format）/ CHANGELOG_105（watcher 拆分）
- 方法: 多轮异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5，复用 F pair dr-project-f-20260531）+ **反驳轮**（starvation MED 单方 → 对方独立验证）+ 三态裁决 + lead 现场 Grep/Read 验证 + node 状态机模拟 + 全 fix temp-revert 非空。
- 收口: R1 单轮 **异构 divergence** + 1 反驳轮。双方各 0 HIGH。两条 finding **双方独立**（token-before-insert / stale doc）→ ✅ 自动确认；其余单方独有走 lead 验证 / 反驳轮。starvation MED 经反驳轮 codex 独立确认 + 扩大窗口 → ✅。

## 范围（批 F2）

send_message handler + universal-message-watcher dispatch 引擎 5 文件 ~857 LOC：

| 文件 | LOC | 职责 |
|---|---|---|
| `teams/universal-message-watcher/index.ts` | 449 | UniversalMessageWatcher 主类（poll/event + claim + deliver 5 项 invariant 重验 + backpressure + buildWireBody）|
| `teams/universal-message-watcher/team-event-dispatcher.ts` | 157 | member join/leave/archive fan-out + lastArchivedAt transition detect |
| `agent-deck-mcp/tools/handlers/send.ts` | 126 | MCP send_message handler（teamId resolve + replyToMessageId cross-team 防污染）|
| `teams/universal-message-watcher/enqueue.ts` | 68 | caller-facing 入队 API（rate limit + insert）|
| `teams/universal-message-watcher/rate-limiter.ts` | 57 | PerKeyRateLimiter（per-teamId 滑动窗口）|

## 三态裁决结果

### [MED ✅ reviewer-codex 单方 + lead grep 验证] index.ts:264 — claim 后非 adapter 异常把消息永久卡 delivering

reviewer-codex 单方。`deliver()` 先 `claim` 把行置 `delivering`，但 claim 后的 invariant 重验（sessionRepo.get / agentDeckTeamRepo.get / findActiveMembershipIn）+ buildWireBody **在 adapter try/catch 之外**。任一同步抛错（SQLITE_BUSY / I/O）冒到 `process()` 外层 catch 只 warn，不 retryAfterFail / 不 markFailed → 行永久 `delivering`，而 `findEligible()` 只扫 `pending` → 运行期不再重投，只有下次 `start()` 的 `resetDeliveringOnStartup()` 能救（需重启）。

**lead 验证（grep）**：`claim` (state-machine.ts:33) 写 `status='delivering'`；`findEligible` (dispatch.ts:33,66) `WHERE status='pending'`；`process()` catch (index.ts:251) 只 warn；旧 retryAfterFail 只包 adapter call (index.ts:413+)。

**修法**：把整段 post-claim（invariant 重验 + buildWireBody + adapter call）抽到 `dispatchClaimed()`，`deliver()` 用 outer try 包住调用，catch → `retryAfterFail`（退避重投，到 MAX_RETRY 自动 failed）。invariant 违规路径（markFailed + return）是 by-design 终止态，return 正常退出 try 不进 catch，行为不变；adapter call 内层 try/catch 保留。+1 回归 test（teamGetThrow 模拟 invariant DB 抛错 → 断言 retryAfterFail 被调；temp-revert 拆回裸调 → test FAIL）。

### [MED ✅ reviewer-codex 单方 + lead grep 验证（ipc/teams.ts，Batch I scope，enqueue 契约 enforcement gap）] ipc/teams.ts:257 — IPC send 对 archived team 返 queued ok 随后 watcher 必 fail

reviewer-codex 单方。`enqueue.ts:37-38` 注释明确「archived team 由 caller 拒」，但 IPC send 只用 `listActiveMembers(teamId)` 校验 membership——该 SQL（member-query.ts:50-52）只 JOIN sessions 过滤 `s.archived_at`，**不** JOIN `agent_deck_teams` 不看 `team.archived_at`；team archive 不清 member row，故 archived team 仍能通过 IPC 入队 → watcher claim 后在 `team.archivedAt != null` 处 markFailed → caller 先拿 queued ok 随后异步失败（误导）。

**lead 验证（Read）**：member-query.ts:50-52 SQL 未 JOIN agent_deck_teams；ipc/teams.ts:258 仅 listActiveMembers + body 非空；MCP send.ts:39-50 有 closed/archived 前置拒绝（IPC 缺）。

**修法**：IPC send 在 membership 校验前 `agentDeckTeamRepo.get(teamId)`，不存在 / `archivedAt !== null` 直接 `IpcInputError`（与 MCP send.ts 对齐）；并加 target session lifecycle='closed' 前置拒绝（listActiveMembers 过滤 archived session 但不查 closed）。**scope 说明**：`ipc/teams.ts` 属 Batch I，但本 MED 是 F2 enqueue 契约的 caller-side enforcement gap，趁 context 热修（小 + 防御 + 镜像 MCP）。**测试盲区**：IPC teams send 路径无既有 test（仅 issues/sessions IPC 有 test），本修法未加 test（follow-up）。

### [MED ✅ reviewer-claude 单方 + lead node 模拟 + 反驳轮 codex 独立确认+扩大] index.ts:206 — starvation guard 用全局 deliveredAny，over-cap target 被其他 target 流量饿死

reviewer-claude 单方（明确请求反驳轮）。`deliveredAny` 是**跨所有 target 的全局标志**。over-cap target X（pending 12-15）每 candidate `otherInflight = count-1 > maxInflight` 全 skip，但 under-cap target Y deliver 置 `deliveredAny=true` → L245 starvation guard（`!deliveredAny` 才救）被 Y 掩盖跳过；L256 cross-target 二阶段仅在 `candidates.length >= BATCH_LIMIT` 且救 batch **外** target（X 已在 batch 内救不到）。X 每 tick drain 0 无限饿死，DB 中 X 消息既不 failed 也不 delivered。

**反驳轮（reviewer-codex 独立验证）**：**同意** + 扩大窗口——X=15/Y=1（batch=16）二阶段 query 排除 batch targets（X/Y 都在内）仍救不到 X；X≥16 也只被旧 guard/fair drain 到 15 后停。只要 Y 持续 trickle，X 停在 12-15 不动。codex 给出 per-target rescue 安全设计（保留 REVIEW_35 `count-1` + REVIEW_56 二阶段）。

**lead 验证（node 状态机模拟）**：X=12+Y=1 单 tick 推演——12 X 全 skip（other=11>10），Y deliver 置 deliveredAny → guard 跳过 → 二阶段（13≥16 false）跳过 → X drain 0。持续 over-cap 则永饿。

**修法**：主 loop 记录 `firstSkippedByTarget`（每个 over-cap target 的 head FIFO）+ `deliveredTargets`（本 tick 有 deliver 的 target）；loop 后对每个被 skip 且**本 tick 零进展**的 over-cap target 强制 deliver head 一条。取代旧全局 deliveredAny guard（per-target 视角严格更强）。保留 REVIEW_35 `count-1`（防同 target 死锁）+ REVIEW_56 cross-target 二阶段（救 batch 外 target）。+1 回归 test（X 持续补到 13 over-cap + Y trickle → 断言 X 每 tick deliver ≥1；temp-revert 旧全局 guard → X drain 0 test FAIL）。

### [LOW ✅ reviewer-claude + reviewer-codex 双方独立] enqueue.ts:48 — rate token 在 insert 前消耗，insert 抛错时 token 泄漏

**双方独立**（codex LOW-1 + claude LOW）→ ✅ 自动确认（异构强冗余）。`tryConsume` 先扣 token 再 `messageRepo.insert`，但 insert 仍对 self-message(from==to) / 空 body / body>MAX_BODY_LENGTH 抛 MessageInvariantError（crud.ts:32-44）。MCP send.ts 入口已挡，但 IPC teams.ts:254 仅校验 body 非空（不挡 from==to / 不挡超长）→ 非法 IPC 输入 insert 抛错时 token 已扣但无 message 入队，污染该 team 60/min 配额（60s 自愈）。

**修法**：在 tryConsume 前做与 insert 同款 cheap validation（self / 空 / 超长，不写库），非法输入直接抛 → token 未扣。**不改 tryConsume↔insert 顺序**（保持 rate-limited 时不 insert 的 backpressure 语义，避免「先插后扣」留 orphan pending 行被 watcher 误投——lead 评估时先尝试 reorder 发现此 regression 风险后改 cheap-validation 方案）。insert 内仍有同款 check 作 SSOT 双层防御（DB CHECK 第三层）。+4 回归 test（dedicated enqueue.test.ts；self/空/超长不烧 token；temp-revert 顺序 → 3 test FAIL）。

### [LOW ✅ reviewer-claude 单方 + lead grep] rate-limiter.ts:17 — PerKeyRateLimiter.buckets Map 无界增长

reviewer-claude 单方。`buckets` 按 teamId 分桶，无 eviction——bucket 裁剪到空后 entry 仍保留，`reset()` 仅测试调。长运行实例中每个 send 过的 team（含 archived）留常驻 entry。对比同文件 dispatcher.lastArchivedAt 至少 stop() 时 clear()。

**lead 验证（grep）**：grep messageRateLimiter 全仓仅 enqueue.ts 调用 + 测试 reset，无生产 eviction。bounded by team 总数（每桶 ≤60 number），影响小但架构泄漏。

**修法**：加 `sweepEmptyBuckets(now)` 删全部 timestamp 出窗的桶 + watcher.start() 起独立 60s 低频 sweep timer（unref + stop() clearInterval）+ `bucketCount` getter（observability/测试）。+2 回归 test（bucketCount 断言 stale 桶删 / active 桶留；temp-revert no-op → 2 test FAIL）。

### [LOW ✅ reviewer-codex 单方 + lead grep] universal-message-watcher.test.ts:503 — invariant-2/3 单测没打到 from-session 分支

reviewer-codex 单方。`sessionRepo.get` mock 对所有 id 返回同一 `nextSessionResult`。`invariant-2` 设 null → 实际在 target lookup 就 fail，没走到「from session not found」；`invariant-3` 设 archived → 在 target archived 分支就 fail，没走到「from session archived」。两测只证明「有 markFailed」，不防 from-session 分支回归（且不断言 reason）。

**lead 验证（Read）**：对照 index.ts:289-331 执行顺序（target lookup/archived 在 from lookup 前）；test 503-531 无断言 reason。

**修法**：加 `sessionByIdMap` per-sid overlay 让 target active 通过、from null/archived → 真打到 from-session 分支 + 断言 reason `from session not found` / `from session archived`。temp-revert 把 from 分支改 wrong reason → test FAIL（证明现在真打到该分支）。

### [INFO ✅ reviewer-claude + reviewer-codex 双方独立] index.ts:22 — 模块头 wire format 文档过时

**双方独立**（codex INFO + claude INFO）。头部 jsdoc 写单锚点 `[from ...][msg ...]` + 引导 teammate 调已删 `reply_message`/`wait_reply`。实际 buildWireBody (L115) 产双锚点 `[msg ...][sid ...]`，协议已统一 send_message + replyToMessageId（同文件 deliver J fix 注释自证）。**修法**：更新头部 §4.4 为双锚点 regex + send_message reply 路径，删 reply_message/wait_reply 引用。

### [INFO/未验证 ❓ reviewer-claude] index.ts:264 — deliver() adapter 调用无超时阻塞单飞 processing

reviewer-claude *未验证*。`process()` 持 processing=true 串行 `await deliver()`，adapter call 无超时；正常路径快（bridge.sendMessage 仅 push 数组即 return），但 sessions Map miss 走 recoverAndSend（waitForRealSessionId 30s）→ 最坏单个 dead channel 停摆全引擎约 30s。reviewer 自标 *未验证*（recoverAndSend 多段 await 难精确 bound，正常负载不触发）。**裁决：❓ follow-up**（非 HIGH，未实证 >30s 可达；加 Promise.race 超时是合理加固但需实测先）。

## 修复清单

| # | 文件:行 | 严重度 | 修法 | 验证 |
|---|---|---|---|---|
| 1 | index.ts deliver/dispatchClaimed | MED ✅ | post-claim 抽 dispatchClaimed + outer try → retryAfterFail | codex 单方 + lead grep + 1 test temp-revert FAIL |
| 2 | ipc/teams.ts:257 | MED ✅ | team get + archivedAt + closed 前置拒绝（镜像 MCP send.ts）| codex 单方 + lead Read SQL + 无 test（follow-up）|
| 3 | index.ts:206 process backpressure | MED ✅ | per-target rescue 取代全局 deliveredAny guard | claude 单方 + 反驳轮 codex 确认+扩大 + lead node 模拟 + 1 test temp-revert FAIL |
| 4 | enqueue.ts:48 | LOW ✅ | cheap pre-validation 前置 tryConsume（self/空/超长）| 双方独立 + 4 test temp-revert 3 FAIL |
| 5 | rate-limiter.ts | LOW ✅ | sweepEmptyBuckets + 60s sweep timer + bucketCount getter | claude 单方 + lead grep + 2 test temp-revert FAIL |
| 6 | watcher.test.ts invariant-2/3 | LOW ✅ | per-sid overlay 真打 from-session 分支 + 断言 reason | codex 单方 + lead Read + temp-revert wrong-reason FAIL |
| — | index.ts:22 注释 | INFO ✅ | 双锚点 wire format + send_message reply 路径 | 双方独立，doc-only |

## 验证

```
typecheck（双配置 tsconfig.node + tsconfig.web）：PASS
node_modules/.bin/vitest run teams/ + agent-deck-mcp/__tests__/：620 passed | 3 skipped（39 files）
node_modules/.bin/vitest run ipc/：53 passed（MED-2 touched ipc/teams.ts，无 teams IPC test 但 issues/sessions 不回归）
新增回归 test：watcher.test.ts +3（MED-1 post-claim throw 1 + starvation 1 + sweep 2 = 实际 4）+ enqueue.test.ts +4（token validation）= 8 test + invariant-2/3 加固
temp-revert 全验证非空：
  MED-1 → 拆回裸 dispatchClaimed → post-claim throw test FAIL（throw 未捕获）
  MED-3 starvation → 旧全局 deliveredAny guard → X drain 0 test FAIL
  LOW token → validation 移到 tryConsume 后 → 3 enqueue test FAIL（token 烧）
  LOW sweep → sweepEmptyBuckets no-op → 2 bucketCount test FAIL
  LOW-2 → from 分支改 wrong reason → invariant-2 test FAIL（证真打到分支）
```

## 结论

**Batch F2**。universal-message-watcher 是 scope 内最 subtle 的并发代码（poll/event 单飞 + claim 原子抢占 + 5 项 deliver invariant 重验 + 两层 backpressure 死锁/饿死防御），经 REVIEW_35/56/61 多轮加固。本轮双方各 0 HIGH，挖出 3 MED + 3 LOW + 1 INFO + 1 unverified follow-up。

**异构对抗价值**：
- **双方独立** 2 条（token-before-insert / stale doc）→ 异构强冗余直接确认。
- **互补盲点**：reviewer-codex 抓 claim→delivering stuck（dispatch 状态机维度）+ IPC archived-team enqueue（caller-side 契约 enforcement）+ test 分支盲区；reviewer-claude 抓 starvation 全局 deliveredAny（liveness 维度，REVIEW_35/56 残留�narrow window）+ rate-limiter Map 泄漏（资源 lifecycle）。
- **反驳轮收敛**：starvation MED 单方 + claude 主动请求反驳 → codex 独立验证不仅认同还**扩大窗口**（X=15/X≥16 也命中）+ 给出保 REVIEW_35/56 的安全 per-target rescue 设计。这是反驳轮最佳形态——不是简单 yes/no，而是深化理解 + 修法落地。

共性主题：**claim/enqueue 后的异常 / backpressure 路径处理不彻底**——MED-1 看 claim 后 throw 卡死，MED-3 看 backpressure skip 后 liveness，LOW token 看 insert throw 后配额，三者殊途同归。

## Follow-up（留用户回来决策）

1. **[INFO/未验证] deliver() adapter 调用无超时**（reviewer-claude）——sessions Map miss 走 recoverAndSend(30s) 最坏停摆全引擎；加 Promise.race 超时是合理加固但需先实证 >30s 可达性。
2. **[测试盲区] IPC teams send 路径无 test**（lead）——MED-2 修法 + 整个 AgentDeckTeamSendMessage handler 无单测覆盖；建议补 IPC teams handler test（archived team / closed session / membership 拒绝矩阵）。
