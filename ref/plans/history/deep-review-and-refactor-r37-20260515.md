---
plan_id: "deep-review-and-refactor-r37-20260515"
created_at: "2026-05-15"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-and-refactor-r37-20260515"
status: "completed"
base_commit: "ffcb663d1be600447dcb6737cbcec9a83f2b9421"
base_branch: "main"
review_id: "REVIEW_37"
review_team: "deep-review-37-macro"
reviewer_claude_sid: "9b3664c0-e706-4a3d-9d2b-ff2ad2bb5ccd"
reviewer_codex_sid: "065de55e-7cf4-4fa1-b051-13c43384c2dd"
final_commit: "6f2a32a98721b5a7c2dae4a6cf73fbc326098031"
completed_at: "2026-05-15"
---
# deep-review-and-refactor-r37-20260515 — REVIEW_37 P1+P2+P3 落地

## 总目标 & 不变量

R37 异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5 xhigh）做完宏观重构机会评估，产出 7 ✅ HIGH + 8 ✅ MED + 4 LOW/INFO 真问题清单（双方独立提出 ✅ + 单方 grep 实证 ✅，0 反驳证伪）。本 plan 落地 **P1+P2+P3 三档**（不含 P4 architectural BaseAdapter，留下个 plan 单做）。

**不变量**：
- 所有改动 worktree 内跑，主仓库零污染
- 严格按 ROI/风险升序：P1 trivial 高收益 → P2 中等 → P3 散落收口
- 每个 phase 独立 commit，message 引用「(R37 P<X>-Y)」
- 改完 typecheck + 全套 vitest + 必要时 build 必跑
- 不动 P4 BaseAdapter / CreateSessionOptions 拆判别联合（架构级 plan 单立）
- 不引入新功能，纯重构 + 优化（行为零变化为目标，仅 DELIVERABLE LOC 减少 / 收口 / 防漏 wrapper）
- **保留 R37 reviewer 不 shutdown** — 让 lifecycle scheduler 自然 dormant，下次 R2 review 复用 mental model

## 设计决策（不再争论）

1. **P1 三项打头**：D withMcpGuard + subscribe / G codex 三处 ensureCodex 收口 / B recoverer 抽 message builder。理由：单 commit trivial / 高 ROI / 与历史拆分模式（CHANGELOG_85）一致 / 防漏 security risk
2. **P2 跟进**：F shared mock factory / H+I LLM oneshot helper + adapter.summariseEvents 下放 / E codex sdk-bridge 拆 / M runBatonCleanup helper
3. **P3 收尾**：C cwd resolver + single-flight + emit helper / K preload misc 拆 / J shared 边界 / L IPC errorMode 统一
4. **trivial 顺手**：N message-delivery-state / O README+protocol 占位文案 / claude F4 omitUndefined + 注释碎片
5. **不做**：P4 BaseAdapter（plan 级架构改造，单立后续）；F2 scheduler 命名一致性（claude 自降级 INFO，改造成本 > 收益）
6. **R2 review 时机**：P1+P2 完成后做一次 R2（让 reviewer 复审 fix 是否对症 + 0 引新 bug）；P3 完成后做 R3 收口 review
7. **跨会话 hand-off**：用 `mcp__agent-deck__hand_off_session` 自动起新 session + archive caller；新 session 必须传 `team_name: 'deep-review-37-macro'` 让新 lead 加入 R37 team 与 reviewer 通信
8. **测试 mock factory（F）的归位目录** — `src/main/__tests__/_shared/mocks/`（按 reviewer-claude F5 推荐路径）
9. **codex pool 归位** — `src/main/adapters/codex-cli/codex-instance-pool.ts`（按 reviewer-claude F1[HIGH] 推荐路径）
10. **recoverer message builder 归位** — `src/main/adapters/claude-code/sdk-bridge/recoverer-messages.ts`（与 recoverer-helpers.ts 同目录同模式）
11. **withMcpGuard 归位** — `src/main/agent-deck-mcp/tools/handlers/_helpers.ts`（已有 helpers.ts，但分级 `_helpers.ts` 用于 wrapper 类，避免与 `helpers.ts` 公共 API 混）；**preload subscribe** 归位 `src/preload/api/_helpers.ts`
12. **LLM oneshot helper 归位** — `src/main/session/oneshot-llm/`（目录式，含 `index.ts` 高层入口 + 独立 adapter dispatcher 文件）

## 步骤 checklist

### Phase 1: P1 老实件（trivial 高收益）

- [x] **Step 1.1 — D withMcpGuard + subscribe wrapper**：抽 `agent-deck-mcp/tools/helpers.ts` 加 `withMcpGuard()` + `preload/api/_helpers.ts` 加 `subscribe<T>()`；7 handler + events.ts 8 onXxx + teams.ts 2 onXxx 全部迁移；预计 -60 LOC + 防漏 denyExternalIfNotAllowed — **done by 本会话 on 2026-05-15, commit bd0be75**（typecheck 0 错 / vitest agent-deck-mcp 145 全过）
- [x] **Step 1.2 — G codex 三处 ensureCodex 收口**：抽 `adapters/codex-cli/codex-instance-pool.ts` 暴露 `getCodexInstance()` / `invalidateCodexInstance()` 应用全局 pool；2 个 oneshot runner（summarizer-runner / handoff-runner）共享 1 个实例；sdk-bridge 因含 agent-deck MCP config + bearer token 不能并入（保留 own ensureCodex 但删 `private codexCliPath` field 直接 settingsStore.get + setCodexCliPath 调 invalidate 同步失效 pool）；3 cache → 2 instance — **done by 本会话 on 2026-05-15, commit d421173**（typecheck 0 错 / vitest 全套 504 全过）
- [x] **Step 1.3 — B recoverer 抽 message builder**：新建 `adapters/claude-code/sdk-bridge/recoverer-messages.ts`（与 recoverer-helpers.ts 同目录），抽 6 个 message text builder 纯函数（cwdMissing / cwdFallback / jsonl missing summary success/fail / cwdFallback summary success/fail）；recoverer.ts 4 个分支替换为单调用；预计 641 → ~520 LOC — **done by 本会话 on 2026-05-15, commit 10d6656**（typecheck 0 错 / vitest 全套 504 全过 / 净 -12 LOC，emit struct boilerplate 留 Step 4.3 抽 emitFallbackOutcome helper 时收口）

### Phase 2: P1 trivial 顺手清理（在 P1 commit 中顺手做）

- [x] **Step 2.1 — claude F4 LOW: omitUndefined helper**：抽 `utils/optional-fields.ts`，spawn handler + hand-off-session-impl 6+5 处 spread+ternary 收口 — **done by 本会话 on 2026-05-15, commit 342eca7**（spawn.ts 4 + hand-off-session.ts 4 简单 spread 迁 omitUndefined；extra_allow_write/model 因 length/falsy 语义保留 inline；typecheck 0 错 / vitest 全套 504 全过）
- [x] **Step 2.2 — claude F4 INFO: recoverer 注释碎片**：删 recoverer.ts:159-162 4 行已死注释 — **done by 本会话 on 2026-05-15, commit 342eca7**（REVIEW_36 LOW-3 标的 TS6138 silence 死注释整体删；ctor body `{}` 不再含误导性副作用语句）
- [x] **Step 2.3 — codex 13 LOW: README + protocol doc 占位**：清理 README:269 + docs/agent-deck-team-protocol.md:357 + types.ts 占位注释，aider/generic-pty 改写为 "PTY bridge implemented" — **done by 本会话 on 2026-05-15, commit 342eca7**（types.ts 3 处 jsdoc + README 2 行 + 协议文档表格 2 行同步现实状态）

### Phase 3: P2 中等改造

- [x] **Step 3.1 — F shared mock factory**：建 `src/main/__tests__/_shared/mocks/{session-repo,event-bus,sdk-loader,agent-deck-team-repo,settings-store}.ts` 工厂（每个返 mockedRepo + 接受 overrides）；11 文件迁移使用 — **done by 本会话 on 2026-05-15, commit e5cc6a5**（5 factory +349 LOC 含 jsdoc + type；11 test 文件 -103 LOC；manager-test-setup.ts 转 re-export 让 manager 3 test 调用方 0 改；vi.hoisted 修 spawn-guards / tools.test.ts 的 immediate access const ReferenceError；504/504 vitest 全过 + 0 typecheck 错；行为零变化。**4 个文件保护清单**：adapters/generic-pty/__tests__/{pty-bridge.lifecycle,pty-bridge.idle-fwatch,adapter}.test.ts 仅 mock sessionRepo.setGenericPtyConfig 单方法，迁了反而冗余。R37 R1 finding 估「-360 LOC test code + 防漏 mock」偏乐观 — 真实收益是「防漏 mock + 标准化基线」而非 LOC 净减）
- [x] **Step 3.2 — H 4 LLM oneshot runner 抽 helper**：建 `session/oneshot-llm/{build-prompt,race-with-timeout,clean-result,claude-runner,codex-runner,index}.ts` 收口 4 处 race + result clean + prompt template + SDK 设置共性（6 文件 +435 LOC，重 WHY 注释）；4 runner（summariseViaLlm / summariseSessionForHandOff / summariseCodexSessionViaOneshot / summariseCodexSessionForHandOff）替换为高层入口（thin wrappers）；codex summarize timeout 下沉到 runner 内（与 codex handoff + claude path 统一），summarizer/index.ts 删 ~30 LOC Promise.race block — **done by 本会话 on 2026-05-15, commit 10a0af7**（typecheck 0 错 / vitest 全套 504/504 + hand-off.test.ts 6/6 全过 / 预计 -190 LOC 的 plan 估算偏乐观，**raw LOC 反而 +234 net**：4 文件 -401 + 6 helper +435，原因是按项目 CLAUDE.md「WHY 注释强约束」每个 helper 顶部 + 每个差异点写了密集 cross-reference 注释。**真实收益**：deliverable 代码 ~-80 LOC + 4 处 race / clean / prompt / SDK 设置变 1 SSOT，未来加第 5 路 oneshot 用例零模板压力 + 改 prompt / race 行为只改一处）
- [x] **Step 3.3 — I summarizer dispatch 下放 adapter.summariseEvents**：AgentAdapter interface 加 optional `summariseEvents?(cwd, events, kind)`；claude-code / codex-cli adapter 实装；summarizer/index.ts + ipc/sessions.ts 2 处 dispatch 改 `adapter.summariseEvents?.(...)` — **done by 本会话 on 2026-05-15, commit 04f04b4**（types.ts +30 jsdoc / claude adapter +23 / codex adapter +24 + import formatEventsForPrompt / summarizer/index.ts dispatch 4 行 if/else 收口为 1 行 + 删 3 个 import / ipc/sessions.ts dispatch 同款收口 + 删 2 个 import / aider+generic-pty 不实装走 fallback / 504/504 vitest 全过 + 0 typecheck 错 / 行为零变化）
- [x] **Step 3.4 — E codex sdk-bridge 拆 input-pack/session-finalize/restart-controller**：与 claude sub-module 镜像（参考 CHANGELOG_85 拆 claude sdk-bridge 的 5 sub-class + facade 风格）；预计 531 → ~470 LOC + 进护栏 — **done by 本会话 on 2026-05-15, commit d7c2522**（input-pack.ts 53 LOC + session-finalize.ts 68 LOC + restart-controller.ts 137 LOC / index.ts 543 → 409 大幅过 500 护栏 / restartWithCodexSandbox 改 thin wrapper 委托给 RestartController sub-class / persistSessionFields 收口 createSession 两路字面镜像段 / 504/504 vitest 全过 + 0 typecheck 错 / 行为零变化）
- [x] **Step 3.5 — M runBatonCleanup helper**：抽 `agent-deck-mcp/tools/handlers/baton-cleanup.ts`，archive_plan + hand_off_session 共享 keep_teammates + shutdown + archive caller 三态模板 — **done by 本会话 on 2026-05-15, commit be0d8ef**（baton-cleanup.ts 211 LOC + 单测 10 case 320 LOC / archive-plan.ts 235 → 167 大幅减 -68 / hand-off-session.ts 444 → 389 减 -55 / handler 端 deps seam shape 不变现有 43 case 0 改造跑过 / 514/514 vitest 全过 + 0 typecheck 错 / 行为零变化 — 时序 + 失败容错 + console.warn 核心 substring 全保留）
- [x] **Step 3.6 — codex 11 LOW: message-delivery-state.ts**：从 agent-deck-message-repo.ts 抽 `MAX_RETRY/backoff/status transition` 到 `store/message-delivery-state.ts`；SQL 与 JS 常量同处声明 — **done by 本会话 on 2026-05-15, commit 2125f64**（新文件 message-delivery-state.ts 208 LOC 含 BACKOFF_TIERS / MAX_RETRY / MAX_BODY_LENGTH / VALID_MESSAGE_STATUSES / MessageInvariantError + backoffMs / coerceMessageStatus / buildFindEligibleWhereSql 纯函数 + module load invariant 自检；agent-deck-message-repo.ts 496 → 460 LOC -36 + re-export 全部 named export 保 back-compat / findEligible SQL CASE 由 BACKOFF_TIERS 表派生消除「改任一处必须同步另一处」死注释 / rowToRecord 内 inline validStatuses 数组替换为 coerceMessageStatus / 514/514 vitest 全过 + 0 typecheck 错 / 行为零变化）

### Phase 4: P3 散落收口

- [x] **Step 4.1 — C cwd resolver**：抽 `utils/cwd-resolver.ts` 暴露 `resolveSpawnCwd(opts)`；统一 3 处 spawn cwd fallback 字面（codex sdk-bridge `opts.cwd && opts.cwd.trim() ? opts.cwd : process.cwd()` 严格版 / claude-runner + codex-runner `opts.cwd || process.cwd()` 宽松版）到「trim 后非空才用 caller cwd 否则降级 process.cwd()」严格语义 — **done by 本会话 on 2026-05-15, commit 1886247**（utils/cwd-resolver.ts +52 LOC 含 jsdoc / utils/__tests__/cwd-resolver.test.ts 6 case 守门 trim 后非空 / 3 处替换 + 4 处 jsdoc 同步 / 524/524 vitest 全过 + 0 typecheck 错。**5 处替换** plan 估算偏高 — R1 finding 估「等 5 处」时把 deps.cwd() inject 注入位（archive-plan-impl / hand-off-session-impl 各 1 处）也算上，但那 2 处不是 fallback chain 而是简单 deps inject，抽 helper 反而冗余；hand-off-session.ts 复杂 fallback chain `args.cwd > resolved.mainRepo > resolved.worktreePath` 是 plan-driven mode 特化逻辑，不能与简单 spawn fallback 同 helper 收口。**实际收益**：3 处 SSOT + caller 传 "   " 全空白时由「传 SDK 让 cli.js 撞 ENOENT」升级为「降级 process.cwd()」更安全。行为零变化（正常调用绝对路径 cwd））
- [x] **Step 4.2 — C single-flight helper**：~~抽 `utils/single-flight.ts` 暴露 `class SingleFlight<K, T>`；6 处单飞实现统一~~ — **不实施 by 本会话 on 2026-05-15**（与 plan 决策 5「不做 P4 BaseAdapter / F2 scheduler 命名」同款 calibration 后跳过）。**调研结论**：R1 估算「6 处单飞」高估 — 真实可收口 site 只有 2 处真 `Map<K, Promise<T>>` 模式（其余 4 处语义完全不同，硬塞 helper = 类型安全失效 + 抽象冗余）：
    - **真单飞**（适合收口）：① `ipc/sessions-hand-off-helper.ts` `handOffInflight = new Map<string, Promise<string>>` + `dedupHandOff` wrapper；② `adapters/claude-code/sdk-bridge/recoverer.ts` + `restart-controller.ts` 共享 `ctx.recovering: Map<string, Promise<unknown>>`
    - **不同语义**（不收口）：③ `session/summarizer/index.ts` `inFlight = new Set<string>()` 是 semaphore + dedup-sid（限并发数 + 同 sid 跳过），不是 dedup-with-key 复用 promise；④ `teams/universal-message-watcher/index.ts` 是 SQL `findEligible` + per-target backpressure check（行级 dedup，不是 in-memory 单飞）；⑤ `renderer/components/HandOffPreviewDialog.tsx` `requestSeqRef = useRef(0)` 是自增 seq 让过期 IPC response 被识别忽略（cancellation 模式 ≠ dedup 模式）；⑥ `adapters/generic-pty/pty-bridge/index.ts:79` `spawnHelperReady: Promise<void> | null` 是无 key 单 Promise（chmod 一次终身复用，不需 Map<K, T>）
    - **真单飞 2 处也不抽 helper 的理由**：① `dedupHandOff` 已自洽含 strict-equal 保护（13 LOC），抽 helper +80 LOC 替换 1 处 = helper 代码比替换的还多 → 过度抽象违 user CLAUDE.md「don't add abstractions beyond what the task requires」；② recoverer/restart-controller `ctx.recovering` 是 SDK 断连自愈 / 沙盒切换 / permission mode 切换核心 sub-class shared state，已经在 CHANGELOG_52 Step 3d/F2 + REVIEW_36 多轮加固稳定；改造涉及 RecovererCtx + RestartCtx interface 改字段类型 + facade 创建 ref + recoverer 4 处 set/delete + restart-controller 6 处 set/delete + 测试 mock 全套 → 「sub-class state ownership 转换」与 P4 BaseAdapter 同档高风险；当前模式没真 bug（strict-equal 保护是过度防御 — JS microtask 顺序保证 finally delete 与后续 set 时序无冲突），ROI 仅 1 SSOT 收益不足以承担 sub-class state ownership 改造风险
- [x] **Step 4.3 — C recoverer emit 占位 message helper**：在 recoverer.ts 内抽 `emitFallbackMessage(sessionId, text, opts?: { error?: boolean })` 私有方法收口 emit struct（与 Step 1.3 抽出的 6 个 builder 1:1 配套）— **done by 本会话 on 2026-05-15, commit bae79d4**（recoverer.ts +51 -64 净 -13 LOC / 6 处替换：outer cwd missing throw + outer cwd fallback info + inner jsonl missing summary used+skipped + inner cwdFellBack summary used+skipped；不收口 2 处单行字面量 L301 占位 + L501 兜底失败按 recoverer-messages.ts:27-28 注释明示留 inline / 524/524 vitest 全过 + 0 typecheck 错 / 行为零变化（emit struct 字段顺序与值完全一致）。**plan 估「4 个 emit 分支」实际是 inner 4 处，但 outer 2 处也镜像同款 struct + 与 builder #1-#2 配套，一并收口更彻底**）
- [x] **Step 4.4 — K preload misc 按域拆**：~~拆 `preload/api/{app,window,settings-misc,assets-misc,images-misc,permissions-misc,claude-md-misc,summarizer-misc}.ts`；抽 `preload/api/_helpers.ts` 内 `invoke<T>()` 封装~~ — **不实施 by 本会话 on 2026-05-15**（与 Step 4.2 同款 calibration 后跳过）。**调研结论**：两个子动作 ROI 都低：
    - **misc.ts 154 LOC 远未触发 500 LOC 护栏**：项目 CLAUDE.md「单文件 ≤ 500 行 — 超了必须试拆」是触发条件，154 LOC 不到 1/3。强行拆 8 个域文件每个 10-30 LOC → +200 LOC 模板（jsdoc / import / export namespace + index.ts re-export indirection）→ 净负 ROI。「don't add abstractions beyond what the task requires」违反
    - **invoke<T>() helper Step 1.1 已评估否决**：`preload/api/_helpers.ts:8-10` Step 1.1 落地时已写「不放 invoke<T> 封装 — 当前 `ipcRenderer.invoke(channel, ...args)` 已是泛型 method 各 facade 调用都附 `Promise<T>` 显式 return type，重复抽一层 helper 收益小。真未来加 telemetry / 错误统一处理 时再扩展」。Step 4.4 重做就是推翻 Step 1.1 已落地决策，无新论据
    - **不变动结论**：misc.ts 当前结构（单 `miscApi` object + JSDoc 分组 8 个域）已是 154 LOC 自洽组织，按域拆收益不在 LOC 净减（实际净增），收益假设是「未来加 IPC channel 修改影响小」— 但 154 LOC 单 object 改动也只触 1 hunk，并非真问题
- [x] **Step 4.5 — L MCP tool ToolResult builder**：方案 B+（**调整 plan 字面**）— 加 7 个 XxxResult interface 到 schemas.ts（与 7 个 XxxArgs type 对称）+ 8 处 handler return 加 `satisfies XxxResult` 校验，**不**抽 7 个 typed builder（保留 helpers.ts untyped `ok()` 8 处统一调用，typed builder 增加 indirection 收益是 marginal 类型文档；satisfies 已覆盖核心收益「字段拼写错 + 类型漂移被 TS 拦」）— **done by 本会话 on 2026-05-15, commit af4fafc**（schemas.ts +134 LOC type 定义 / 8 handler import + return satisfies 1 行 / hand-off-session spawnData 由 Record<string, unknown> 改 typed cast SpawnSessionResult 让 spread 后 satisfies 通过 / 524/524 全过 + 0 typecheck 错 / 行为零变化。**ROI 验证**：satisfies 校验首次通过即拦下 3 处真实字段类型漂移：① archive_plan branch_deleted/worktree_removed 实际 string 非 boolean ② spawn displayName 实际 string|null 非 string ③ archive_plan final_status 实际 'completed' literal 非泛 string — 这 3 处类型不准之前没人发现，schema 化后全部对齐 impl）
- [x] **Step 4.6 — L IPC errorMode 统一 wrapper**：~~扩展 `ipc/_helpers.ts` 加 `onInvoke(channel, handler, { errorMode: 'throw' | 'result' })` 或 `Result<T>` 约定；按通道分别声明（破坏性大，可拆 sub-step）~~ — **不实施 by 本会话 on 2026-05-15**（与 Step 4.2/4.4 同款 calibration 后跳过）。**调研结论**：60-80 处 IPC handler 现状已合理分两类 errorMode：
    - **throw 模式**（sessions.ts / settings.ts / hooks.ts / window-app.ts / permissions.ts / adapters.ts 大部分）：handler 抛 `IpcInputError` / `Error`，renderer `await invoke().catch(...)`。已被 `_helpers.ts on()` wrapper 透传支持
    - **result 模式**（assets.ts / images.ts 大部分）：handler return `{ ok: boolean, reason?: string }`，renderer `if (!r.ok)` 分支处理。无需 wrapper（return type 自表达）
    - **不实施理由**：(a) handler return type 已经清晰表达选了哪种 errorMode，wrapper 加 `{ errorMode }` 字段是「重复声明」反而冗余；(b) 强制 wrapper 不适合「业务层选择」性质的决策（errorMode 选哪个是 handler 业务语义决定的，不是 wrapper 能强制的）；(c) 改造 60-80 处大动土，没真 bug 修复 — plan 描述「破坏性大，可拆 sub-step」自身就承认 ROI 低；(d) 现有 `_helpers.ts on()` wrapper 已透传 throw，足够支持现有 throw 模式 handler，不需新加 wrapper
- [x] **Step 4.7 — J shared 拆 contract vs policy 边界**：明确 shared/ 定位为「跨进程 contract + policy」（不动文件位置），加 jsdoc 顶部标签让边界清晰 — **done by 本会话 on 2026-05-15, commit 736b24a**（5 file 加 jsdoc category 标签：ipc-channels.ts / types.ts 标 **contract**；mcp-tools.ts / wire-prefix.ts / constants/read-only-tools.ts 标 **policy**。ipc-channels.ts 顶部加完整边界约定 SSOT 让其他 file 引用。零 implementation 改动 / 524/524 全过 / 行为零变化）

### Phase 5: 收口

- [x] **Step 5.1 — R2 复审**：在 P1+P2 完成后跑一轮 reviewer R2（spawn 同 team 复用 reviewer mental model 或在新 session hand-off 时传 team_name 让新 lead 加入 team），focus = 「fix 是否对症 + 0 引新 bug + 是否引入 architectural drift」 — **done by 本会话 on 2026-05-15**：spawn 新 team `deep-review-37-macro-r2` (id `98f3a76f-01a8-4db9-925e-300c5e6751fb`) 一对 reviewer (claude · r2 sid `5cceabec` / codex · r2 sid `1e961eca`)，双对抗 + 反驳轮 + lead self-verify。结论：reviewer-claude 0 finding；reviewer-codex 出 3 HIGH + 3 MED + 5 LOW + 1 未验证。三态裁决后 R37 R2 真问题清单：1 HIGH (HIGH-1 baton role) + 2 MED (MED-1 codex handoff slice / MED-2 codex timeout scope) 必修；3 个 (HIGH-2/HIGH-3/MED-3) pre-existing 不归 R37 不修留 R3 收口或专门「codex/claude 架构对称」plan；5 LOW + 4 INFO 不阻塞。R2 fix 落地 commit 4ba8d25 (HIGH-1) + 68f7efb (MED-1+MED-2)。新增 4 个回归测试 (3 in tools.test.ts + 1 in hand-off-session test)。typecheck 0 错 / vitest 518/518 全过。
- [ ] **Step 5.2 — R3 收口 review**：P3 完成后跑 R3，验收 final state；双方 ✅ 可合即收口
- [ ] **Step 5.3 — REVIEW_37.md 撰写 + reviews/INDEX.md 加行**：按 reviews/ 模板写完整 review record，引用 R1/R2/R3 全部 finding + 实施 commit 列表
- [ ] **Step 5.4 — CHANGELOG_109+ 撰写 + changelog/INDEX.md 加行**：按 phase 分段记录 LOC/收益/风险
- [ ] **Step 5.5 — archive_plan**：调 `mcp__agent-deck__archive_plan` 自动归档（前置 ExitWorktree(action: "keep")）

## 当前进度

- ✅ EnterWorktree 完成（cwd `/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-and-refactor-r37-20260515`，branch `worktree-deep-review-and-refactor-r37-20260515`）
- ✅ R1 review 完成（reviewer-claude 14 finding + reviewer-codex 13 finding，全员 grep 实证 + 三态裁决，无反驳证伪）
- ✅ Plan 文件创建（本文件）
- ✅ Step 1.1 (D withMcpGuard + subscribe) 完成 — commit bd0be75
- ✅ Step 1.2 (G codex pool) 完成 — commit d421173
- ✅ Step 1.3 (B recoverer messages) 完成 — commit 10d6656
- ✅ Phase 2 trivial (Step 2.1 omitUndefined + 2.2 注释碎片 + 2.3 占位文案) 完成 — commit 342eca7
- ✅ Step 3.1 (F shared mock factory) 完成 — commit e5cc6a5（5 factory + 11 test 迁移 + 504/504 全过）
- ✅ Step 3.2 (H LLM oneshot helper) 完成 — commit 10a0af7（6 helper file + 4 thin wrappers + summarizer/index codex race removed + 504/504 全过）
- ✅ Step 3.3 (I summariseEvents dispatch 下放) 完成 — commit 04f04b4（adapter interface 加 optional 接口 + claude/codex adapter 实装 + caller 端 dispatch 收口 / 504/504 全过 / 行为零变化）
- ✅ Step 3.4 (E codex sdk-bridge 拆 sub-module) 完成 — commit d7c2522（input-pack + session-finalize + restart-controller / index.ts 543 → 409 / 504/504 全过 / 行为零变化）
- ✅ Step 3.5 (M runBatonCleanup helper) 完成 — commit be0d8ef（baton-cleanup.ts 211 LOC + 单测 10 case / archive-plan.ts -68 LOC + hand-off-session.ts -55 LOC / 514/514 全过 / 行为零变化）
- ✅ Step 3.6 (N message-delivery-state) 完成 — commit 2125f64（新文件 208 LOC + repo 496 → 460 -36 / SQL CASE 由 BACKOFF_TIERS 派生消除双源声明 / module load invariant 自检 / 514/514 全过 / 行为零变化）
- ✅ Step 5.1 (R2 复审 + 3 R2 fix) 完成 — commit 4ba8d25 (HIGH-1 baton role) + 68f7efb (MED-1 codex handoff slice + MED-2 codex timeout scope)。R2 双对抗 + 反驳轮 + lead self-verify 三态裁决：reviewer-codex 3 HIGH + 3 MED 中 1 HIGH + 2 MED 真 R37 引入 fix；HIGH-2/HIGH-3/MED-3 pre-existing 不归 R37 留专门 plan；5 LOW + 4 INFO 不阻塞。+ 4 新测试 (tools.test.ts × 3 + hand-off-session × 1) 防 regression。518/518 全过。
- ✅ Step 4.1 (C cwd resolver) 完成 — commit 1886247（utils/cwd-resolver.ts +52 LOC + 6 case 单测 + 3 处 fallback 替换 + 4 处 jsdoc 同步 / 524/524 全过 / 行为零变化 / "   " 全空白边界升级为 process.cwd() fallback）
- ✅ Step 4.2 (C single-flight helper) **不实施** — calibration 后跳过（与 plan 决策 5 「不做 P4 BaseAdapter / F2 scheduler」同款）。R1 估算「6 处单飞」高估 → 真实只有 2 处真 Map<K,Promise>，其中 dedupHandOff 已自洽 13 LOC（抽 helper 反而冗余），recoverer/restart ctx 改造涉及 sub-class state ownership 转换风险 > 1 SSOT 收益。详 Step 4.2 注释。
- ✅ Step 4.3 (C recoverer emit fallback message helper) 完成 — commit bae79d4（recoverer.ts +51 -64 净 -13 LOC / 6 处 emit struct 替换为 emitFallbackMessage 调用 / 与 Step 1.3 builder 1:1 配套 / 524/524 全过 / 行为零变化）
- ✅ Step 4.4 (K preload misc 按域拆) **不实施** — calibration 后跳过（与 Step 4.2 同款）。misc.ts 154 LOC 远未触发 500 LOC 护栏 + invoke<T>() helper Step 1.1 已评估否决（_helpers.ts:8-10 注释 SSOT）。两个子动作 ROI 都低，强行实施违 user CLAUDE.md「don't add abstractions beyond what the task requires」。详 Step 4.4 注释。
- ✅ Step 4.5 (L result type + satisfies 校验) 完成 — commit af4fafc（schemas.ts +134 LOC 7 result type / 8 handler satisfies / 拦下 3 处真实类型漂移 / 524/524 全过 / 行为零变化）
- ✅ Step 4.6 (L IPC errorMode 统一 wrapper) **不实施** — calibration 后跳过（与 4.2/4.4 同款）。60-80 处 IPC handler 现状已合理分两类 errorMode（throw vs result），handler return type 自表达，wrapper 加 errorMode 字段「重复声明」+ 改造大土无 bug 修复。详 Step 4.6 注释。
- ✅ Step 4.7 (J shared category 标签) 完成 — commit 736b24a（5 file 加 jsdoc contract/policy 标签 / ipc-channels.ts 顶部加完整边界约定 SSOT / 零 implementation 改动 / 524/524 全过）
- 🎉 **Phase 4 (P3 散落收口) 全部完成**：4.1 / 4.3 / 4.5 / 4.7 实施 + 4.2 / 4.4 / 4.6 calibration 后跳过。每个跳过都有 plan 详细注释理由，与 plan 决策 5 「不做 P4 BaseAdapter / F2 scheduler」同款。Phase 4 commit chain：1886247 / bae79d4 / af4fafc / 736b24a。
- ⬜ Step 5.2 — R3 收口 review（**下一步**；本会话适合 hand-off 让新 session 接力 Phase 5 收口工作）

## 节点 0 → Phase 4 完成 commit 链

- ffcb663 (base, main HEAD)
- bd0be75 — refactor(api-facade): withMcpGuard + subscribe wrapper 收口 7 handler + 10 onXxx (R37 P1-D)
- d421173 — refactor(codex): codex-instance-pool 收口 oneshot 双 runner 共享 SDK 实例 (R37 P1-G)
- 10d6656 — refactor(recoverer): 抽 6 个 message text builder 纯函数 (R37 P1-B)
- 342eca7 — refactor: omitUndefined helper + 占位文案过期收口 (R37 P1-Phase2 trivial 顺手)
- e5cc6a5 — refactor(tests): 抽 5 类 _shared/mocks/ factory 收口 11 test 文件 (R37 P2-F Step 3.1)
- 10a0af7 — refactor(oneshot-llm): 抽 6 helper 收口 4 LLM oneshot runner (R37 P2-H Step 3.2)
- 04f04b4 — refactor(adapter): summariseEvents dispatch 下放 (R37 P2-I Step 3.3)
- d7c2522 — refactor(codex-bridge): 拆 input-pack/session-finalize/restart-controller (R37 P2-E Step 3.4)
- be0d8ef — refactor(baton-cleanup): 抽 runBatonCleanup helper 收口 ~80 行模板 (R37 P2-M Step 3.5)
- 2125f64 — refactor(message-delivery-state): 抽 SSOT + SQL backoff fragment 派生 (R37 P2-N Step 3.6)
- 4ba8d25 — fix(baton): spawn handler batonRole opts + hand-off-session 透传 'lead' (R37 R2 HIGH-1)
- 68f7efb — fix(oneshot-llm): codex handoff 不限长度 + race scope 包整 SDK init (R37 R2 MED-1 + MED-2)
- 1886247 — refactor(cwd-resolver): 抽 resolveSpawnCwd helper 收口 3 处 spawn cwd fallback (R37 P3-C Step 4.1)
- bae79d4 — refactor(recoverer): 抽 emitFallbackMessage 私有方法收口 6 处 emit struct (R37 P3-C Step 4.3)
- af4fafc — refactor(mcp-tools): 加 7 个 result type + 8 处 handler return satisfies (R37 P3-L Step 4.5)
- 736b24a — docs(shared): 加 contract/policy jsdoc 标签明确边界 (R37 P3-J Step 4.7)

## 下一会话第一步

按 user CLAUDE.md cold-start 流程：

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/deep-review-and-refactor-r37-20260515.md` 全文读 plan
2. `EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-and-refactor-r37-20260515")` 进 worktree
3. `git log --oneline -5` 自检 HEAD = 736b24a 或之后
4. **Phase 5 收口工作清单**（按 plan「步骤 checklist」继续）：
    - **Step 5.2 R3 收口 review**：跑 R3 review 验收 P3 fix（参考下方「复用 R37 reviewer mental model」节判断 R3 reviewer 来源）。R3 focus = 「Phase 4 实施的 4 step (4.1/4.3/4.5/4.7) 0 引新 bug + 与 R2 fix + Phase 1-3 fix 整体一致 + 3 个 calibration 跳过 step (4.2/4.4/4.6) 理由是否 reviewer 端也认可」
    - **Step 5.3 REVIEW_37.md 撰写 + reviews/INDEX.md 加行**：按 reviews/ 模板写完整 review record，引用 R1/R2/R3 finding 全部 + 实施 commit 列表
    - **Step 5.4 CHANGELOG_109+ 撰写 + changelog/INDEX.md 加行**：按 phase 分段记录 LOC/收益/风险（含「跳过 step 理由」节，与 plan 注释呼应）
    - **Step 5.5 archive_plan**：调 `mcp__agent-deck__archive_plan` 自动归档（前置 ExitWorktree(action: "keep")）

5. 改完每步跑 `pnpm typecheck` + 影响范围内的 vitest（按 step 选） + 必要时 `pnpm build`；commit message 必须含「(R37 P5 Step 5.X)」标记
6. 进度变更先告诉用户征得确认

## 会话风格授权（autonomous mode）

**用户 2026-05-15 明示授权**：「继续，你一路推进吧，hand off 时机自己把握。上面在所有会话都保持，hand off 时一路传下去。」

**含义**：
- **连续推进**：lead 不需为每一步切换 / 决策征求用户确认；按 plan checklist 顺序自主推进，遇真歧义（plan 决策外的二选一）才停下问用户
- **lead 自主决定 hand-off 时机**：不预设固定 phase 边界，按 user CLAUDE.md §Step 2.5 触发信号（独立 phase 边界 / context 60%+ / 用户语义信号）综合判断；触发后调 `hand_off_session(plan_id, phase_label)` 自动起新 session + archive caller
- **指令一路传下去**：本节是接力会话风格 SSOT，每个新 session cold-start 读完 plan 即知本节 → 继续 autonomous 不重新问；hand-off 时不必另传指令（plan 文件本身就是载体）
- **本节不动**：除非用户明示撤回授权，新 session 不删 / 不改本节

**触发用户介入的真歧义清单**（仅这些情况停下问用户）：
- plan 设计决策外的二选一（如「这个改动应该归 P2 还是 P4」）
- 测试失败疑似真 bug 而非平移引起的预期 diff（不是「mock 没设置」这种 trivial）
- 真不能拆的 ≥ 500 LOC 文件该不该写「不动文件保护清单」边界拿不准
- 用户对话中显式新指令（中断 autonomous 切回 user-driven）
- 安全 / 数据可逆性高风险操作（git push --force / DROP TABLE / 删 worktree 等不可逆动作前 — 即使 plan 里规划了也要确认）

## 复用 R37 reviewer mental model（重要）

⚠️ **R37 R1 reviewer 已被 auto-shutdown**（hand_off_session default keep_teammates=false 失误）：

- reviewer-claude · macro: `9b3664c0-e706-4a3d-9d2b-ff2ad2bb5ccd` — closed
- reviewer-codex · macro: `065de55e-7cf4-4fa1-b051-13c43384c2dd` — closed
- team `deep-review-37-macro` (id `726be1e0-cb71-420e-9c65-422c502aa87a`) — 可能因 0-lead 自动 archived

✅ **R37 R2 reviewer 仍 active / dormant**（本会话 Step 5.1 spawn，hand_off_session 时未 shutdown）：

- reviewer-claude · r2: `5cceabec-943b-43b4-99c4-48d06852b599` — active or dormant
- reviewer-codex · r2: `1e961eca-1432-43cf-9f31-1c3fbd9061fe` — active or dormant
- team `deep-review-37-macro-r2` (id `98f3a76f-01a8-4db9-925e-300c5e6751fb`) — active

**R3 review 复用 R2 reviewer mental model 流程**（推荐 — 避免 R1 的失误）：
1. 新 lead session cold-start 后调 `list_sessions(spawned_by_filter:'<old caller_session_id>', status_filter:'active')` 拉旧 caller spawn 出的 R2 reviewer（`5cceabec` + `1e961eca`）
2. **新 caller 必须先加入 team** `deep-review-37-macro-r2` (id `98f3a76f-01a8-4db9-925e-300c5e6751fb`)，否则 send_message 报 no-shared-team — 通过 hand_off_session 显式传 `team_name: 'deep-review-37-macro-r2'` 让新 session 直接落入 team（**或** 应用 UI Team 面板 → Add Member 手动加入）
3. R3 init prompt 必带 `skip` = R2 已 fix 的 finding 摘要 + R2 已确认 pre-existing 不修的 finding（避免重复列）
4. R3 focus = 「R2 fix 是否对症 + P3 (Phase 4) 7 step 是否引入新问题 + 整体收口验收」

**R1 finding 数据完整保留**（shutdown 不删 events / messages 子表）：可通过 SessionDetail UI 查看 R1 reviewer 历史 reply / 通过 list_sessions(spawned_by_filter) 反查 closed reviewer 拉 messages。R2 reviewer 同款持久。

**何时跑 R3**：plan「Step 5.2」位置（P3 完成后），focus = R2 fix 复审 + P3 收尾验收。

**HIGH-1 baton role fix 关键意义**：本 plan 通过 hand_off_session(team_name='X') 接力时，4ba8d25 后新 session 已能以 lead 角色加入 team（不再触发 0-lead auto-archive）— 即将开始的 hand-off (本会话 → 下一会话) 是该 fix 的首个生产验证。

⚠️ **已知约束（fix 未部署到运行 app 之前）**：本会话 hand-off 时**不传 team_name**，因为 4ba8d25 fix 在 worktree 内但**运行的 Agent Deck app 仍是老版本**（fix 部署需 `pnpm dist` + 重装 .app，详项目 CLAUDE.md §打包与本地安装）。新 session cold-start 后想跑 R3 复用 R2 reviewer mental model 的 3 个选项：
1. **手动 UI 加入 team**：UI Header → Team `deep-review-37-macro-r2` 面板 → Add Member（把新 session sid 加为 lead），然后 send_message R2 reviewer
2. **spawn 全新 R3 reviewer 对**：team_name 用 `deep-review-37-macro-r3`（避免与 R2 team 冲突），R3 reviewer 不复用 R2 mental model 但 R2 finding 摘要可写进 init prompt 当 skip 字段
3. **等 app 部署后再 hand-off**：用户跑 `pnpm dist` + 重装 .app，新一轮 hand-off 自动走 fix 后行为（新 session 以 lead 加入 team 不触发 auto-archive）— 推荐但需用户手动操作

新 session 综合判断 + 与用户确认后选最适方案。

## 已知踩坑（看历史 + 本 plan 实施时已意识到）

- **不能默认沉默忽略「真不能拆」的文件**：本 plan 的 P3 P4 都要触发护栏 → 真不能拆要写到对应 CHANGELOG 「不动文件保护清单」+ 注明理由（详项目 CLAUDE.md §单文件 ≤ 500 行护栏 节）
- **archive_plan 前置必须先 ExitWorktree**：CLI 内部 tool 限制
- **base_branch 是 main**（本 plan 切 worktree 时主仓库 HEAD 在 main），ff-merge 时直接合 main
- **shared/ 改动属高风险**（renderer + main + preload 三端共享）：J Step 4.7 必须先验证 jsdoc 加标签不破坏现有 import
- **shared mock factory（F Step 3.1）改造期间禁止 typecheck 漂移**：每迁一个 test 文件就跑该文件的 vitest 验证，不要批量改后再跑
- **dormant ≠ 丢 mental model**：R37 reviewer 在 P1 完成等 R2 期间会被 lifecycle scheduler 转 dormant；下次 send_message 自动 SDK resume 复原对话历史。**唯一例外**：jsonl 缺失走 hard fail fallback → reviewer 触发 ⚠ FRESH SESSION warn 必须重 spawn 重发 R1 init prompt 全量重跑。复用机制信赖度高但不绝对（详应用 CLAUDE.md §dormant 节）
