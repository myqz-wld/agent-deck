# REVIEW_84 — 全项目 deep review 批 E2：调度器 + 总结器子系统（Batch E 收官）

- 日期: 2026-05-31
- 类型: Debug / 功能 BUG + 代码优化 + 文字措辞（全项目 deep review 第十四批，Batch E 子批 E2，**Batch E 收官**）
- 触发: 用户「deep review 下项目，自主一路推进 + 自主 hand off」授权（plan deep-review-project-20260531）
- 关联: plan deep-review-project-20260531 / REVIEW_83（E1 manager 核心）/ REVIEW_35（summarizer rename race / orphan diagnostics）/ REVIEW_56（lifecycle-scheduler purge fix-to-fix）/ REVIEW_82（codex oneshot timeout，D4 已审 codex-runner/race-with-timeout）
- 方法: 多轮异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5，复用 E pair dr-project-e-20260531）+ 三态裁决 + lead 现场验证（node repro 同毫秒逆序 + grep 对照 LIMIT 不对称 + 0 caller 确认）+ 真 SQLite temp-revert（node20 rebuild 临时跑后还原 Electron binding）。
- 收口: R1→R2 两轮。R1 **异构 divergence 互补盲点**（claude 2 LOW store/summarizer 架构 / codex 1 LOW event 排序）；R2 双方验证 3 fix + 共识 conclude。0 残留 HIGH/MED/LOW。

## 范围（批 E2）

调度器 + 总结器子系统 9 文件 ~1100 LOC + 连带 issue-repo.ts listForGc：

| 文件 | LOC | 职责 |
|---|---|---|
| `session/lifecycle-scheduler.ts` | 156 | active→dormant→closed 时间衰减 + 历史 purge（批量事务 + applyClosedSideEffects fire-and-forget）|
| `store/issue-lifecycle-scheduler.ts` | 113 | issue GC tick（listForGc → 逐条 snapshot+hardDelete+emit）|
| `session/summarizer/index.ts` | 311 | 三层降级总结调度 + inFlight/maxConcurrent + rename handler 迁移 |
| `session/summarizer/llm-runners.ts` | 114 | claude summarize / handoff oneshot runner（thin delegate）|
| `session/summarizer/event-formatter.ts` | 110 | events → LLM prompt 活动文本 + localStatsFallback |
| `session/oneshot-llm/index.ts` | 35 | oneshot runner facade re-export |
| `session/oneshot-llm/claude-runner.ts` | 118 | claude SDK oneshot query + consume + race |
| `session/oneshot-llm/build-prompt.ts` | 116 | summarize/handoff prompt 模板 + systemPrompt 常量 |
| `session/oneshot-llm/clean-result.ts` | 51 | compact/structured 双清洗策略 |

> **skip**（已审）：`oneshot-llm/codex-runner.ts` + `race-with-timeout.ts` — D4/REVIEW_82 刚审（codex timeout AbortController fix）。
> **连带修改**（出 E2 文件清单）：`issue-repo.ts` listForGc（reviewer-claude LOW-1 落点；issue-lifecycle-scheduler 的 DB 实现，REVIEW_70 descoped 主体外的单点 LIMIT 补齐）。

## 三态裁决结果（R1 异构 divergence — 互补盲点）

### [LOW ✅ reviewer-codex 单方 + lead node repro] event-formatter.ts:18 — 同毫秒事件在摘要 prompt 内逆序

reviewer-codex 单方提出（reviewer-claude R1 未覆盖同毫秒维度，R2 独立验证认同）。`eventRepo.listForSession`（event-repo.ts:112）返回 `ORDER BY ts DESC, id DESC`，同毫秒内 id 更大（更新）的 row 排前；`formatEventsForPrompt` 旧版仅 `sort((a,b) => a.ts - b.ts)`，JS sort 稳定 → 同 ts 保留输入顺序（id DESC = 新→旧）→ 同毫秒事件在 prompt 里**逆序**，违背本函数 jsdoc「按发生顺序读 LLM 才能正确理解前后逻辑」契约。SDK 连续 emit 多条 event 同毫秒是现实路径，handoff 简报读到局部反序步骤。

```ts
// event-formatter.ts:18（修前）
const ordered = [...events].sort((a, b) => a.ts - b.ts).slice(-30);
```

**lead 验证（node repro）**：传入 `[id=3 ts=1000, id=2 ts=1000, id=1 ts=1000]`（模拟 listForSession id DESC 输出）→ 修前输出 `third → second → first`（逆序），修后 `first → second → third`（chronological）。`events.id` 是 INTEGER AUTOINCREMENT 单调（v001），`listForSession` 返回类型 `AgentEvent & { id: number }` 带此列。

**修法**：tie-breaker `(a.ts - b.ts) || ((a.id ?? 0) - (b.id ?? 0))` 还原同毫秒 chronological（id 升序=旧→新）；入参类型放宽 `(AgentEvent & { id?: number })[]`（`?? 0` 兜底假想无 id caller，所有真实 caller 走 listForSession 带 id）。+4 纯函数回归 test（event-formatter.test.ts；temp-revert 同毫秒 test FAIL 验证非空）。reviewer-claude R2 独立验证 id 单调性链路 + tie-breaker 正确性 ✅。

### [LOW ✅ reviewer-claude 单方 + lead grep 对照] issue-repo.ts listForGc — 无 LIMIT 上限，与 findHistoryOlderThan 基线不对称

reviewer-claude 单方提出（reviewer-codex R1 未深入 store 层 LIMIT 对称性）。`IssueLifecycleScheduler.scan()` 是 sync 主线程逐条 hardDelete+emit，但 `issueRepo.listForGc` 两条 SQL **无 LIMIT**（全量返回超期 id）。对照**同款** `LifecycleScheduler.findHistoryOlderThan(threshold, limit=500)`（session-repo/lifecycle.ts:97）有 500 上限 + jsdoc「每轮最多 500 条剩余下轮继续，避免一次扫描删上万行卡死主线程」。issue-scheduler 缺这层保护。

**lead 验证**：grep 确认 listForGc 两条 SQL 无 LIMIT vs findHistoryOlderThan 有 limit=500；issue retention 默认 resolved=90/soft=7（defaults.ts:42-43，>0 即 GC active）。

**可达性 LOW**：issue 是 agent 低频上报（量级远小于 session events，现实难达「上万行」）。但两 latent 场景可触发批量：① retention 0→非 0 首次启用 GC 历史一次性全删 ② 长期 high-volume 上报后批量过期。一次同步删 N 千行 + N 千次 emit 卡主线程。架构一致性缺失 + latent 非 live。

**修法**：listForGc 加 `limit?: number` default 500（与 findHistoryOlderThan 对称）+ 两路 SQL `LIMIT ?`；scheduler scan() 不传走默认 500，剩余下轮 6h tick 续。+1 真 SQLite 回归 test（temp-revert `expected length 3 got 7`）。reviewer-claude R2 算过续删节奏（N=10000 需 20 tick×6h≈5 天清完，但每 6h 删 ≤1000 不卡线程是核心收益，GC 不紧急可接受）。

### [LOW ✅ reviewer-claude 单方 + lead grep 0 caller] summarizer/index.ts:221 — summarizeNow 不走 inFlight 守门（latent，0 caller）

reviewer-claude 单方提出。`summarizeNow`（手动触发）直接调 `summarize()`，不 `inFlight.add`/不检查 `inFlight.has`。若与 `scanAll` 并发跑同 sid → 两条 LLM oneshot 并发同 session → 双 insert summary + race `lastSummarizedAt.set`。

**lead 验证**：grep `summarizeNow` 全局 caller **0 命中**（IPC/其它模块无调用点）→ 当前不可达 dead code 风险面。但保留的 public method 一旦未来接 IPC「手动总结」按钮，并发 race 激活。

**修法**：`summarizeNow` 加 `if (inFlight.has(sid)) return null` + add + try/finally delete（与 scanAll line 134 同款语义）。reviewer-claude R2 验证「rename 期间 inFlight 不迁移」自洽：finally delete 用入参 OLD sid 闭包与 add 同 key → 不滞留不漏删；唯一副作用 rename 后 NEW sid 可能被 scanAll 看到启第二条，但 0 caller + summarizeNow 短命单次窗口极小 → 可接受。

### [INFO] R1/R2 验证记录（无 action）

- **reviewer-claude INFO**：summarizer setIntervalMs `if (!this.timer) return` 守卫不可达（bootstrap start 早于 IPC handler 挂载）= 防御性写法正确。
- **reviewer-claude INFO**：前序治理点复核全过（before-quit 四停接线 / summarizer rename race 无注册窗口 / inFlight per-promise 迁移 REVIEW_56 MED-2 / issue-scheduler 单条 try/catch + snapshot + race / event-formatter slice(-30) + clean-result 双策略 + build-prompt role 防混淆）。
- **reviewer-codex INFO**：lifecycle/issue-scheduler/summarizer/oneshot-llm 主路径无阻塞问题（purge 排除 updatedClosedIds / snapshot→hardDelete→emit / rename map 迁移 + per-promise inFlight cleanup / claude oneshot result break + q.interrupt + 模型链 + 清洗语义）。
- **reviewer-codex INFO**（follow-up）：hand-off.test.ts:165 claude oneshot timeout 用例是占位断言（`expect(true).toBe(true)`），生产路径由代码结构保障但缺单测回归网。非 E2 scope（hand-off.test 是既有 test），记 follow-up。

## 修复清单

| # | 文件:行 | 严重度 | 修法 | 验证 |
|---|---|---|---|---|
| 1 | event-formatter.ts:25 | LOW ✅ | sort 加 id tie-breaker `\|\| (a.id??0)-(b.id??0)` + 入参类型放宽 | codex 单方 + lead node repro + 4 纯函数 test temp-revert 非空 |
| 2 | issue-repo.ts:407 listForGc | LOW ✅ | 加 `limit?:number` default 500 + 两路 SQL LIMIT（对称 findHistoryOlderThan）| claude 单方 + lead grep + 真 SQLite test temp-revert `length 3 got 7` |
| 3 | summarizer/index.ts:230 | LOW ✅ | summarizeNow 加 inFlight 守门 + try/finally | claude 单方 + lead grep 0 caller + R2 rename 自洽验证 |

## 验证

```
typecheck（双配置）：PASS
node_modules/.bin/vitest run src/main/session（默认 node）：8 files / 64 passed（+event-formatter 4）
node20 rebuild 临时跑（issue-repo + issue-scheduler + lifecycle-scheduler + event-formatter）：63 passed
  → 跑完已还原 Electron ABI 130 binding（byte-identical 备份）
LOW-1 temp-revert：移除 id tie-breaker → 同毫秒 test FAIL（idxFirst<idxSecond<idxThird 不成立）
LOW-2 temp-revert：移除 LIMIT → limit test FAIL（expected length 3 got 7）
LOW-3：grep 0 caller + R2 rename 自洽（finally OLD sid 闭包不滞留）
```

## 结论

**Batch E 收官批**。调度器（lifecycle/issue 时间衰减 + 批量事务 + fire-and-forget race + purge 排除）+ 总结器（三层降级 + inFlight/maxConcurrent + rename 迁移 + FK 预检）+ oneshot-llm（consume 循环 + race + 模型链 + 清洗）扎实，0 HIGH/0 MED。本轮挖出 3 LOW，全 latent 但都现场验证为值得修（event-formatter 真 correctness 违背函数契约 / listForGc cheap symmetric 防主线程 block / summarizeNow defensive 防未来 IPC footgun）。

**异构对抗价值**：R1 互补盲点典型——reviewer-codex 抓 event 排序 tie-breaker（同毫秒维度，reviewer-claude 未覆盖），reviewer-claude 抓 store LIMIT 对称性 + summarizer 守门（架构一致性维度，reviewer-codex 未深入）。R2 双方交叉验证对方 finding 的 fix 全部正确。

**Batch E 全收官**：E1（manager 核心，REVIEW_83，1 HIGH + 2 MED）+ E2（调度器+总结器，REVIEW_84，3 LOW）= 全 17 文件 / **1 HIGH + 2 MED + 3 LOW = 6 fix** + 10 回归 test（manager-ingest 4 + rename 2 + event-formatter 4 — 注：issue-repo LIMIT 1 + summarizeNow 守门经验证未单独加 test 因 0 caller）+ session 子系统全链路覆盖（ingest 5 段 / lifecycle 状态机 / rename 跨表迁移 / 调度器衰减 / 总结三层降级）。

## Follow-up（留用户回来决策）

1. **[INFO 跨批] agent-deck-team-repo.test.ts 3 个 pre-existing 失败**（team CRUD unique / list 分页 / findSharedActiveTeams）——REVIEW_83 已记，baseline 即 fail，留 Batch G（store repos）专项排查。
2. **[INFO 测试盲区] hand-off.test.ts:165 claude oneshot timeout 占位断言**（reviewer-codex E2）——`expect(true).toBe(true)` 假覆盖，建议给 runClaudeOneshot/raceWithTimeout 加 fake-timer 单测（async iterable 永不 yield，断言 reject message + interrupt spy）。非 bug，测试网补强。
3. **[LOW 可选优化] issue GC 续删节奏**（reviewer-claude E2）——6h tick × 500 对「用户调短 retention 想快速清积压」偏慢；GC 非紧急可不动，若需可加首次缩短 tick。

> Batch E ✅ 全收官（E1+E2 / REVIEW_83-84 / 6 fix）。下一批 Batch F（spawn/send/task + dispatch：agent-deck-mcp/tools/handlers/* + teams/universal-message-watcher/*）/ G（store repos，含 team-repo 3 pre-existing 失败排查）/ H（renderer+文案）/ I（剩余可跳）。
