# REVIEW_81 — 全项目 deep review 批 D3：codex-cli sdk-bridge recoverer（断连自愈）

- 日期: 2026-05-31
- 类型: Debug / 功能 BUG + 代码优化（全项目 deep review 第十一批，Batch D 子批 D3）
- 触发: 用户「deep review 下项目，自主一路推进 + 自主 hand off」授权（plan deep-review-project-20260531）
- 关联: plan deep-review-project-20260531 / REVIEW_79-80（D1/D2）/ **REVIEW_76（C2 claude recoverer，本批 MED-1 的对称源）**
- 方法: 多轮异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5，复用 D pair dr-project-d-20260531）+ 三态裁决 + lead 全链 trace（emit→bootstrap-infra 共享 ingest thunk→manager.ts:251 ensure closed→active 复活；claude jsonl-fallback emit 顺序 parity）+ **temp-revert 复现验证**。
- 收口: R1 双 reviewer reply。**MED-1 双方独立共识 + lead pre-traced**（reviewer-claude 定 HIGH / reviewer-codex 定 MED / lead 裁 MED 对齐 C2 严重度）：closed 会话复活 dead-active 幽灵无回滚 — C2 claude MED-1 / REVIEW_76 的 codex 对称缺口未跟修。**MED-2 单方（reviewer-codex）+ lead claude parity 验证**：jsonl-missing fallback info emit 在 createSession 之前 → 失败时时间线矛盾。**LOW（reviewer-claude）**：jsonl startedAt 时区跨午夜 ±1day 边界（递归扫已兜底，不修）。0 真 HIGH（MED-1 lead 裁 MED）。typecheck 双配置 + codex-cli 140 passed（+5 回归 test，2 MED temp-revert 各验证非空）。

## 范围（批 D3）

codex-cli SDK adapter bridge 的「断连自愈 / 恢复路径」子模块（与 claude recoverer 对称，C2 已审 claude 侧），6 文件 ~974 LOC：

| 文件 | LOC | 职责 |
|---|---|---|
| `sdk-bridge/recoverer.ts` | 159 | SessionRecoverer facade（recoverAndSend thin delegate + findFallbackCwd protected + re-export） |
| `sdk-bridge/recoverer/recover-and-send-impl.ts` | 337 | recoverAndSend 主体（inflight 单飞 + cwd fallback + jsonl 预检 + resume/fresh + emit placeholder） |
| `sdk-bridge/recoverer/jsonl-discovery.ts` | 126 | codex ~/.codex/sessions/<date>/*-<threadId>.jsonl 探测（±1day + 递归扫兜底）+ cwdExists |
| `sdk-bridge/recoverer/_deps.ts` | 119 | RecovererCtx + 4 thunk type + PLACEHOLDER_DEDUP_MS |
| `sdk-bridge/codex-recoverer-messages.ts` | 88 | recoverer 用户可见 message 文案 builder（3 个纯函数） |
| `sdk-bridge/codex-jsonl-fallback.ts` | 145 | jsonl 缺失 fallback（fresh-cli-reuse-app + emit info） |

## 三态裁决结果

### [MED ✅ reviewer-claude + reviewer-codex 双方独立共识 + lead 全链 trace] recover-and-send-impl.ts:127 — closed 会话被入口 emit user message 复活成 active，恢复失败两路径不回滚 → dead-active 幽灵（C2 claude MED-1 / REVIEW_76 的 codex 对称缺口）

两 reviewer 独立指向同一弱点（reviewer-claude 全链 trace + reviewer-codex 同款 + lead pre-traced）。与 C2 claude `recover-and-send-impl.ts:131` **完全同构的 bug，codex 侧没跟修**。recoverAndSend 入口先 emit user message（line 127-138，`role:'user'` + `source:'sdk'`，REVIEW_58 把它提前到 cwd precheck 之前保 user bubble），但 codex 全程**只读 `rec.archivedAt`（line 205 unarchive）从不读 `rec.lifecycle`**。closed 会话走这条 emit → ingest → ensure 复活成 active，两条失败路径都不回滚。

```ts
deps.ctx.emit({ sessionId, agentId: AGENT_ID, kind: 'message',
  payload: { text, role: 'user', ... }, ts: Date.now(), source: 'sdk' });  // ← closed→active 复活点
// ... cwd precheck:
  if (fallback === null) {
    deps.ctx.emit({ ...payload: { text: buildCodexCwdMissingErrorText(rec.cwd), error: true } });
    throw new Error(`session ${sessionId} cwd does not exist ...`);  // ← 复活后 throw 不回滚
  }
```

**lead 全链 trace（与 C2 同款，codex 侧逐环确认）**：
1. **共享 emit→ingest sink**：bootstrap-infra.ts:127-129 `emit: (event) => { sessionManager.ingest(event); ... }` 是**两 adapter 共用**同一 thunk（codex adapter index.ts `new CodexSdkBridge({emit: ctx.emit})` 拿的就是它）→ codex emit 与 claude emit 进同一条 ingest ✅
2. **ensure 复活**：manager.ts:251-259 `if (existing.lifecycle === 'closed') { upsert lifecycle:'active' + emit session-upserted }`（dormant 走 manager-ingest-pipeline.ts:230 short-circuit **不**复活，仅 closed 触发）✅
3. **不回滚**：grep recover-and-send-impl.ts 全文 `wasClosed|markClosed|lifecycle` → 修前 **0 命中**（仅 line 205 `rec.archivedAt`）；两条失败路径（cwd 全 miss line 163 throw / createSession reject outer catch line 322 rethrow）都在复活之后无回滚 ✅
4. **黑名单兜不住**（C2 反驳轮关键确证，codex 同样适用）：scheduler `markClosedImpl`（lifecycle.ts:96）只 setLifecycle 不写 recentlyDeleted → scheduler-closed 的 codex 会话发消息时黑名单必 miss → emit 必达 ensure 必复活 ✅
5. **archived/closed 防护不对称**（设计疏漏强信号）：同函数对 archived 有显式对称防护（line 148-151 cwd-miss 时**故意不 unarchive** + 注释自述），但 closed 复活发生在更早的 line 127 → archived 防了、closed 没防，与 claude 修前一模一样 ✅
6. **temp-revert 复现**：移除两条 markClosed → closed+cwd-miss / closed+createSession-reject 两 case FAIL（markClosed not called），dormant+fail / closed+success 两边界 case 仍 PASS（精确 guard）✅

**严重度裁决 — MED**（reviewer-claude 提 HIGH，理由「codex 无 hook 通道 recoverAndSend 是 dormant 唤醒主路径触发面更大」；reviewer-codex 提 MED）：lead 裁 **MED 对齐 C2 严重度**。理由：触发需 closed（非 dormant）+ 恢复失败（cwd 全删 / createSession reject）双条件叠加频率低；后果 UX 幽灵（dead-active 卡片）非数据损坏 / 安全；scheduler 最终自愈（active→dormant→closed）user-visible 窗口存在但非永久。codex 触发面更大提升的是**概率非影响** → 与 C2 MED 同档。**必修无争议**。

**修法**（直接套 C2 claude 修法）：入口 line 94 `const rec` 后捕获 `const wasClosed = rec.lifecycle === 'closed'`（emit 复活前读）+ 两条失败路径 `if (wasClosed) sessionManager.markClosed(sessionId)` 回滚。用 `markClosed`（manager.ts:349 已暴露，guard 接受 active→closed）不用 raw setLifecycle（REVIEW_56 第四入口反模式 — 绕过 clear marker + leave team + UI emit）。outer catch 的 error message emit（`source:'sdk'`）在 record 已 active 时过 ingest 走 manager.ts:261 `return existing` 不再复活 → markClosed 放 error emit 之后安全（与 C2 同款顺序坑结论）。

### [MED ✅ reviewer-codex 单方 + lead claude parity 验证] codex-jsonl-fallback.ts:108 — jsonl-missing fallback info 在 createSession 成功前 emit，失败时时间线自相矛盾

reviewer-codex 单方提出（reviewer-claude 未覆盖此 emit 顺序角度）。jsonl 缺失时 helper 先 emit「本会话续聊从 fresh thread 开始（历史保留）」info，**再** `await ctx.createSession(...)`。当 createSession 后续抛错时，用户先看到 fallback 已开始 / 历史已丢的提示，随后又看到 recoverer outer catch 的「⚠ 自动恢复失败」error → 时间线自相矛盾。

```ts
// 修前
ctx.emit({ ...payload: { text: buildCodexJsonlMissingNoSummaryText() } });  // ← info 早于 createSession
await ctx.createSession({ resume: opts.sessionId, resumeMode: 'fresh-cli-reuse-app', ... });
```

**lead claude parity 验证**：读 claude jsonl-fallback.ts → info message emit 在 **step ③（line 277），`createSession`（step ②，line 243）之后**。所以 claude createSession throw 时 info 永不 emit，用户只看到 outer catch error（干净时间线）。codex 是 cross-adapter drift ✅。**temp-revert 复现**：emit 移回 createSession 之前 → jsonl-fallback-fail timeline test FAIL（fallbackInfo length 1 应为 0）✅。

**修法**：把 `ctx.emit(buildCodexJsonlMissingNoSummaryText())` 移到 `await ctx.createSession(...)` **成功之后**（与 claude step ③ 同款）。createSession throw 时本 emit 不执行 → rethrow 给 recoverer outer catch 只 emit 一条 error，时间线干净。`logger.warn`（诊断日志非用户可见）保留在 createSession 之前不动。

### [LOW ❓ reviewer-claude，不改代码] jsonl-discovery.ts:45 — `new Date(startedAt)` 本地时区拆 YYYY/MM/DD，跨午夜可能错 1 天

reviewer-claude 自评「可不修（递归扫已兜底）」。`new Date(startedAt)`（应用 emit session-start 的 Date.now()）拆本地日期目录，codex CLI 写 jsonl 用进程侧写盘时刻日期，两者通常差几秒；若 startedAt 落 23:59:5x、codex 写盘跨次日则 fast-path 当天 miss。

**lead 裁决 ❓ 不改代码**：±1day（`[0,-1,1]`）+ REVIEW_56 §F2 递归扫兜底（line 61）已覆盖此边角 — 跨午夜 1 天必落 ±1day 窗口内必命中；worst case 多走一次递归扫（spike1 实测 <1ms）不影响正确性。理论边界已被现有兜底消化 → LOW 不修。

## 修复清单

| # | 文件:行 | 严重度 | 修法 | 验证 |
|---|---|---|---|---|
| 1 | recover-and-send-impl.ts:94/181/359 | MED ✅ | `wasClosed` 捕获 + 两失败路径 markClosed 回滚 | 双方独立共识 + lead 全链 trace（共享 ingest + ensure 复活 + 黑名单兜不住 + archived 对称疏漏）+ temp-revert 复现 |
| 2 | codex-jsonl-fallback.ts:108→126 后 | MED ✅ | info emit 移到 createSession 成功之后（对齐 claude step ③） | reviewer-codex 单方 + lead claude parity 读 + temp-revert 复现 |
| — | jsonl-discovery.ts:45 | LOW ❓ | 递归扫已兜底，不改代码 | reviewer-claude 自评可不修 |

## 验证

```
typecheck（双配置 tsconfig.node + tsconfig.web）：PASS
node_modules/.bin/vitest run src/main/adapters/codex-cli：12 files / 140 passed（135 既有 + 5 新）
MED temp-revert：移除 2 markClosed + jsonl emit 移回 createSession 前 → 3 test FAIL
  （closed+cwd-miss markClosed not called / closed+reject markClosed not called /
   jsonl-fail fallbackInfo length 1≠0），2 边界 case（dormant+fail / closed+success）仍 PASS
  → 确定性复现 + 证 guard 精确
```

## 结论

D3。codex recoverer 子系统的单飞（recovering Map 共享 set 早于 await）+ jsonl 探测维度（cli sid）+ ±1day + 递归扫兜底 + cwd fallback 启发式 + fresh-cli-reuse-app + 反向 rename 黑名单链都扎实。**「永不抛错」契约 C2 claude 侧 MED-2（listEventsFn 在 try 外）在 codex 不存在对应风险**（codex 无 LLM 摘要 prepend，不调 listEventsFn/summariseFn — reviewer-claude 确认不适用）。两个真问题都是 cross-adapter parity 缺口：MED-1 closed-revival 是 C2 claude 已修的 codex 对称漏修（双方独立 + lead trace + temp-revert）；MED-2 jsonl-fallback emit 顺序 drift（reviewer-codex 单方 + lead parity 验证）。LOW 时区边界已被递归扫兜底不修。

## Follow-up（无新增；D2 的 2 条仍 open）

D2 follow-up（claude restart-controller parity MED + translate 双 finished 未验证）仍待用户决策，本批无新增。

> 下一子批 D4：codex-binary + codex-instance-pool + index/handoff-runner/summarizer-runner/sdk-loader/codex-config-paths（binary path resolution REVIEW_69+70 win32 复查 / instance pool lifecycle / adapter 入口）。**Batch D 收官批**。
