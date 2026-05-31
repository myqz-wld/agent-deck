# REVIEW_79 — 全项目 deep review 批 D1：codex-cli sdk-bridge create-session + entry

- 日期: 2026-05-31
- 类型: Debug / 功能 BUG + 代码优化 + 文字措辞（全项目 deep review 第九批，Batch D 子批 D1，**Batch D 开篇**）
- 触发: 用户「deep review 下项目，自主一路推进 + 自主 hand off」授权（plan deep-review-project-20260531）
- 关联: plan deep-review-project-20260531 / REVIEW_71-78（A1/A2/B1/B2/C1-C4，C 批是 claude adapter；本批转 codex adapter）
- 方法: 多轮异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5，**fresh pair** team dr-project-d-20260531；C3-C4 pair 已 closed → 重 spawn）+ 三态裁决 + lead 全链 trace（effectiveResumeThreadId 解析 → resumeThread cli-sid → thread-loop case 1/2/3 fork-detect → updateCliSessionId 黑名单链）+ **temp-revert 复现验证**。
- 收口: R1 双 reviewer reply。**异构 divergence**：codex 0 HIGH/0 MED/0 LOW + 2 INFO（结论「主链路收口干净，仅测试缺口 + 注释漂移」）；claude 0 HIGH / 1 MED（logic/parity 单方）+ 1 MED（测试缺口）+ 3 INFO。两 reviewer 在「测试缺口 + thread-options-builder doc」上独立收敛。lead 对 claude 单方 MED-1 现场 trace 验证 + temp-revert 复现（pre-fix 确定性误触 case 3）→ 升 ✅ 真问题修。0 HIGH → 无反驳轮（MED 单方走 lead 自验）。typecheck 双配置 + codex-cli 131 passed（+10 回归 test，MED-1 temp-revert 验证非空）。

## 范围（批 D1）

codex-cli SDK adapter bridge 的「会话创建主链路 + adapter facade entry」子模块，10 文件 ~1382 LOC：

| 文件 | LOC | 职责 |
|---|---|---|
| `sdk-bridge/index.ts` | 509 | CodexSdkBridge facade（per-session codexBySession Map + ensureCodex envOverride 注入 + renameCodexInstance + closeSession 双轨清理 + sendMessage/interrupt + 4 sub-class 装配） |
| `sdk-bridge/create-session/create-session-impl.ts` | 188 | createSession orchestrator（validate → prepare inline → resume/new dispatch → catch rollback） |
| `sdk-bridge/create-session/_deps.ts` | 200 | CreateSessionOpts/Deps/Result/PreparedContext type SSOT |
| `sdk-bridge/create-session/create-session-new.ts` | 76 | spawn 新建路径（tempKey 占位 + startNewThreadAndAwaitId + persist） |
| `sdk-bridge/create-session/create-session-resume.ts` | 132 | resume 路径（thread_id 已知 + emit session-start/user msg + awaitResumedThreadStart） |
| `sdk-bridge/create-session/create-session-validate.ts` | 54 | prompt 校验 + sid 分配 + token allocate |
| `sdk-bridge/create-session-rollback.ts` | 99 | runCreateSessionRollback（4 资源 best-effort idempotent cleanup） |
| `sdk-bridge/thread-options-builder.ts` | 49 | buildCodexThreadOptions 纯函数（7 字段 spread） |
| `sdk-bridge/input-pack.ts` | 53 | packCodexInput / extractAttachmentPaths |
| `sdk-bridge/constants.ts` | 22 | AGENT_ID / MAX_MESSAGE_LENGTH / MAX_PENDING_MESSAGES / THREAD_STARTED_FALLBACK_MS |

## 三态裁决结果

### [MED ✅ reviewer-claude 单方 + lead temp-revert 复现验证] create-session-impl.ts:151 — resume 路径 `internal.threadId` 初值用 applicationSid 而非 cli-sid，reverse-rename 后正常 resume 误触 thread-loop case-3「fork」

reviewer-claude 单方提出（codex 互补盲点未审 parity 角度，非反驳）。`internal.threadId: opts.resume ?? null`（=applicationSid），但 `effectiveResumeThreadId`（create-session-impl.ts:102-105）解析成 **cli-sid**（`opts.resumeCliSid ?? sessionRepo.cliSessionId ?? opts.resume`），line 117 `resumeThread(effectiveResumeThreadId)` 用的是 cli-sid。

**触发链**（一个 codex 会话之前经历过 jsonl-missing fallback，applicationSid=A，cli_session_id=C，C≠A，后被 recoverer 正常 resume）：
- caller 显式传 `resumeCliSid=C`（recover-and-send-impl.ts:297 + restart-controller.ts:140 `rec.cliSessionId ?? sessionId`）→ `effectiveResumeThreadId=C` → `resumeThread(C)` 启 thread → SDK 正常返 `thread_id=C`
- 但 `internal.threadId=A` → thread-loop.ts:295 `internal.threadId(A) !== ev.thread_id(C)` 命中 **case 3 fork-detect**（本该走 case 2 正常分支）

```ts
// 修前 create-session-impl.ts:149-151
const internal: InternalSession = {
  applicationSid: initialSid,
  threadId: opts.resume ?? null,   // ← applicationSid，与 resumeThread 传的 cli-sid 不一致
```

**lead 验证**：
1. grep 确认 caller 真实传 `resumeCliSid: rec.cliSessionId ?? sessionId`（recover-and-send-impl.ts:297 + restart-controller.ts:140）→ 反向 rename 后 `effectiveResumeThreadId=C≠A` 成立 ✅
2. 读 thread-loop.ts:264-337 三分支：`!internal.threadId`→case1 / `threadId!==ev.thread_id`→case3 / 否则 case2。internal.threadId=A、SDK 返 C → 必进 case3 ✅
3. 读 rename.ts:147-153 确认当前后果良性：`updateCliSessionId(A, C)` 内 `oldCliSid = rec.cliSessionId = C` → `if (C !== C)` false → **不写黑名单**（不会误把活跃 cli-sid C 拉黑）→ 无数据损坏 / 无 split-brain ✅
4. 对照 claude parity：stream-processor.ts:365 fork-detect 比较 `resumeId`（R7 MED-R7-1：caller 透传时已是 `effectiveResumeCliSid ?? resumeId` = **cli-sid 维度**）vs realId → 正常 resume 时 requested-cli-sid===returned-realId → 不误触 fork。**codex 用 applicationSid 当比较基准 → codex 独有 parity 偏差** ✅
5. **temp-revert 复现**：把 `threadId` 改回 `opts.resume ?? null` 跑 MED-1 test → 断言失败「`updateCliSessionId('app-A','cli-C')` been called 1 times」，确定性复现 case 3 误触 ✅

**当前后果**（诚实评估，故 MED 非 HIGH）：①每次 resume 这类会话打误导性 `logger.warn "SDK returned thread_id C != tracked A (resumeThread-fork or fresh-cli-reuse-app)"`（实际两者都没发生）干扰排障；②latent 脆弱——若未来 case3 改成无条件写黑名单 oldId，C 会被误拉黑变真 bug。无数据损坏故 MED。

**修法**：`threadId: effectiveResumeThreadId ?? opts.resume ?? null`。三路径验证（test 守门）：
- normal resume after fallback → threadId=C(cli-sid) → SDK 返 C → case 2 ✓（修复）
- fresh-cli-reuse-app → effectiveResumeThreadId=null → threadId=opts.resume=A → SDK startThread 返新 id D → A!==D → case 3 ✓（intended 保留）
- spawn（无 resume）→ effectiveResumeThreadId=null + opts.resume undefined → threadId=null → case 1 ✓（保留）

连带修 orchestrator 顶部 jsdoc（修前只承认 fresh-cli-reuse-app 用途，未承认 normal-resume-after-fallback 误触边角）。

### [MED ✅ reviewer-claude + reviewer-codex 双方独立] 测试覆盖缺口 — createSession rollback 枚举路径 + thread-options-builder 零 test

focus 点名「测试质量」。两 reviewer 独立指出：
- **reviewer-claude**：REVIEW_60 MED-codex-2 顶层 try/catch + runCreateSessionRollback 的两条 throw 路径（①ensureCodex throw ②resumeThread/startThread sync throw）无任何直接 test（early-err-cleanup.test.ts 只 reject runStreamed = thread 已起后，不覆盖 ensureCodex / 同步 resumeThread throw）；thread-options-builder.ts jsdoc 写「见 thread-options-builder.test.ts（待补 R4 follow-up）」但该 test 不存在。
- **reviewer-codex**：buildCodexThreadOptions 是 resume/new 两分支共享关键参数收口点（approvalPolicy fallback / skipGitRepoCheck / 条件 spread / 数组浅拷贝），缺 helper 自身窄单测。

**验证**：`grep -rln "runCreateSessionRollback\|createSessionImpl\|thread-options-builder" __tests__/` → 0 命中直接测 ✅。

**修法**：补 2 个 test 文件：
- `thread-options-builder.test.ts`（6 test）：approvalPolicy `?? 'never'` fallback + 显式透传 / skipGitRepoCheck 恒 true / model·network·additionalDirectories 条件 spread（缺省字段不出现 + networkAccessEnabled=false 合法显式值仍出现）/ additionalDirectories 浅拷贝防 mutate
- `create-session-thread-id-init.test.ts`（4 test）：MED-1 回归（reverse-rename normal resume → case 2 不调 updateCliSessionId）+ fresh-cli-reuse-app 保留 case 3 + rollback 路径 1（ensureCodex throw via loadCodexSdk reject → token released）+ rollback 路径 2（resumeThread sync throw → token released + releaseSdkClaim）

### [INFO ✅ reviewer-claude] thread-options-builder.ts:6 — jsdoc「9 字段」与实际 7 字段不符

括号里列了 7 个（workingDirectory / sandboxMode / approvalPolicy / skipGitRepoCheck / model / networkAccessEnabled / additionalDirectories），return 也正好这 7 个，jsdoc 写「9 字段」笔误 → 改「7 字段」。

### [INFO ✅ reviewer-codex] _deps.ts:105 — additionalDirectories 文档漏 `/tmp`

`CreateSessionOpts.additionalDirectories` jsdoc 写 reviewer 默认只 spread `['~/.claude', '~/.codex']`，但 options-builder.ts:176-180 实际是 `[homedir/.claude, homedir/.codex, '/tmp']`，teammate-spawn-defaults.test.ts 也断言 `/tmp`。**lead 验证**：读 options-builder.ts:171-180 确认 `/tmp`（spike4 实证 reviewer-claude wrapper Bash 模板写 `/tmp/<basename>.{in,out,err}.txt` 路由 stdio，缺 `/tmp` 时 codex sandbox-exec 拒读）✅ → jsdoc 补 `/tmp` + 加来源说明。

### [INFO ✅ reviewer-claude] create-session-impl.ts:91-104 — 同一 row sessionRepo.get(opts.resume) 读两次

line 92 取 `.codexSandbox`、line 104 取 `.cliSessionId`，两次同步 DB get 同一行（两读间无 await，better-sqlite3 同步单线程值一致无 race，纯冗余）。**修法**：prepare 段起头一次 `const resumeRec = opts.resume ? sessionRepo.get(opts.resume) : null` 复用（行为零变化）。

### [INFO ✅ reviewer-claude] create-session-new.ts:67 — 「void sandboxMode」注释 stale

注释「void sandboxMode 引用避免 TS noUnusedLocals」措辞 stale（代码无 void 语句，sandboxMode line 71 真用着 persistSessionFields）→ 删该注释行免误导。

## 修复清单

| # | 文件:行 | 严重度 | 修法 | 验证 |
|---|---|---|---|---|
| 1 | create-session-impl.ts:151 | MED ✅ | `threadId: effectiveResumeThreadId ?? opts.resume ?? null`（cli-sid 维度，对齐 claude parity，修 case 3 误触）+ jsdoc | reviewer-claude 单方 + lead trace + temp-revert 复现（pre-fix 确定性误触 case 3）+ 回归 test |
| 2 | thread-options-builder.test.ts（新）+ create-session-thread-id-init.test.ts（新） | MED ✅ | 补 10 test（6 builder + 4 createSession） | 双方独立 + 全 pass + MED-1 temp-revert 非空 |
| 3 | thread-options-builder.ts:6 | INFO ✅ | 「9 字段」→「7 字段」 | reviewer-claude |
| 4 | _deps.ts:105 | INFO ✅ | additionalDirectories 补 `/tmp` + 来源说明 | reviewer-codex + lead 读 options-builder 验证 |
| 5 | create-session-impl.ts:96-104 | INFO ✅ | 单读 resumeRec 复用（消冗余 DB get） | reviewer-claude |
| 6 | create-session-new.ts:67 | INFO ✅ | 删 stale「void sandboxMode」注释 | reviewer-claude |

## 验证

```
typecheck（双配置 tsconfig.node + tsconfig.web）：PASS
node_modules/.bin/vitest run src/main/adapters/codex-cli：12 files / 131 passed（121 既有 + 10 新）
MED-1 temp-revert：threadId 改回 opts.resume → create-session-thread-id-init MED-1 test FAIL
  （updateCliSessionId been called 1 times）→ 确定性复现 case 3 误触 → 证 test 守门有效
```

## 结论

Batch D 开篇。codex create-session 主链路（资源 claim/release、rollback 4 资源幂等、reverse-rename 不变量、emit 序列）整体收口扎实，0 HIGH。唯一逻辑问题 MED-1 是 codex 独有的 claude-parity 偏差（internal.threadId 比较基准用错维度），当前后果良性（误导 warn + latent 脆弱）但 temp-revert 确定性复现故升 ✅ 修。测试缺口双方独立指出 → 补 10 test 把 rollback 枚举路径 + thread-options-builder + MED-1 回归全部守门。其余 4 INFO 全 doc/efficiency 清理。
```

> 下一子批 D2：thread-loop + translate + session-finalize + restart-controller（thread.started case 1/2/3 fork-detect 核心 + event translation；REVIEW_69+70 改过 codex translate/win32，复查）。
