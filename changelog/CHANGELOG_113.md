# CHANGELOG_113

## 概要

REVIEW_40 R1+R2+R3 codex/claude adapter 架构对称性深度 review × Phase 2+3 fix 落地（plan codex-claude-adapter-symmetry-20260515）。reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5 xhigh teammate 三轮 focused single-topic review:scope = 13 文件 + 6 sub-focus(sandbox 字段命名 / restart method signature / resume defense / event emit 时序 / ensureXxx pool 模式 / SDK lifecycle 边界)。R1 共挖 9 真问题(2 ✅ HIGH + 6 ✅ MED + 1 LOW),含 1 反驳轮 reviewer-codex 单方 HIGH 被降为 future-proof MED;R2 又挖 3 fix-to-fix 真问题(1 HIGH + 1 MED + 1 LOW)+ 3 follow-up;R3 又挖 1 fix-to-fix MED(R2-1 漏洞)。共 8 commit / 行为零变化(recoverer 新增 = 与 claude 自愈能力对齐) / typecheck 双端 + vitest 524/524 全过。详 [REVIEW_40.md](../reviews/REVIEW_40.md)。

R37 R2 ❌ pre-existing 3 处 HIGH-2/HIGH-3/MED-3 在 R1 reviewer-claude 实证下重新定性: HIGH-2/HIGH-3 「命名/signature 不一致」claim **不成立**(grep 36/38 + 32 处实证规则已统一,enum value 不一致是 SDK 内禀差异);仅 MED-3「codex resume defense 与 claude 不对称」是真问题。

## 变更内容

### Phase 2: P2 R1 fix（6 commit / 按风险升序）

#### Commit 1 — MED-C codex-instance-pool jsdoc 纠错（commit 8d3328e）

- `src/main/adapters/codex-cli/codex-instance-pool.ts` jsdoc 删「应用全局唯一」「3 处独立 cache」误导措辞
- 改为「仅服务 oneshot LLM caller(summarizer-runner / handoff-runner)」+ 明确 live session bridge 自带 `private codex` cache 因需 mcp_servers config 注入(本 pool 接口仅接受 codexPathOverride)
- 双方独立提出 jsdoc 误导 → R1 三态裁决 ✅ MED 真问题
- 行为零变化(纯 jsdoc 纠错)

#### Commit 2 — MED-B 删 codex currentSandboxMode 三层镜像（commit 453520e）

- 删 codex `private currentSandboxMode` field + 默认值 + setter (sdk-bridge/index.ts -15 LOC)
- 删 codex-cli/index.ts public `setCodexSandboxMode` 转发方法 + init 时 push 调用 (-7 LOC)
- 删 adapters/types.ts `setCodexSandboxMode?` 接口方法 (-2 LOC)
- 删 ipc/settings.ts `applyCodexSandboxMode` 函数 + APPLY_FNS 数组注册 (-7 LOC)
- bridge createSession 内 `this.currentSandboxMode` → `settingsStore.get('codexSandbox')` 直读
- 与 claude `sdk-bridge/sandbox-resolve.ts` 同款直读模式对齐(R37 P1 G 删 `private codexCliPath` field 是同款先例)
- reviewer-claude 单方 + 修法明确(维护性收益清晰,降配置回路复杂度)

#### Commit 3 — HIGH-A single-flight + MED-A emit session-upserted（commit f76aed5）

- `codex-cli/sdk-bridge/index.ts` facade 加 `private recovering = new Map<string, Promise<unknown>>()`(与 claude 同款 facade 持权威 ref,RestartController + 未来 SessionRecoverer 双方 mutate 同一份)
- `codex-cli/sdk-bridge/restart-controller.ts` `RestartCtx` 加 `recovering` 字段;`restartWithCodexSandbox` 入口先 await inflight,body 包成 Promise set 到 Map,finally delete
- 修法字面镜像 claude REVIEW_36 R2 MED-B(单飞标记必须在 closeSession + DB write + createSession 之前 set,覆盖整个冷重启的副作用窗口)
- restart 写库后 + 回滚后 emit `eventBus.emit('session-upserted', updatedRec)` 让 SessionDetail 下拉值立即跟到新 mode(与 claude 同款 5-10s busy 期间用户已经看到「切完了」)
- 双方独立提出 → R1 三态裁决 ✅ HIGH + ✅ MED 真问题

#### Commit 4 — HIGH-B 新建 codex SessionRecoverer + MED-E jsonl pre-check + LOW-A cwdExists（commit ef10747）

- 新建 `src/main/adapters/codex-cli/sdk-bridge/recoverer.ts` ~280 LOC 镜像 claude 同款架构(精简版):
  - SessionRecoverer 类 + recoverAndSend 方法
  - inflight 单飞(与 facade.recovering Map 共享)
  - 5s placeholder dedup(与 claude REVIEW_17 R3 同款)
  - archived → unarchive(与 claude CHANGELOG_31 同款)
  - MAX_MESSAGE_LENGTH 校验
  - 失败 emit error message
  - attachments 透传
  - 显式透传 sandbox/model 从 sessionRepo 历史值(与 claude REVIEW_36 HIGH-1 教训同款)
- `defaultCodexResumeJsonlExists` 算法 — 用 sessionRepo.startedAt 算 createdAt Date,扫 ~/.codex/sessions/<YYYY>/<MM>/<DD>/ 找 *-<threadId>.jsonl,±1 day 覆盖时区边界,异常 fail-safe 退化返回 true
- `defaultCwdExists` (与 claude `defaultCwdExists` 同款) + `findFallbackCwd` 启发式 fallback 算法(与 claude L545-569 字面镜像)
- bridge sendMessage 内 `if (!s) throw` 改 `if (!s) await this.recoverer.recoverAndSend(...)` 自愈
- protected `codexResumeJsonlExists` + `cwdExists` wrapper(与 claude facade 同款 facade extend override 模式)
- **codex 与 claude 关键差异(架构内禀)**: codex 无 hook 通道 / 无 LLM 摘要 prepend(留 follow-up: 跨 adapter shared MAX_MESSAGE_LENGTH 解耦) / 无 implicit fork(spike-A2 实测 + post-rename 防御 future-proof) / 无 permissionMode / jsonl 路径不同
- 双方独立提出 + lead 实证 → R1 三态裁决 3 个真问题合一 commit

#### Commit 5 — MED-D codex resume await thread.started + thread-loop case 3（commit c9c94d7）

- `codex-cli/sdk-bridge/thread-loop.ts:212` thread.started 处理改三种情况:
  - case 1 (新建路径,!internal.threadId): 设字段 + firstIdCb (原行为)
  - case 2 (恢复路径正常,id 一致): 仅 firstIdCb 通知外层
  - case 3 (恢复路径 SDK 返不同 id,罕见): warn + sessions Map key 切换 + renameSdkSession + 更新 internal.threadId + firstIdCb 给新 id (future-proof)
- `codex-cli/sdk-bridge/index.ts` resume path: 改 `void runTurnLoop` + `return immediate` 为 `await new Promise(...)` 模式(仿 startNewThreadAndAwaitId)
  - onFirstId → resolve 实际 id(可能 = opts.resume 或新 id)
  - onEarlyError → emit finished + reject(让 outer caller 自己 emit context-aware 错误)
  - 30s timeout fallback → 退化 resolve(opts.resume) 假定 SDK 慢但能起
- **修前**: thread-loop:212 `&& !internal.threadId` 保护让 resume 路径跳过 thread.started.thread_id 校验(future-proof gap);resume path 立即 return 让 restart-controller catch 在 resume path 实际死代码
- **修后**: case 3 future-proof 防御 + restart-controller catch 在 resume path 不再死代码 + 显式 await SDK 实际状态
- reviewer-codex 单方提出 → reviewer-claude 反驳轮三反驳点结论「部分支持」HIGH→MED future-proof gap

#### Commit 6 — MED-F extraAllowWrite jsdoc reflect reality（commit 8b607a1）

- `adapters/types.ts:92-93` jsdoc 写「持久化:spawn 路径下由 finalizeSessionStart 写 sessions.extra_allow_write;recoverer 从 sessionRepo 读回」是 **fictional aspirational claim**(grep 0 命中 migrations + session-repo + finalize)
- 误导新维护者 + 掩盖真 bug(hand_off_session 外置 worktree + app 重启 + recoverer fallback → SDK sandbox.allowWrite 不含原 mainRepo → 写 plan 文件静默失败)
- 修法 jsdoc 改为「**未持久化** — 仅 transient 注入到首次 spawn」+ 列「已知限制」+ 「FUTURE 持久化方案」5 步路线
- **不加实现** (scope 决策): symmetry-plan §1 不变量「行为零变化」+ 改造涉及 migration v019 (irreversible) 应独立 plan
- reviewer-codex 单方 + lead 实证

### Phase 3: R2 fix（1 commit）

#### Commit 7 — R2-1 sessions cleanup + R2-2 cwdFellBack 行为 + R2-3 30s emit info（commit 6e0eb37）

- **R2-1** (reviewer-codex HIGH 单方+lead 实证): resume earlyErrCb path reject 之前 `sessions.delete(opts.resume) + sessionManager.releaseSdkClaim(opts.resume)`,让 outer caller 触发的 next sendMessage 走 sessions Map miss → recoverer 自愈正常路径
- **R2-2** (reviewer-claude MED-G 单方+实证): recoverer cwdFellBack 处理两个问题:
  - (a) emit message text「Codex CLI jsonl 在原 cwd 下,本会话续聊从 fresh thread 开始」与 ef10747 自身注释 L38-40「codex jsonl 在 ~/.codex/sessions/<YYYY>/<MM>/<DD>/ 不在 cwd 下」自相矛盾
  - (b) cwdFellBack=true 强制走 fresh thread fallback 即使 jsonl 在 — 用户失去本可保留的对话历史
  - fix: jsonl 预检条件改 `if (!this.jsonlExistsThunk(...))` 删 `cwdFellBack ||`;emit message 改正(说 cwd 切换 + 文件引用注意,不再说 jsonl 在 cwd 下);删 unused `cwdFellBack` 变量
- **R2-3** (reviewer-claude LOW-B 单方): resume 30s timeout 补 emit info message(不 `error: true` 与 commit c9c94d7 注释「不应武断标 finished:error」一致,提示 SDK 慢启动 + 后续 turn 可能仍能恢复 + 检查鉴权/二进制路径建议)

### Phase 4: 顺手 polish（条件触发,跳过）

R37 R3 INFO #1/#2(claude recoverer.ts L465 + archive-plan-impl.ts ArchivePlanResult 命名碰撞)按 plan §设计决策 5 「仅当本 plan 已 spawn 改 recoverer.ts 或 archive-plan-impl.ts 的 commit 时才一并做(避免单建 trivial commit)」— 本 plan 仅新建 codex recoverer.ts,未动 claude recoverer.ts / archive-plan-impl.ts → 触发条件未满足跳过。

### Phase 5: R3 收口 + R3 fix（1 commit）

#### Commit 8 — R3 reviewer-codex MED late earlyErr cleanup（commit 726af8d）

- **R3-1** (reviewer-codex MED 单方+lead 实证 R2-1 漏洞): R2-1 仅修了「30s 内 earlyErr → reject」路径,30s timeout 后 late earlyErr 被 `if (resolved) return` 短路,sessions Map 仍残留 stale internal.thread → 后续 sendMessage `if (!s)` 命中绕过 recoverer
- 触发场景: codex SDK 慢启动(resume 30s 内未发 thread.started)→ timeout fires resolve(opts.resume) + emit info → SDK 后来 throw early error → earlyErrCb 触发但短路 → sessions/sdkClaim 残留
- 修法(无条件 cleanup + emit finished + 分支 emit error):
  - 不管 resolved 不 resolved,sessions.delete + releaseSdkClaim + emit finished 永远做
  - resolved=false (路径 1, 30s 内 earlyErr): reject 让 outer caller 自己 emit context-aware 错误(避免双错误消息)— 与 R2-1 行为一致
  - resolved=true (路径 2, late earlyErr): outer caller 已 resolve 不会 catch,补 emit error message 让用户看到失败原因 + 知道下条消息会自愈
- reviewer-codex 单点 ack: ✅ 对症可合

## R3 收口结论

- **reviewer-claude R3**: ✅ 可合不需补改 — 6 sub-focus 整体改善 ack;架构 drift = 0(全部字面镜像 claude pattern);测试覆盖 INFO-T 留 follow-up 不阻塞
- **reviewer-codex R3 + ack**: ⚠ 需补改(发现 R3-1)→ R3 fix 后 ✅ 对症可合 — earlyErrCb 已移除短路,cleanup + emit finished 永远做

**双方一致 ✅ 可合**。

## 留 follow-up（独立 plan / ticket,不在本 plan scope）

| ID | 来源 | 触发条件 |
|---|---|---|
| **P4 BaseAdapter / CreateSessionOptions 拆判别联合** | R37 R1 finding | 加新 adapter / 4 adapter 间 sandbox/permission 行为漂移频繁修 |
| **F2 scheduler 命名一致性** | R37 R1 finding(自降级 INFO)| 下次加新 scheduler 时一并 rename |
| **跨 adapter sandbox 继承(reviewer-codex R1 HIGH-2)** | reviewer-codex 单方 design question | sandbox enum value 不平凡映射方案设计 |
| **recoverer waiter Promise<string>(reviewer-codex R2 MED)** | claude + codex 同款 limitation | 双 adapter breaking change 设计 |
| **double rename owner cleanup(reviewer-codex R2 LOW)** | idempotent 不阻塞 | 顺手清理 |
| **codex sdk-bridge unit tests(reviewer-claude R2 INFO-T)** | 横跨 HIGH-A/B/MED-D/E 横向 gap | ~200 LOC tests + setup,镜像 claude 套件 |
| **extraAllowWrite 持久化(reviewer-codex R1 MED-F)** | hand_off_session 外置 worktree 后 app 重启 | migration v019 + sessionRepo + finalize + recoverer 5 步 |

## 测试

- typecheck 双端 0 错(node + web)
- vitest 524/524 全过 + 64 环境 skip(better-sqlite3 ABI 不匹配,与本 plan 改动无关)
- codex translate.test.ts 24/24 全过(Phase 2-3-5 各 commit 单独验证)

## 引用

- 配套 review: [REVIEW_40.md](../reviews/REVIEW_40.md)
- 配套 plan(归档后): [`plans/codex-claude-adapter-symmetry-20260515.md`](../plans/codex-claude-adapter-symmetry-20260515.md)
- 父 review/plan: [REVIEW_37.md](../reviews/REVIEW_37.md) + [`plans/deep-review-and-refactor-r37-20260515.md`](../plans/deep-review-and-refactor-r37-20260515.md) — R37 R2 ❌ pre-existing 3 处 codex/claude 架构对称性发现触发本 plan
- 同期 changelog: CHANGELOG_110(R37 落地)
