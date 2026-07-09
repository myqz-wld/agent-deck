# REVIEW_101 — codex-cli sdk-bridge 断连恢复 / 重启 / 回滚时序链 deep-review（R1+R2 双轮异构对抗收口）

> 关联 commits：`3511d96`（R1 合并修法：codex restart 接入 maybeCodexJsonlFallback + cancel-guard + model）/ `f9dbb0c`（R2 强化：baseline 移位 + 注释订正）
> 性质：滚动「全项目 deep review」Batch 3（debug/加固 —— 无新功能引入，归 reviews）
> follow-up issue：`30ca35a9`（codex recover 重建丢 reviewer spawn-time network/dirs defaults，recover-only MED）
> follow-up（注释标注，未落 issue，建议合并 parity 收尾）：codex restart fallback handoffPrompt 不显示 user bubble + claude restart 缺 cancel-guard + INFO-1/2/3（facade re-export 不全 / DB 同值双写 / IIFE finally 理论窗口）

## 背景与诉求

用户「deep review 全项目，BUG 排查 + 代码优化」滚动任务，自主推进 + 自主 hand off。Batch 1（resume-history，REVIEW_99）+ Batch 2（teamless-dm + universal-message-watcher，REVIEW_100）收口后，按 churn / file-level-review-expiry 重算下一最大未审面 = **codex-cli sdk-bridge 断连恢复 / 重启 / 回滚时序链**：

scope（10 文件 1911 LOC，全 repo root 内无 sandbox cp）：
- `recoverer/recover-and-send-impl.ts`(465) / `recoverer/_deps.ts`(169) / `recoverer/jsonl-discovery.ts`(126) / `recoverer.ts`(184 facade) — **9/10 精确路径未审**
- `restart-controller.ts`(201) / `resume-path-await.ts`(194) / `codex-jsonl-fallback.ts`(255) / `codex-recoverer-messages.ts`(106) / `session-finalize.ts`(112) / `create-session-rollback.ts`(99)

**选批依据**：Phase4 facade 拆分后子模块新路径不继承旧路径已审状态（按 expiry SOP 当未审处理）+ 最近 churn 活跃（recover-and-send-impl=5 / codex-jsonl-fallback=4 / codex-binary=3 commits in last 60）。是 Batch 1（resume-history claude 侧 + 共享层）的**姊妹盲区**：codex 侧断连自愈 / 重启 / 回滚时序链从未单独 deep-review。排除项：archive-plan / hand-off 族昨天 REVIEW_96 brace-展开写法 `{handler-main,cwd-resolver,team-adopt-coordinator}.ts` 已覆盖（expiry 脚本 `^src/` grep 抓不到 brace = 假阴性，人工甄别 churn=0 跳过）；issue UI 三件套 REVIEW_93/95 才 1 天前 churn≈0 跳过。

## 方法

`agent-deck:deep-review` SKILL，R1+R2 双轮异构对抗 + 反驳轮：
- **reviewer-claude**（claude-code adapter，Opus 4.7）sid `2eccd1df`
- **reviewer-codex**（codex-cli adapter，gpt-5.5 xhigh）sid `019e8520`
- teamId `ffda4055-0488-49e1-922c-5a613807f516`
- lead（本会话）三态裁决 + 现场验证（全 scope 文件独立通读建 mental model + 读码 trace adapter closeSession 不 bump epoch + grep 验证 claude restart 同缺 cancel-guard + migrations 搜证 network/dirs 未持久化）

## 轮次概览

| 轮 | reviewer-claude | reviewer-codex | lead 裁决 |
|---|---|---|---|
| R1 | 0 HIGH / 1 MED（restart 缺 jsonl 预检+fallback）/ 3 INFO | 1 HIGH（restart 缺 cancel-guard）/ 2 MED（restart 丢 model / recover+restart 丢 network+dirs）| 双方命中**同一文件 restart-controller 不同侧面**；现场验证全部技术事实成立；HIGH 走反驳轮 |
| 反驳轮 | confirm race 真实（更宽触发面：scheduler 衰减 + shutdown_session）+ **反对 HIGH→降 MED**（claude restart 同缺，pre-existing 共缺非 codex-only）+ acknowledge R1 漏审（升级 mental model 三维穷举）+ 强烈建议合并修法 | 同意 jsonl MED + 同意合并修法 + 同意 MED-2 收窄 recover-only | **双方收敛共识**：cancel-guard 降 MED + 三 MED 合并修法 |
| R2 | 0 HIGH / 0 真 MED「同意 conclude+可合」+ A 四点全过 + B 同意 follow-up + 2 INFO 强化（INFO-A baseline 时机 / INFO-B 注释措辞）| 0 finding「同意 conclude+可合」+ 认可 trace 修正 + 认可已知差异 follow-up | **双方 both-agree conclude**，INFO-A/B 采纳 |

## 三态裁决明细

### ✅ 真问题（合并修法，commit 3511d96）— codex restart-controller 没迁移 claude/recover 的对称能力

异构对抗高光：两个 reviewer 从不同角度命中**同一薄弱点**（codex restart-controller 没迁移 claude restart / recover 已有的对称能力）：

**[原 HIGH → 降 MED, 双方反驳轮共识] restart 缺 cancel-guard（close-during-restart 复活幽灵）**
- reviewer-codex R1 标 HIGH。问题：`restartWithCodexSandbox` close OLD → createSession({resume}) 起新 SDK，但不捕获 closeEpoch baseline、不传 cancelCheck。用户在 createSession await 窗口内 close → `sessionManager.close` 置 closed + bump epoch，但 restart 继续 emit session-start(source:'sdk') → ensure closed→active 复活幽灵（与 recover 路径 REVIEW_99 R3 修的同款 race）。
- **反驳轮双方共识降 MED**：reviewer-claude 现场验证 **claude restart-controller 也不传 cancelCheck**（grep `cancelCheck|closeEpoch|getCloseEpoch|cancelGuard|isCancelledFn` RC=1 零命中）→ cancel-epoch 是 **recover 路径专属**，两端 restart pre-existing 共缺，**非 codex-only regression**。降级三理由：① 非 codex-only（claude 同缺，定 HIGH 误导「codex 拆分搞坏」）② 窗口秒级（recover 是 injectResumeHistory LLM oneshot 10-30s，restart 是 codex resumeThread spawn）③ 可自愈非永久（下条消息走 recoverer 有 guard / 下个 scheduler tick 衰减）。
- **reviewer-claude 更宽触发面**：不只用户手动 close——lifecycle-scheduler.ts:103 衰减 dormant→closed 也 bump epoch + setLifecycle（用户什么都不做撞 scheduler tick）+ MCP shutdown_session（lead 关 teammate reviewer 常用）。
- **lead 增量裁决（trace 修正 reviewer-codex 理由偏差）**：reviewer-codex 反驳轮说「restart 自己 closeSession 会 bump epoch 故 baseline 必须在 close 之后捕获」。lead 现场 trace：codex **adapter 层** closeSession（index.ts:425-472）只 abort turn + sessions.delete + releaseSdkClaim，**不** bump epoch（只 sessionManager.close/markClosed/delete 才 bump，lifecycle.ts:107/150/331）。restart 调 `ctx.closeSession` = adapter closeSession（index.ts:169 thunk）不 bump → baseline 在 close 前后捕获**值等价**。reviewer-codex「之后捕获」结论安全但理由不准；reviewer-codex R2 认可此 trace 修正。

**[MED ✅, reviewer-claude] restart 缺 jsonl 预检+fallback（jsonl-missing 切档失败）**
- claude RestartController 冷切 sandbox 先调 `maybeJsonlFallback`（jsonl 在→正常 resume；jsonl 缺→fresh-cli-reuse-app + 历史注入 → 切档成功）。codex `restartWithCodexSandbox` **完全无** jsonl 处理：close OLD → 写 DB → 直接 createSession({resume}) → create-session-impl.ts:111 resumeMode 默认走 resumeThread → jsonl 缺失（用户清 ~/.codex/sessions / 跨设备同步未带）时 codex CLI resume earlyErr → 回滚旧档 = 切档失败。
- lead 现场验证：codex restart-controller jsonl 命中 **0**；codex RestartCtx **缺** `jsonlExistsThunk/summariseFn/listEventsFn/listMessagesFn` 4 thunk（claude RestartCtx 有）；jsonl-precheck plan 只在 claude 端落地，codex restart 漏迁。缓解：非永久卡死，失败后用户「重发消息」→ recoverer（有 jsonl fallback）→ 重建 → 再切档成功 = 可自愈 → MED。

**[MED ✅, reviewer-codex] restart 丢 model（切档后退回默认模型）**
- recover 路径显式传 `model: rec.model ?? undefined`（recover-and-send-impl.ts:406 / codex-jsonl-fallback.ts:216），restart 冷切只传 codexSandbox。create-session-impl.ts:131 仅 opts.model 非 undefined 才放进 ThreadOptions（model **无** sessionRepo fallback，不同于 sandbox 有 persistedSandbox）→ 带自定义 model 的 session 切 sandbox 后 DB/UI 仍显示原 model 但新 SDK thread 按全局默认 model 跑。

**合并修法**（reviewer 双方共识：三 MED 同根「codex restart 没迁移对称能力」，一次性补齐）：
- RestartCtx 补 4 thunk（jsonlExistsThunk/summariseFn/listEventsFn/listMessagesFn），facade index.ts 注入（与 recoverer 共享同份 instance）
- RestartCreateOpts 补 resumeMode/model/extraAllowWrite/cancelCheck
- `restartWithCodexSandbox` 重构：捕获 closeEpochBaseline + 构造 cancelGuard → 调 maybeCodexJsonlFallback（传 isCancelledFn + model）→ aborted special-case / fellBack 直接 return / fall-through direct createSession（传 model + cancelCheck）→ outer catch special-case RecoveryCancelledError（不回滚 / 不 emit 切档失败）
- 3 回归测试（consume-fork.test.ts，restart 路径修前 0 覆盖）：close-during-restart abort / model 透传 / jsonl-missing fallback 切档成功；getCloseEpoch mock 补齐

### ✅ R2 INFO 强化采纳（commit f9dbb0c）

**[INFO-A, reviewer-claude] baseline 捕获时机移到 `await ctx.closeSession` 之前**
- adapter close 不 bump epoch 故值等价，但 `await closeSession` 让出 microtask；用户 `sessionManager.close`（不查 recovering Map 单飞挡不住）若正好在该窗口跑完 bump+setClosed，baseline 放「close 之后」会把这次 close 算进基线漏判。移「之前」连 closeSession 让出的 microtask 窗口内 close 都被 cancelGuard 后续检查捕获（baseline < 新 epoch → abort），与 recover 路径「baseline 捕获前全同步无 await」语义一致。残留固有 TOCTOU（baseline 捕获瞬间到首检查点）是 cancellation-epoch 全路径共有边界，recover 同样不覆盖。

**[INFO-B, reviewer-claude] fall-through 注释措辞订正**
- jsonl 在时**控制流**与修前 direct createSession 等价，但 model 透传是本次 fix 的**故意行为变更**（修前丢 model），非字面等价。仅 rec.model 为 null 时才与修前等价。纯文档精度订正。

### 已知差异（注释标注，留 follow-up，双方 R2 同意不阻塞合并）

**codex restart fallback handoffPrompt 不显示 user bubble**
- codex `maybeCodexJsonlFallback` 硬编码 `skipFirstUserEmit: true`（codex-jsonl-fallback.ts:221，假设 recover 路径 entry 已 emit user message），且 codex helper **不**像 claude helper（jsonl-fallback.ts:384）那样在 `!skipFirstUserEmit` 时自 emit role='user'。restart 路径无 entry emit → fallback 分支下 handoffPrompt 不显示为 user bubble（仅 emit fallback info）。
- **双方 R2 独立判定影响有限留 follow-up**：① fallback 仅 jsonl 缺失（罕见）触发 ② handoffPrompt 是系统冷切提示语（reviewer-claude 现场验证 ComposerSdk.tsx 硬编码 `'继续之前的会话'` 非用户珍贵输入）③ 修前此场景整个切档失败=净改善。彻底对齐需 codex helper 加 emitContext（'recover'|'restart'）+ restart 分支自 emit user（claude 模式），改动面铺到 helper 接口 + 影响 recover 既有调用点 = 风险/收益不划算，与 claude restart cancel-guard follow-up 同批 parity 收尾合理。

### 验证为正确、无 finding 的核心机制（reviewer-claude R1 防误判遗漏）

- **cancellation-epoch 是活的**：bumpCloseEpochImpl 在 lifecycle.ts:107/150/331（close/markClosed/delete）+ scheduler:103 真自增；cancelGuard 经 create-session-resume.ts:55 真 throw sentinel；closeImpl:150 自增放 adapter.close **之前**（codex closeSession no-op 时仍能感知 close intent）。
- **单飞 recovering Map 两端对称**：restart while-loop re-check 防 multi-waiter race；codex 无 rename listener 是 by-design（spike-A2 实测 codex 不 implicit fork，thread-loop case 3 future-proof 保留）。
- **closed-revival 幽灵防护（recover 路径）**：wasClosed markClosed 回滚在 cwd-miss throw / createSession reject 两路覆盖；cancel 路径不回滚正确（lifecycle 已是用户想要的 closed）。
- **rollback / finalize**：create-session-rollback 4 资源 best-effort idempotent cleanup（codexBySession → tokenMap → sessions → sdkClaim）；resume-path-await 三态状态机（onFirstId / earlyErrCb 30s 内/后 / timeout）互斥 cleanup；jsonl-discovery fail-safe（异常返 true 让 SDK 自 try）。
- **ctx.createSession 类型逆变无运行时丢失**（reviewer-codex R2 确认）：RestartCreateOpts 已补齐 helper 传出字段（resumeMode/model/extraAllowWrite/cancelCheck），facade createSession(restartOpts) 原样进 codex create-session impl。

## 遗留 follow-up

- **issue `30ca35a9`**（recover-only MED）：codex recover 重建 thread 丢失 reviewer-codex spawn-time 的 networkAccessEnabled + additionalDirectories defaults（未持久化 SessionRecord）→ app 重启后 reviewer-codex 失 web/network + 跨目录访问。反驳轮收窄：restart 触发面不成立（reviewer 不走 UI 切档），仅 recover 有效。需独立 plan（migration v028 加 2 列 + 5 层改动）。
- **codex restart fallback handoffPrompt user bubble + claude restart cancel-guard parity**（注释标注，建议合并「restart 路径 codex/claude parity 收尾」issue）。
- **R1 三 INFO**（reviewer-claude，本批未碰留 follow-up）：INFO-1 facade re-export 不全（recoverer.ts re-export 块仍 5 个，SummariseFnThunk/ListEventsFnThunk/ListRecentMessagesFnThunk 直 import _deps；fix 新增 restart-controller 也直 import _deps）/ INFO-2 DB 同值双写（restart setCodexSandbox + resume persistSessionFields，两端对称）/ INFO-3 IIFE finally delete 早于外层 set 理论窗口（同步段不抛不可触发，两端对称）。

## 收口

R2 双 reviewer 均明示「同意 conclude + 可合」，0 HIGH 0 真 MED。typecheck 双配置绿 + 全项目 1357 passed + 236 skipped（SQLite-binding-gated）零回归。commit `3511d96`（R1 合并修法 + 3 回归测试）+ `f9dbb0c`（R2 INFO-A/B 强化）。
